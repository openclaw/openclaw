import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  loadSessionEntry,
  onSessionIdentityMutation,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import {
  projectPublicSessionEntry,
  projectPublicSessionEntryPatch,
} from "./session-entry-projection.js";
import type { InternalSessionEntry } from "./types.js";

const tempDirs = createTempDirTracker();
function createScope(name: string) {
  return {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make(`session-${name}-`)) },
    sessionKey: `agent:main:${name}`,
  };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("SQLite session row persistence", () => {
  it("bounds saved-prompt decoding while publishing identity changes", async () => {
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("session-identity-decode-")),
    };
    const sessionKey = "agent:main:identity-decode";
    const scope = { agentId: "main", env, sessionKey };
    const skillsSnapshot = {
      prompt: "identity-decode-payload:" + "x".repeat(16_384),
      skills: [],
    };
    await upsertSessionEntryCore(scope, { sessionId: "initial", updatedAt: 1, skillsSnapshot });
    const identities: string[] = [];
    const unsubscribe = onSessionIdentityMutation((mutation) => {
      if (
        mutation.kind !== "delete" &&
        mutation.current.sessionKeys.includes(sessionKey) &&
        mutation.current.sessionId
      ) {
        identities.push(mutation.current.sessionId);
      }
    });
    const parse = vi.spyOn(JSON, "parse");
    const iterations = 10;
    try {
      for (let index = 0; index < iterations; index++) {
        const sessionId = `generation-${Math.floor(index / 2)}`;
        const update = () => ({ sessionId, updatedAt: index + 2 });
        const result = await patchSessionEntryCore(scope, update, { skipMaintenance: true });
        expect(result).toMatchObject({ sessionId, skillsSnapshot });
      }
      const decodes = parse.mock.calls.filter(([text]) =>
        text.includes("identity-decode-payload:"),
      ).length;
      // One decode per patch: preparation owns the only hydration of the row; the commit
      // revalidates the persisted row without decoding and the writer reuses that row.
      expect(decodes).toBeLessThanOrEqual(iterations);
    } finally {
      parse.mockRestore();
      unsubscribe();
    }
    expect(identities).toEqual(Array.from({ length: 5 }, (_, index) => `generation-${index}`));
    expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "generation-4", skillsSnapshot });
  });

  it("records committed owner facts before cancellation observers", async () => {
    const scope = createScope("commit-fact");
    const skillsSnapshot = {
      prompt: "Prepared session skills.",
      skills: [{ name: "existing", requiredEnv: ["EXISTING_ENV"] }],
    };
    await upsertSessionEntryCore(scope, {
      sessionId: "predecessor",
      updatedAt: 10,
      skillsSnapshot,
    });
    const controller = new AbortController();
    const cancelled = new Error("cancelled after identity publication");
    const facts: InternalSessionEntry[] = [];
    const observed: Array<{ acceptedId?: string; persistedId?: string }> = [];
    const unsubscribe = onSessionIdentityMutation((mutation) => {
      if (mutation.previous.sessionId !== "predecessor") {
        return;
      }
      observed.push({
        acceptedId: facts.at(-1)?.sessionId,
        persistedId: loadSessionEntry(scope)?.sessionId,
      });
      controller.abort(cancelled);
    });
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      const result = await patchSessionEntryCore(scope, () => ({ sessionId: "successor" }), {
        onCommitted: (entry) => {
          facts.push(entry);
        },
      });
      expect(facts).toHaveLength(1);
      expect(observed).toEqual([{ acceptedId: "successor", persistedId: "successor" }]);
      expect(controller.signal.reason).toBe(cancelled);
      expect(
        clone.mock.calls.filter(
          ([entry]) =>
            isRecord(entry) &&
            (entry.sessionId === "predecessor" || entry.sessionId === "successor"),
        ).length,
      ).toBeLessThanOrEqual(3);
      const retainedSkills = facts[0]?.skillsSnapshot?.skills;
      expect(retainedSkills).toEqual(skillsSnapshot.skills);
      retainedSkills?.push({ name: "observer-only" });
      expect(result?.skillsSnapshot).toEqual(skillsSnapshot);
      expect(loadSessionEntry(scope)?.skillsSnapshot).toEqual(skillsSnapshot);
    } finally {
      clone.mockRestore();
      unsubscribe();
    }
  });

  it.each(["during", "after"] as const)(
    "isolates the existing-entry context when first read %s the update",
    async (readTiming) => {
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("session-context-copy-")),
      };
      const scope = { agentId: "main", env, sessionKey: "agent:main:context-copy" };
      const skillsSnapshot = { prompt: "Saved prompt", skills: [] };
      replaceSessionEntrySync(scope, { sessionId: "existing", updatedAt: 1, skillsSnapshot });
      let readContext: () => InternalSessionEntry | undefined = () => undefined;
      const result = await patchSessionEntryCore(
        scope,
        (entry, context) => {
          readContext = () => context.existingEntry;
          entry.skillsSnapshot!.prompt = "Callback mutation";
          if (readTiming === "during") {
            expect(readContext()?.skillsSnapshot).toEqual(skillsSnapshot);
          }
          return null;
        },
        { skipMaintenance: true },
      );
      result!.skillsSnapshot!.prompt = "Result mutation";
      const contextEntry = readContext()!;
      expect(contextEntry.skillsSnapshot).toEqual(skillsSnapshot);
      contextEntry.skillsSnapshot!.prompt = "Context mutation";
      expect(readContext()).toBe(contextEntry);
      expect(result?.skillsSnapshot?.prompt).toBe("Result mutation");
      expect(loadSessionEntry(scope)?.skillsSnapshot).toEqual(skillsSnapshot);
    },
  );

  it("protects required profile provenance during replacement", async () => {
    const scope = createScope("stamp");
    const stamp = {
      createdVia: "operator" as const,
      createdActor: { type: "human" as const, source: "profile" as const, id: "profile-creator" },
      createdAt: 10,
      sandbox: "required" as const,
    };
    await upsertSessionEntryCore(scope, { sessionId: "original", updatedAt: 10, ...stamp });
    const replacement: InternalSessionEntry = {
      sessionId: "replacement",
      updatedAt: 20,
      createdVia: "plugin",
      createdActor: { type: "agent", id: "replacement-agent" },
      createdAt: 20,
    };
    expect(
      await patchSessionEntryCore(scope, () => replacement, { replaceEntry: true }),
    ).toMatchObject(stamp);
    expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "replacement", ...stamp });
    const row = openOpenClawAgentDatabase(scope)
      .db.prepare(
        "SELECT created_actor_type, created_actor_id, created_via, created_at, entry_json FROM session_nodes WHERE session_key = ?",
      )
      .get(scope.sessionKey);
    expect(row).toMatchObject({
      created_actor_type: "human",
      created_actor_id: "profile-creator",
      created_via: "operator",
      created_at: 10,
    });
    expect(JSON.parse(String(row?.entry_json))).toMatchObject(stamp);
  });

  it("keeps new required provenance with a fallback", async () => {
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("session-stamp-fallback-")),
    };
    const scope = { agentId: "main", env, sessionKey: "agent:main:fallback" };
    const stamp = {
      createdVia: "operator" as const,
      createdActor: { type: "human" as const, source: "profile" as const, id: "profile-creator" },
      createdAt: 20,
      sandbox: "required" as const,
    };
    const result = await patchSessionEntryCore(scope, () => stamp, {
      fallbackEntry: { sessionId: "fallback", updatedAt: 10 },
      preserveActivity: true,
    });
    expect(result).toMatchObject({ sessionId: "fallback", ...stamp });
    expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "fallback", ...stamp });
  });

  it("does not mint creator authority when replacing an unstamped node", async () => {
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("session-unstamped-")),
    };
    const scope = { agentId: "main", env, sessionKey: "agent:main:unstamped" };
    await upsertSessionEntryCore(scope, {
      sessionId: "original",
      updatedAt: 10,
      createdVia: "operator",
      label: "removed",
    });
    await patchSessionEntryCore(
      scope,
      () => ({
        sessionId: "replacement",
        updatedAt: 20,
        createdVia: "operator",
        createdActor: { type: "human", source: "profile", id: "new-profile" },
      }),
      { replaceEntry: true },
    );
    const persisted = loadSessionEntry(scope);
    expect(persisted).toMatchObject({ sessionId: "replacement", createdVia: "operator" });
    expect(persisted?.createdActor).toBeUndefined();
    expect(persisted).not.toHaveProperty("sandbox");
    expect(persisted).not.toHaveProperty("label");
  });

  it("persists private workspace intent but excludes runtime-only resolved skills from SQLite JSON", async () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-sqlite-session-skills-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:runtime-skills";
    const resolvedSkills = [
      createCanonicalFixtureSkill({
        name: "demo",
        description: "runtime-only skill",
        filePath: "/skills/demo/SKILL.md",
        baseDir: "/skills/demo",
        source: "# Demo\n\n" + "runtime skill content ".repeat(100),
      }),
    ];
    const entry: InternalSessionEntry = {
      sessionId: "runtime-skills-session",
      updatedAt: 42,
      pendingProjectGitUrl: "https://github.com/openclaw/openclaw.git",
      pendingWorktree: {
        name: "session-startup",
        titleSource: "Start work",
      },
      skillsSnapshot: {
        prompt: "compact skill prompt",
        skills: [{ name: "demo" }],
        skillFilter: ["demo"],
        resolvedSkills,
        version: 7,
      },
    };

    await upsertSessionEntryCore({ agentId: "main", env, sessionKey }, entry);

    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const row = database.db
      .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
      .get(sessionKey) as { entry_json: string };
    const persisted = JSON.parse(row.entry_json) as InternalSessionEntry;
    for (const key of ["pendingProjectGitUrl", "pendingWorktree"] as const) {
      expect(persisted[key]).toEqual(entry[key]);
      expect(loadSessionEntry({ agentId: "main", env, sessionKey })?.[key]).toEqual(entry[key]);
      expect(projectPublicSessionEntry(entry)).not.toHaveProperty(key);
      expect(projectPublicSessionEntryPatch(entry)).not.toHaveProperty(key);
    }
    expect(persisted.skillsSnapshot).toEqual({
      prompt: "compact skill prompt",
      skills: [{ name: "demo" }],
      skillFilter: ["demo"],
      version: 7,
    });
    expect(entry.skillsSnapshot?.resolvedSkills).toBe(resolvedSkills);
  });
});
