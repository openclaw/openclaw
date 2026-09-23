import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareEmbeddedSkills } from "../../agents/embedded-agent-runner/skill-runtime.js";
import { createReplySessionEntryHandle } from "../../auto-reply/reply/session-entry-handle.js";
import { ensureSkillSnapshot } from "../../auto-reply/reply/session-updates.js";
import {
  appendTranscriptMessage,
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db-cache.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { SkillSnapshot } from "../types.js";
import { bumpSkillsSnapshotVersion, getSkillsSnapshotVersion } from "./refresh-state.js";
import { resolveReusableWorkspaceSkillSnapshot } from "./session-snapshot.js";

const temps = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const root = temps.make("openclaw-async-skills-");
  const workspaceDir = path.join(root, "workspace");
  for (const [key, value] of Object.entries({
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_BUNDLED_SKILLS_DIR: path.join(root, "bundled-skills"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled-plugins"),
    PATH: path.join(root, "bin"),
  })) {
    vi.stubEnv(key, value);
  }
  await writeSkill({
    dir: path.join(workspaceDir, "skills", "probe"),
    name: "probe",
    description: "Requires a local tool",
    metadata: '{"openclaw":{"requires":{"bins":["fixture-missing-tool"]}}}',
  });
  const visibleFile = path.join(workspaceDir, "skills", "visible", "SKILL.md");
  await writeSkill({
    dir: path.dirname(visibleFile),
    name: "visible",
    description: "Original instructions",
  });
  const config: OpenClawConfig = { plugins: { enabled: false } };
  return { workspaceDir, visibleFile, config, watch: false as const };
}

describe("asynchronous runtime skill preparation", () => {
  it("upgrades a saved release format-5 snapshot on continuation without replacing its session or history", async () => {
    const params = await fixture();
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    params.config.skills = { load: { watch: false } };
    params.config.tools = { exec: { security: "deny" } };
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:release-upgrade",
      sessionId: "saved-release-session",
      storePath: path.join(
        path.dirname(params.workspaceDir),
        "state",
        "agents",
        "main",
        "openclaw-agent.sqlite",
      ),
    };
    // Release 29afcd49 persists format 5 with these fields. Its SQLite session
    // owner/schema is unchanged by this backport; only the prompt format advances.
    const savedSnapshot: SkillSnapshot = {
      prompt: [
        "\n\nThe following skills provide specialized instructions for specific tasks.",
        "Read a skill's file at its listed location when the task matches its description.",
        "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
        "",
        "<available_skills>",
        "  <skill>",
        "    <name>visible</name>",
        "    <description>Release-format instructions</description>",
        `    <location>${params.visibleFile}</location>`,
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
      skills: [{ name: "visible", skillKey: "visible" }],
      skillFilter: ["visible"],
      skillOverrides: { visible: true },
      nodeSkillsEligibility: { canExec: false },
      // Keep every other invalidation input current so the format change must
      // refresh this persisted snapshot even before a watcher sees a change.
      version: getSkillsSnapshotVersion(params.workspaceDir),
      promptFormatVersion: 5,
    };
    const saved: SessionEntry = {
      sessionId: scope.sessionId,
      lifecycleRevision: "saved-release-lifecycle",
      updatedAt: 1,
      systemSent: true,
      label: "Existing conversation",
      compactionCount: 2,
      skillsSnapshot: savedSnapshot,
    };
    replaceSessionEntrySync(scope, saved);
    await appendTranscriptMessage(scope, {
      message: { role: "user", content: "Keep this existing conversation", timestamp: 1 },
    });
    const history = JSON.stringify(loadTranscriptEventsSync(scope));
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const sessionEntry = expectDefined(loadSessionEntry(scope), "saved release session");
    expect(sessionEntry.skillsSnapshot).toEqual(saved.skillsSnapshot);
    const sessionStore = { [scope.sessionKey]: sessionEntry };
    const result = await ensureSkillSnapshot({
      ...scope,
      sessionEntry,
      sessionStore,
      isFirstTurnInSession: false,
      workspaceDir: params.workspaceDir,
      cfg: params.config,
      skillFilter: ["visible"],
      skillOverrides: { visible: true },
    });
    expect(result.skillsSnapshot).toMatchObject({
      promptFormatVersion: 6,
      skills: [{ name: "visible", skillKey: "visible" }],
      skillFilter: ["visible"],
      skillOverrides: { visible: true },
    });
    expect(result.skillsSnapshot?.prompt).toContain("Original instructions");
    expect(result.skillsSnapshot?.prompt).not.toContain("Release-format instructions");
    expect(result.skillsSnapshot?.resolvedSkills?.[0]?.filePath).toBe(params.visibleFile);
    expect(result.systemSent).toBe(true);
    closeOpenClawAgentDatabasesForTest();
    const reopened = expectDefined(loadSessionEntry(scope), "upgraded release session");
    expect(reopened).toMatchObject({
      sessionId: saved.sessionId,
      lifecycleRevision: saved.lifecycleRevision,
      systemSent: true,
      label: saved.label,
      compactionCount: 2,
      skillsSnapshot: {
        promptFormatVersion: 6,
        prompt: result.skillsSnapshot?.prompt,
        skillFilter: ["visible"],
        skillOverrides: { visible: true },
      },
    });
    expect(JSON.stringify(loadTranscriptEventsSync(scope))).toBe(history);
  });

  const replyCases = (
    [
      [true, true, false],
      [true, false, false],
      [false, true, false],
      [false, false, false],
      [false, true, true],
      [false, false, true],
    ] as const
  ).map(([isFirstTurnInSession, useHandle, warm]) => ({ isFirstTurnInSession, useHandle, warm }));

  it.each(replyCases)(
    "preserves concurrent reply state (first turn $isFirstTurnInSession, handle $useHandle, warm $warm)",
    async ({ isFirstTurnInSession, useHandle, warm }) => {
      const params = await fixture();
      vi.stubEnv("OPENCLAW_TEST_FAST", "0");
      params.config.skills = { load: { watch: false } };
      const sessionKey = "agent:main:main";
      let sessionEntry: SessionEntry = {
        sessionId: "original",
        updatedAt: 1,
        label: "Before",
        pinnedAt: 1,
      };
      const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
      const sessionEntryHandle = useHandle
        ? createReplySessionEntryHandle({ sessionEntry, sessionStore, sessionKey })
        : undefined;
      const prepare = () =>
        ensureSkillSnapshot({
          agentId: "main",
          sessionEntry,
          sessionStore,
          sessionEntryHandle,
          sessionKey,
          isFirstTurnInSession,
          workspaceDir: params.workspaceDir,
          cfg: params.config,
        });
      if (warm) {
        await prepare();
        sessionEntry = expectDefined(sessionStore[sessionKey], "prepared warm session entry");
      }
      const pending = prepare();
      const concurrent: SessionEntry = {
        ...sessionEntry,
        sessionId: "original",
        updatedAt: 2,
        label: "After",
        sendPolicy: "deny",
      };
      delete concurrent.pinnedAt;
      if (sessionEntryHandle) {
        sessionEntryHandle.replaceCurrent(concurrent);
      } else {
        sessionStore[sessionKey] = concurrent;
      }
      const result = await pending;
      expect(result.sessionEntry).toMatchObject({
        label: "After",
        sendPolicy: "deny",
        sessionId: "original",
      });
      expect(result.sessionEntry?.pinnedAt).toBeUndefined();
      expect(result.sessionEntry?.skillsSnapshot?.prompt).toContain("Original instructions");
      expect(sessionStore[sessionKey]).toBe(result.sessionEntry);
      if (sessionEntryHandle) {
        expect(sessionEntryHandle.getCurrent()).toBe(result.sessionEntry);
      }
    },
  );

  it.each(
    replyCases.flatMap(({ isFirstTurnInSession, useHandle, warm }) =>
      (["replace", "delete", "rotate"] as const).map((action) => ({
        isFirstTurnInSession,
        useHandle,
        warm,
        action,
      })),
    ),
  )(
    "preserves reply generation after $action (first turn $isFirstTurnInSession, handle $useHandle, warm $warm)",
    async ({ action, isFirstTurnInSession, useHandle, warm }) => {
      const params = await fixture();
      vi.stubEnv("OPENCLAW_TEST_FAST", "0");
      params.config.skills = { load: { watch: false } };
      const sessionKey = "agent:main:main";
      let sessionEntry: SessionEntry = {
        sessionId: "original",
        lifecycleRevision: "original-revision",
        updatedAt: 1,
      };
      const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
      const replacement: SessionEntry = {
        sessionId: "replacement",
        lifecycleRevision: "replacement-revision",
        updatedAt: 2,
        skillsSnapshot: { prompt: "Replacement prompt", skills: [] },
      };
      const sessionEntryHandle = useHandle
        ? createReplySessionEntryHandle({ sessionEntry, sessionStore, sessionKey })
        : undefined;
      const prepare = () =>
        ensureSkillSnapshot({
          agentId: "main",
          sessionEntry,
          sessionStore,
          sessionEntryHandle,
          sessionKey,
          isFirstTurnInSession,
          workspaceDir: params.workspaceDir,
          cfg: params.config,
        });
      if (warm) {
        await prepare();
        sessionEntry = expectDefined(sessionStore[sessionKey], "prepared warm session entry");
      }
      const pending = prepare();
      if (action === "replace") {
        sessionStore[sessionKey] = replacement;
      } else if (action === "delete") {
        delete sessionStore[sessionKey];
      } else {
        sessionEntry.lifecycleRevision = "rotated-revision";
        sessionEntry.skillsSnapshot = replacement.skillsSnapshot;
      }
      const result = await pending;
      expect(sessionStore[sessionKey]).toBe(
        action === "replace" ? replacement : action === "rotate" ? sessionEntry : undefined,
      );
      expect(result.sessionEntry).toBe(sessionStore[sessionKey]);
      expect(result.skillsSnapshot).toBe(sessionStore[sessionKey]?.skillsSnapshot);
      expect(result.systemSent).toBe(false);
    },
  );

  it.each(["metadata", "replace", "rotate", "delete"] as const)(
    "reconciles a warm reply with a durable %s while its local row stays stale",
    async (action) => {
      const params = await fixture();
      vi.stubEnv("OPENCLAW_TEST_FAST", "0");
      params.config.skills = { load: { watch: false } };
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: path.join(
          path.dirname(params.workspaceDir),
          "state",
          "agents",
          "main",
          "openclaw-agent.sqlite",
        ),
      };
      let sessionEntry: SessionEntry = {
        sessionId: "original",
        lifecycleRevision: "original-revision",
        updatedAt: 1,
        label: "Before",
        pinnedAt: 1,
      };
      replaceSessionEntrySync(scope, sessionEntry);
      const sessionStore = { [scope.sessionKey]: sessionEntry };
      const sessionEntryHandle = createReplySessionEntryHandle({
        sessionEntry,
        sessionStore,
        sessionKey: scope.sessionKey,
      });
      const prepare = () =>
        ensureSkillSnapshot({
          ...scope,
          sessionEntry,
          sessionStore,
          sessionEntryHandle,
          isFirstTurnInSession: false,
          workspaceDir: params.workspaceDir,
          cfg: params.config,
        });
      await prepare();
      sessionEntry = expectDefined(
        sessionStore[scope.sessionKey],
        "prepared durable warm session entry",
      );
      if (action === "delete") {
        await applySessionEntryLifecycleMutation({
          agentId: scope.agentId,
          storePath: scope.storePath,
          removals: [{ sessionKey: scope.sessionKey }],
          skipMaintenance: true,
        });
      }
      const pending = prepare();
      if (action !== "delete") {
        const concurrent: SessionEntry = {
          ...sessionEntry,
          updatedAt: 2,
          label: "After",
          sendPolicy: "deny",
          ...(action === "replace" ? { sessionId: "replacement" } : {}),
          ...(action === "rotate" ? { lifecycleRevision: "rotated-revision" } : {}),
          ...(action !== "metadata"
            ? { skillsSnapshot: { prompt: "Replacement prompt", skills: [] } }
            : {}),
        };
        delete concurrent.pinnedAt;
        replaceSessionEntrySync(scope, concurrent);
      }
      expect(sessionEntryHandle.getCurrent()).toBe(sessionEntry);
      const authoritative = loadSessionEntry(scope);
      const result = await pending;
      expect(result.sessionEntry).toEqual(authoritative);
      expect(sessionEntryHandle.getCurrent()).toEqual(authoritative);
      expect(sessionStore[scope.sessionKey]).toEqual(authoritative);
      expect(result.skillsSnapshot?.prompt).toBe(authoritative?.skillsSnapshot?.prompt);
      expect(loadSessionEntry(scope)).toEqual(authoritative);
    },
  );

  it("rebuilds changed source bytes and version before publishing an in-flight snapshot", async () => {
    const params = await fixture();
    const requestedVersion = getSkillsSnapshotVersion(params.workspaceDir);
    const pending = Promise.resolve(
      resolveReusableWorkspaceSkillSnapshot({
        ...params,
        snapshotVersion: requestedVersion,
      }),
    );
    fs.writeFileSync(
      params.visibleFile,
      "---\nname: visible\ndescription: Updated instructions\n---\n",
    );
    const currentVersion = bumpSkillsSnapshotVersion({ workspaceDir: params.workspaceDir });

    const result = await pending;
    expect(result.snapshot.prompt).toContain("Updated instructions");
    expect(result.snapshot.prompt).not.toContain("Original instructions");
    expect(result.snapshot.version).toBe(currentVersion);
    expect(result.snapshotVersion).toBe(currentVersion);
    expect((await resolveReusableWorkspaceSkillSnapshot(params)).snapshot).toBe(result.snapshot);
  });

  it("rechecks eligibility after preparation without changing admitted configuration", async () => {
    const params = await fixture();
    let canExec = true;
    const pending = resolveReusableWorkspaceSkillSnapshot({
      ...params,
      resolveEligibility: () => ({ nodeSkills: { canExec } }),
    });
    canExec = false;
    expect((await pending).snapshot.nodeSkillsEligibility).toEqual({ canExec: false });
  });

  it("hydrates runtime paths without rewriting saved fields and reuses the complete snapshot", async () => {
    const params = await fixture();
    const { snapshot } = await resolveReusableWorkspaceSkillSnapshot(params);
    const { resolvedSkills, ...saved } = snapshot;
    saved.prompt = "Saved prompt bytes";
    const before = JSON.stringify(saved);
    Object.freeze(saved);
    const hydrated = (
      await resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: saved })
    ).snapshot;
    const { resolvedSkills: hydratedSkills, ...persisted } = hydrated;
    expect(JSON.stringify(persisted)).toBe(before);
    expect(hydratedSkills).toBe(resolvedSkills);
    expect(hydrated.skills).toBe(saved.skills);
    expect(
      (await resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: hydrated }))
        .snapshot,
    ).toBe(hydrated);
  });

  it("keeps a shared rebuild alive for its remaining caller after another caller aborts", async () => {
    const params = await fixture();
    const controller = new AbortController();
    const reason = new Error("preparation cancelled");
    const first = resolveReusableWorkspaceSkillSnapshot({
      ...params,
      assertCurrent: () => controller.signal.throwIfAborted(),
    });
    const rejected = expect(first).rejects.toBe(reason);
    const second = resolveReusableWorkspaceSkillSnapshot(params);
    controller.abort(reason);

    const result = await second;
    await rejected;
    expect(result.snapshot.prompt).toContain("Original instructions");
    expect((await resolveReusableWorkspaceSkillSnapshot(params)).snapshot).toBe(result.snapshot);
  });

  it("observes abort before applying a skill environment and leaves no override behind", async () => {
    const params = await fixture();
    vi.stubEnv("ASYNC_SKILL_FIXTURE", undefined);
    params.config.skills = { entries: { visible: { env: { ASYNC_SKILL_FIXTURE: "owned" } } } };
    const controller = new AbortController();
    const reason = new Error("attempt cancelled");
    const pending = Promise.resolve(
      prepareEmbeddedSkills({
        attempt: { config: params.config },
        effectiveWorkspace: params.workspaceDir,
        sandbox: null,
        sessionAgentId: "main",
        includeCodeModeSkills: true,
        assertCurrent: () => controller.signal.throwIfAborted(),
      }),
    );
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    try {
      await rejected;
      expect(process.env.ASYNC_SKILL_FIXTURE).toBeUndefined();
    } finally {
      // Also release custody when this regression is run against the original synchronous owner.
      const prepared = await pending.catch(() => undefined);
      prepared?.restoreSkillEnv();
    }
  });
});
