import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFixtureSkillEntry } from "../../skills/test-support/test-helpers.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  loadSessionEntry as readEntry,
  onSessionIdentityMutation as observeIdentity,
  patchSessionEntryCore as patchEntry,
  upsertSessionEntryCore as upsertEntry,
} from "./session-accessor.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { readSessionMaintenanceAgeQueries } from "./session-accessor.sqlite-maintenance-age-queries.js";
import { readReferencedSessionIds } from "./session-accessor.sqlite-references.js";
import {
  projectPublicSessionEntry,
  projectPublicSessionEntryPatch,
} from "./session-entry-projection.js";
import type { InternalSessionEntry } from "./types.js";

const subscriptions: (() => void)[] = [];
function onIdentity(run: Parameters<typeof observeIdentity>[0]) {
  subscriptions.push(observeIdentity(run));
}
let scope: { agentId: string; env: NodeJS.ProcessEnv; sessionKey: string };

function creationStamp(createdAt: number) {
  return {
    createdVia: "operator" as const,
    createdAt,
    sandbox: "required" as const,
    createdActor: { type: "human" as const, source: "profile" as const, id: "profile-creator" },
  };
}

function readRow() {
  return openOpenClawAgentDatabase(scope)
    .db.prepare(
      "SELECT created_actor_type, created_actor_id, created_via, created_at, entry_json FROM session_nodes WHERE session_key = ?",
    )
    .get(scope.sessionKey);
}

async function seed(entry: Partial<InternalSessionEntry>) {
  await upsertEntry(scope, { sessionId: "original", updatedAt: 10, ...entry });
}

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: sessionDirs.make() },
    sessionKey: "agent:main:row",
  };
});

afterEach(() => {
  subscriptions.splice(0).forEach((unsubscribe) => unsubscribe());
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});
const sessionDirs = useSessionStoreTempDirs(afterEach, "session-row-");

it("updates maintenance and retained-reference predicates with the canonical entry", async () => {
  await seed({ sessionId: "current", sessionStartedAt: 5, previousSessionId: "previous" });
  const database = openOpenClawAgentDatabase(scope);
  const startedAt = () =>
    [...readSessionMaintenanceAgeQueries(database.db).activity(undefined)].find(
      (row) => row.session_key === scope.sessionKey,
    )?.session_started_at;
  const references = () => readReferencedSessionIds(database, new Set(), ["previous"]);
  expect(startedAt()).toBe(5);
  expect(references().has("previous")).toBe(true);

  await patchEntry(scope, () => ({ sessionStartedAt: 8, previousSessionId: undefined }), {
    skipMaintenance: true,
  });
  expect(startedAt()).toBe(8);
  expect(references().has("previous")).toBe(false);
});

it("bounds saved-prompt decoding while publishing identity changes", async () => {
  const prompt = "identity-decode-payload:" + "x".repeat(16_384);
  const skillsSnapshot = { prompt, skills: [] };
  await seed({ sessionId: "initial", updatedAt: 1, skillsSnapshot });
  const identities: string[] = [];
  onIdentity((mutation) => {
    if (
      mutation.kind !== "delete" &&
      mutation.current.sessionKeys.includes(scope.sessionKey) &&
      mutation.current.sessionId
    ) {
      identities.push(mutation.current.sessionId);
    }
  });
  const parse = vi.spyOn(JSON, "parse");
  const iterations = 10;
  for (let index = 0; index < iterations; index++) {
    const sessionId = `generation-${Math.floor(index / 2)}`;
    const update = () => ({ sessionId, updatedAt: index + 2 });
    const result = await patchEntry(scope, update, { skipMaintenance: true });
    expect(result).toMatchObject({ sessionId, skillsSnapshot });
  }
  const decodes = parse.mock.calls.filter(([text]) =>
    text.includes("identity-decode-payload:"),
  ).length;
  expect(decodes).toBeLessThanOrEqual(iterations);
  expect(identities).toEqual(Array.from({ length: 5 }, (_, index) => `generation-${index}`));
  expect(readEntry(scope)).toMatchObject({ sessionId: "generation-4", skillsSnapshot });
});

it("records committed owner facts before cancellation observers", async () => {
  const skillsSnapshot = { prompt: "saved", skills: [{ name: "old", requiredEnv: ["KEY"] }] };
  await seed({ sessionId: "predecessor", skillsSnapshot });
  const controller = new AbortController();
  const cancelled = new Error("cancelled after identity publication");
  const facts: InternalSessionEntry[] = [];
  const observed: Array<{ acceptedId?: string; persistedId?: string }> = [];
  onIdentity((mutation) => {
    if (mutation.previous.sessionId !== "predecessor") {
      return;
    }
    observed.push({
      acceptedId: facts.at(-1)?.sessionId,
      persistedId: readEntry(scope)?.sessionId,
    });
    controller.abort(cancelled);
  });
  const result = await patchEntry(scope, () => ({ sessionId: "successor" }), {
    onCommitted: (entry) => facts.push(entry),
  });
  expect(facts.map((entry) => entry.skillsSnapshot)).toEqual([skillsSnapshot]);
  expect(observed).toEqual([{ acceptedId: "successor", persistedId: "successor" }]);
  expect(result?.skillsSnapshot).toEqual(skillsSnapshot);
  result!.skillsSnapshot!.skills.push({ name: "caller-only" });
  expect(readEntry(scope)?.skillsSnapshot).toEqual(skillsSnapshot);
});

it("isolates the existing-entry context when first read during the update", async () => {
  const skillsSnapshot = { prompt: "Saved prompt", skills: [] };
  replaceSessionEntrySync(scope, { sessionId: "existing", updatedAt: 1, skillsSnapshot });
  let readContext: () => InternalSessionEntry | undefined = () => undefined;
  const result = await patchEntry(
    scope,
    (entry, context) => {
      readContext = () => context.existingEntry;
      entry.skillsSnapshot!.prompt = "Callback mutation";
      expect(readContext()?.skillsSnapshot).toEqual(skillsSnapshot);
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
  expect(readEntry(scope)?.skillsSnapshot).toEqual(skillsSnapshot);
});

it("protects required profile provenance and an absent surface during replacement", async () => {
  const stamp = creationStamp(10);
  await seed(stamp);
  const replacement: InternalSessionEntry = {
    sessionId: "replacement",
    updatedAt: 20,
    createdVia: "plugin",
    createdSurface: "plugin-dock",
    createdAt: 20,
    createdActor: { type: "agent", id: "replacement-agent" },
  };
  expect(await patchEntry(scope, () => replacement, { replaceEntry: true })).toMatchObject(stamp);
  expect(readEntry(scope)).toMatchObject({ sessionId: "replacement", ...stamp });
  expect(readEntry(scope)?.createdSurface).toBeUndefined();
  const row = readRow();
  expect(row).toMatchObject({
    created_actor_type: "human",
    created_actor_id: "profile-creator",
    created_via: "operator",
    created_at: 10,
  });
  const persisted = JSON.parse(String(row?.entry_json));
  expect(persisted).toMatchObject(stamp);
  expect(persisted.createdSurface).toBeUndefined();
});

it("keeps new required provenance with a fallback", async () => {
  const stamp = creationStamp(20);
  const result = await patchEntry(scope, () => stamp, {
    fallbackEntry: { sessionId: "fallback", updatedAt: 10 },
    preserveActivity: true,
  });
  expect(result).toMatchObject({ sessionId: "fallback", ...stamp });
  expect(readEntry(scope)).toMatchObject({ sessionId: "fallback", ...stamp });
});

it("does not mint creator authority when replacing an unstamped node", async () => {
  await seed({ createdVia: "operator", label: "removed" });
  await patchEntry(
    scope,
    () => ({
      sessionId: "replacement",
      updatedAt: 20,
      createdVia: "operator",
      createdActor: { type: "human", source: "profile", id: "new-profile" },
      createdSurface: "plugin-dock",
    }),
    { replaceEntry: true },
  );
  const persisted = readEntry(scope);
  expect(persisted).toMatchObject({ sessionId: "replacement", createdVia: "operator" });
  expect(persisted?.createdActor).toBeUndefined();
  expect(persisted?.createdSurface).toBeUndefined();
  expect(persisted).not.toHaveProperty("sandbox");
  expect(persisted).not.toHaveProperty("label");
});

it("persists private source and workspace facts but excludes runtime-only resolved skills from SQLite JSON", async () => {
  const resolvedSkills = [createFixtureSkillEntry("demo").skill];
  const savedSkills = {
    prompt: "saved",
    skills: [{ name: "demo" }],
    skillFilter: ["demo"],
    version: 7,
  };
  const entry: InternalSessionEntry = {
    sessionId: "runtime-skills-session",
    updatedAt: 42,
    pendingProjectGitUrl: "https://github.com/openclaw/openclaw.git",
    pendingWorktree: { name: "session-startup", titleSource: "Start work" },
    titleRefinement: {
      sessionId: "runtime-skills-session",
      generatedName: "Start work",
      remainingMessages: 6,
    },
    restartRecoveryRequesterSource: {
      agentId: "main",
      sessionKey: scope.sessionKey,
      sessionId: "runtime-skills-session",
      sourceRunId: "original-run",
      requesterOrigin: { sessionKey: scope.sessionKey, operatorProfileId: "original-requester" },
    },
    skillsSnapshot: { ...savedSkills, resolvedSkills, discoverySkills: resolvedSkills },
  };

  await upsertEntry(scope, entry);
  const persisted = JSON.parse(String(readRow()?.entry_json)) as InternalSessionEntry;
  for (const key of [
    "pendingProjectGitUrl",
    "pendingWorktree",
    "titleRefinement",
    "restartRecoveryRequesterSource",
  ] as const) {
    expect(persisted[key]).toEqual(entry[key]);
    expect(readEntry(scope)?.[key]).toEqual(entry[key]);
    expect(projectPublicSessionEntry(entry)).not.toHaveProperty(key);
    expect(projectPublicSessionEntryPatch(entry)).not.toHaveProperty(key);
  }
  expect(persisted.skillsSnapshot).toBeUndefined();
  expect(readEntry(scope)?.skillsSnapshot).toEqual(savedSkills);
  expect(entry.skillsSnapshot?.resolvedSkills).toBe(resolvedSkills);
  expect(entry.skillsSnapshot?.discoverySkills).toBe(resolvedSkills);
});
