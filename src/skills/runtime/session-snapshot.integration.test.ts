import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareEmbeddedSkills } from "../../agents/embedded-agent-runner/skill-runtime.js";
import { prepareInstalledSkillCatalog } from "../../agents/installed-skill-runtime.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { createReplySessionEntryHandle } from "../../auto-reply/reply/session-entry-handle.js";
import { ensureSkillSnapshot } from "../../auto-reply/reply/session-updates.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { stripRuntimeOnlySessionSkillsFields } from "../../config/sessions/store-entry-shape.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createSkillEntry } from "../loading/skill-entry-metadata.js";
import { loadSkillRootRecords } from "../loading/skill-root-loader.js";
import * as workspaceSkillLoader from "../loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../loading/workspace-skill-prompt.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { bumpSkillsSnapshotVersion, getSkillsSnapshotVersion } from "./refresh-state.js";
import {
  recordRemoteSkillNodeInfo,
  removeRemoteNodeSkills,
  replaceRemoteNodeSkills,
} from "./remote-skills.js";
import { resolveReusableWorkspaceSkillSnapshot } from "./session-snapshot.js";

const temps = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      // Reclamation workers retain the original shared database until lease cleanup settles.
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      await closeStateDatabaseForTest();
      cleanup();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  }),
);

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
  it.each([
    { name: "deploy", savedName: "deploy", reservedName: undefined },
    { name: "probe", savedName: "snapshot-node-probe", reservedName: undefined },
    { name: "probe", savedName: "snapshot-node-probe-2", reservedName: "snapshot-node-probe" },
  ])(
    "retains node implementation $savedName when a local provider becomes eligible",
    async ({ name, savedName, reservedName }) => {
      const params = await fixture();
      if (reservedName) {
        await writeSkill({
          dir: path.join(params.workspaceDir, "skills", reservedName),
          name: reservedName,
          description: "Unavailable local provider",
          metadata: '{"openclaw":{"requires":{"bins":["fixture-missing-tool"]}}}',
        });
      }
      const nodeId = "snapshot-node";
      const eligibility = { nodeSkills: { canExec: true } };
      onTestFinished(() => removeRemoteNodeSkills(nodeId));
      onTestFinished(
        registerAgentWorkspaceAccess(params.workspaceDir, {
          bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
          loadSkills: async (request) => workspaceSkillLoader.readWorkspaceSkillSources(request),
        }),
      );
      recordRemoteSkillNodeInfo({ nodeId, commands: ["system.run"] });
      replaceRemoteNodeSkills({
        nodeId,
        skills: [
          {
            name,
            description: "Node deployment",
            content: `---\nname: ${name}\ndescription: Node deployment\n---\nNode instructions`,
          },
        ],
      });
      const { snapshot: original } = await resolveReusableWorkspaceSkillSnapshot({
        ...params,
        eligibility,
      });
      const saved = stripRuntimeOnlySessionSkillsFields({
        sessionId: "node-session",
        updatedAt: 1,
        skillsSnapshot: original,
      }).skillsSnapshot;
      const localDir = path.join(params.workspaceDir, "skills", name);
      await writeSkill({ dir: localDir, name, description: "Local deployment" });

      const { snapshot: fresh } = await resolveReusableWorkspaceSkillSnapshot({
        ...params,
        eligibility,
      });
      const { snapshot: hydrated } = await resolveReusableWorkspaceSkillSnapshot({
        ...params,
        eligibility,
        existingSnapshot: expectDefined(saved, "persisted node snapshot"),
      });
      expect(hydrated.prompt).toBe(original.prompt);
      expect(hydrated.resolvedSkills).toEqual(original.resolvedSkills);
      expect(hydrated.discoverySkills).toEqual(original.discoverySkills);
      const catalog = (snapshot: typeof original) =>
        prepareInstalledSkillCatalog({ snapshot, workspaceDir: params.workspaceDir });
      expect(catalog(hydrated).find((skill) => skill.name === savedName)?.source.filePath).toBe(
        `node://snapshot-node/skills/${name}/SKILL.md`,
      );
      expect(catalog(fresh).find((skill) => skill.name === name)?.source.filePath).toBe(
        path.join(localDir, "SKILL.md"),
      );
      expect(
        catalog(fresh).find(
          (skill) => skill.name === (reservedName ? savedName : `snapshot-node-${name}`),
        )?.source.filePath,
      ).toBe(`node://snapshot-node/skills/${name}/SKILL.md`);
    },
  );

  it.each([
    { maxSkillsInPrompt: 1, retained: true, remote: false },
    { maxSkillsInPrompt: 2, retained: true, remote: false },
    { maxSkillsInPrompt: 1, retained: false, remote: false },
    { maxSkillsInPrompt: 2, retained: false, remote: false },
    { maxSkillsInPrompt: 1, retained: false, remote: true },
    { maxSkillsInPrompt: 2, retained: false, remote: true },
  ])(
    "keeps the saved implementation when a same-name provider becomes eligible ($maxSkillsInPrompt, retained=$retained, remote=$remote)",
    async ({ maxSkillsInPrompt, retained, remote }) => {
      const params = await fixture();
      params.config.skills = { load: { watch: false }, limits: { maxSkillsInPrompt } };
      const alternateRoot = path.join(params.workspaceDir, ".agents", "skills");
      await writeSkill({
        dir: path.join(alternateRoot, "probe"),
        name: "probe",
        description: "Original provider",
        body: "Original implementation",
      });
      await writeSkill({
        dir: path.join(alternateRoot, "alpha"),
        name: "alpha",
        description: "Always available",
      });
      const originalEntries = loadSkillRootRecords({
        dir: alternateRoot,
        source: "agents-skills-project",
      }).map(createSkillEntry);
      if (remote) {
        for (const entry of originalEntries) {
          entry.skill.fileHost = "workspace";
        }
        onTestFinished(
          registerAgentWorkspaceAccess(params.workspaceDir, {
            bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
            loadSkills: async (request) => workspaceSkillLoader.readWorkspaceSkillSources(request),
          }),
        );
      }
      const binDir = path.join(path.dirname(params.workspaceDir), "bin");
      fs.mkdirSync(binDir);
      const binary = path.join(binDir, "fixture-missing-tool");
      const resolveEntries = workspaceSkillLoader.resolveWorkspaceSkillPromptEntries;
      const selection = vi
        .spyOn(workspaceSkillLoader, "resolveWorkspaceSkillPromptEntries")
        .mockImplementationOnce((workspaceDir, options) =>
          resolveEntries(workspaceDir, {
            ...options,
            entries: originalEntries,
          }),
        );
      const original = retained
        ? (await resolveReusableWorkspaceSkillSnapshot(params)).snapshot
        : await buildSkillSnapshot(params.workspaceDir, {
            config: params.config,
            snapshotVersion: getSkillsSnapshotVersion(params.workspaceDir),
          });
      selection.mockRestore();
      const saved = structuredClone(
        stripRuntimeOnlySessionSkillsFields({
          sessionId: "existing",
          updatedAt: 1,
          skillsSnapshot: original,
        }).skillsSnapshot,
      );

      fs.writeFileSync(binary, "fixture", { mode: 0o755 });
      const { snapshot: fresh } = await resolveReusableWorkspaceSkillSnapshot(params);
      const { snapshot: hydrated } = await resolveReusableWorkspaceSkillSnapshot({
        ...params,
        existingSnapshot: saved,
      });
      expect(hydrated.prompt).toBe(original.prompt);
      expect(hydrated.skills).toEqual(original.skills);
      expect(hydrated.resolvedSkills).toEqual(original.resolvedSkills);
      expect(hydrated.discoverySkills).toEqual(original.discoverySkills);
      const catalog = prepareInstalledSkillCatalog({
        snapshot: hydrated,
        workspaceDir: params.workspaceDir,
      });
      expect(catalog).toHaveLength(2);
      const provider = expectDefined(
        catalog.find((skill) => skill.name === "probe"),
        "saved provider",
      );
      expect(provider.source.filePath).toBe(path.join(alternateRoot, "probe", "SKILL.md"));
      expect(hydrated.discoverySkills?.find((skill) => skill.name === "probe")?.fileHost).toBe(
        remote ? "workspace" : undefined,
      );
      expect(fs.readFileSync(provider.source.filePath, "utf8")).toContain(
        "Original implementation",
      );
      expect(
        prepareInstalledSkillCatalog({ snapshot: fresh, workspaceDir: params.workspaceDir }).find(
          (skill) => skill.name === "probe",
        )?.source.filePath,
      ).toBe(path.join(params.workspaceDir, "skills", "probe", "SKILL.md"));
    },
  );

  it("does not revive an ineligible source during cold snapshot hydration", async () => {
    const params = await fixture();
    await writeSkill({
      dir: path.join(params.workspaceDir, "skills", "env-probe"),
      name: "env-probe",
      description: "Requires an environment prerequisite",
      metadata: '{"openclaw":{"requires":{"env":["W8_SKILL_ENV_FIXTURE"]}}}',
    });
    vi.stubEnv("W8_SKILL_ENV_FIXTURE", "fixture");
    const original = await buildSkillSnapshot(params.workspaceDir, {
      config: params.config,
      snapshotVersion: getSkillsSnapshotVersion(params.workspaceDir),
    });
    expect(original.discoverySkills?.map((skill) => skill.name)).toEqual(["env-probe", "visible"]);
    const saved = stripRuntimeOnlySessionSkillsFields({
      sessionId: "cold",
      updatedAt: 1,
      skillsSnapshot: original,
    }).skillsSnapshot;
    vi.stubEnv("W8_SKILL_ENV_FIXTURE", undefined);

    const { snapshot } = await resolveReusableWorkspaceSkillSnapshot({
      ...params,
      existingSnapshot: expectDefined(saved, "saved snapshot"),
    });
    expect(snapshot.prompt).toBe(original.prompt);
    expect(snapshot.resolvedSkills?.map((skill) => skill.name)).toEqual(["visible"]);
    expect(snapshot.discoverySkills?.map((skill) => skill.name)).toEqual(["visible"]);
  });

  it("discovers newly installed dependencies for fresh sessions without rewriting active snapshots", async () => {
    const params = await fixture();
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    params.config.skills = { load: { watch: false }, limits: { maxSkillsInPrompt: 1 } };
    const binDir = path.join(path.dirname(params.workspaceDir), "bin");
    fs.mkdirSync(binDir);
    const sessionStore: Record<string, SessionEntry> = {};
    const prepare = (sessionKey: string) =>
      ensureSkillSnapshot({
        agentId: "main",
        sessionEntry: sessionStore[sessionKey],
        sessionStore,
        sessionKey,
        isFirstTurnInSession: sessionStore[sessionKey] === undefined,
        workspaceDir: params.workspaceDir,
        cfg: params.config,
      });

    const original = await prepare("agent:main:before-install");
    expect(original.skillsSnapshot?.skills.map((skill) => skill.name)).toEqual(["visible"]);

    fs.writeFileSync(path.join(binDir, "fixture-missing-tool"), "fixture", { mode: 0o755 });

    expect((await prepare("agent:main:before-install")).skillsSnapshot).toBe(
      original.skillsSnapshot,
    );
    const fresh = await prepare("agent:main:after-install");
    expect(fresh.skillsSnapshot?.skills.map((skill) => skill.name)).toEqual(["probe", "visible"]);

    sessionStore["agent:main:before-install"] = stripRuntimeOnlySessionSkillsFields(
      expectDefined(sessionStore["agent:main:before-install"], "original session"),
    );
    const hydrated = await prepare("agent:main:before-install");
    expect(hydrated.skillsSnapshot?.prompt).toBe(original.skillsSnapshot?.prompt);
    expect(hydrated.skillsSnapshot?.resolvedSkills?.map((skill) => skill.name)).toEqual([
      "visible",
    ]);
    expect(
      prepareInstalledSkillCatalog({
        snapshot: hydrated.skillsSnapshot,
        workspaceDir: params.workspaceDir,
      }).map((skill) => skill.name),
    ).toEqual(["visible"]);
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
    expect((await resolveReusableWorkspaceSkillSnapshot(params)).snapshot).toEqual(result.snapshot);
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
    const { resolvedSkills, discoverySkills, ...saved } = snapshot;
    saved.prompt = `Saved prefix\n${saved.prompt}`;
    const before = JSON.stringify(saved);
    Object.freeze(saved);
    const hydrated = (
      await resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: saved })
    ).snapshot;
    const {
      resolvedSkills: hydratedSkills,
      discoverySkills: hydratedDiscovery,
      ...persisted
    } = hydrated;
    expect(JSON.stringify(persisted)).toBe(before);
    expect(hydratedSkills).toEqual(resolvedSkills);
    expect(hydratedDiscovery).toEqual(discoverySkills);
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
    expect((await resolveReusableWorkspaceSkillSnapshot(params)).snapshot).toEqual(result.snapshot);
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
