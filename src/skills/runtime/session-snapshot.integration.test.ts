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
import { readWorkspaceSkillSources } from "../loading/workspace-skill-source-reader.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { SkillSnapshot } from "../types.js";
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
  const write = (
    name: string,
    description: string,
    options: Omit<Parameters<typeof writeSkill>[0], "dir" | "name" | "description"> = {},
  ) => writeSkill({ dir: path.join(workspaceDir, "skills", name), name, description, ...options });
  await write("probe", "Requires a local tool", {
    metadata: '{"openclaw":{"requires":{"bins":["fixture-missing-tool"]}}}',
  });
  const visibleFile = path.join(workspaceDir, "skills", "visible", "SKILL.md");
  await write("visible", "Original instructions");
  const config: OpenClawConfig = { plugins: { enabled: false } };
  const params = { workspaceDir, config, watch: false as const };
  const resolve = (
    options: Partial<Parameters<typeof resolveReusableWorkspaceSkillSnapshot>[0]> = {},
  ) => resolveReusableWorkspaceSkillSnapshot({ ...params, ...options });
  const catalog = (snapshot: Parameters<typeof prepareInstalledSkillCatalog>[0]["snapshot"]) =>
    prepareInstalledSkillCatalog({ snapshot, workspaceDir });
  return { ...params, visibleFile, write, resolve, catalog };
}

function persist(snapshot: SkillSnapshot) {
  return stripRuntimeOnlySessionSkillsFields({
    sessionId: "existing",
    updatedAt: 1,
    skillsSnapshot: snapshot,
  }).skillsSnapshot;
}
const bindWorkspace = (workspaceDir: string) =>
  registerAgentWorkspaceAccess(workspaceDir, {
    bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
    loadSkills: async (request) => readWorkspaceSkillSources(request),
  });

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
        await params.write(reservedName, "Unavailable local provider", {
          metadata: '{"openclaw":{"requires":{"bins":["fixture-missing-tool"]}}}',
        });
      }
      const nodeId = "snapshot-node";
      const eligibility = { nodeSkills: { canExec: true } };
      onTestFinished(() => removeRemoteNodeSkills(nodeId));
      onTestFinished(bindWorkspace(params.workspaceDir));
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
      const { snapshot: original } = await params.resolve({
        eligibility,
      });
      const saved = persist(original);
      const localDir = path.join(params.workspaceDir, "skills", name);
      await params.write(name, "Local deployment");

      const { snapshot: fresh } = await params.resolve({
        eligibility,
      });
      const { snapshot: hydrated } = await params.resolve({
        eligibility,
        existingSnapshot: expectDefined(saved, "persisted node snapshot"),
      });
      expect(hydrated.prompt).toBe(original.prompt);
      expect(hydrated.resolvedSkills).toEqual(original.resolvedSkills);
      expect(hydrated.discoverySkills).toEqual(original.discoverySkills);
      expect(
        params.catalog(hydrated).find((skill) => skill.name === savedName)?.source.filePath,
      ).toBe(`node://snapshot-node/skills/${name}/SKILL.md`);
      expect(params.catalog(fresh).find((skill) => skill.name === name)?.source.filePath).toBe(
        path.join(localDir, "SKILL.md"),
      );
      expect(
        params
          .catalog(fresh)
          .find((skill) => skill.name === (reservedName ? savedName : `snapshot-node-${name}`))
          ?.source.filePath,
      ).toBe(`node://snapshot-node/skills/${name}/SKILL.md`);
    },
  );

  it.each([
    { maxSkillsInPrompt: 1, retained: true, remote: false },
    { maxSkillsInPrompt: 2, retained: false, remote: false },
    { maxSkillsInPrompt: 1, retained: false, remote: true },
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
        onTestFinished(bindWorkspace(params.workspaceDir));
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
        ? (await params.resolve()).snapshot
        : await buildSkillSnapshot(params.workspaceDir, {
            config: params.config,
            snapshotVersion: getSkillsSnapshotVersion(params.workspaceDir),
          });
      selection.mockRestore();
      const saved = structuredClone(persist(original));

      fs.writeFileSync(binary, "fixture", { mode: 0o755 });
      const { snapshot: fresh } = await params.resolve();
      const { snapshot: hydrated } = await params.resolve({
        existingSnapshot: saved,
      });
      expect(hydrated.prompt).toBe(original.prompt);
      expect(hydrated.skills).toEqual(original.skills);
      expect(hydrated.resolvedSkills).toEqual(original.resolvedSkills);
      expect(hydrated.discoverySkills).toEqual(original.discoverySkills);
      const catalog = params.catalog(hydrated);
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
      expect(params.catalog(fresh).find((skill) => skill.name === "probe")?.source.filePath).toBe(
        path.join(params.workspaceDir, "skills", "probe", "SKILL.md"),
      );
    },
  );

  it("does not revive an ineligible source during cold snapshot hydration", async () => {
    const params = await fixture();
    await params.write("env-probe", "Requires an environment prerequisite", {
      metadata: '{"openclaw":{"requires":{"env":["W8_SKILL_ENV_FIXTURE"]}}}',
    });
    vi.stubEnv("W8_SKILL_ENV_FIXTURE", "fixture");
    const original = await buildSkillSnapshot(params.workspaceDir, {
      config: params.config,
      snapshotVersion: getSkillsSnapshotVersion(params.workspaceDir),
    });
    expect(original.discoverySkills?.map((skill) => skill.name)).toEqual(["env-probe", "visible"]);
    const saved = persist(original);
    vi.stubEnv("W8_SKILL_ENV_FIXTURE", undefined);

    const { snapshot } = await params.resolve({
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
    expect(params.catalog(hydrated.skillsSnapshot).map((skill) => skill.name)).toEqual(["visible"]);
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

  it("rebuilds changed source bytes and version before publishing an in-flight snapshot", async () => {
    const params = await fixture();
    const requestedVersion = getSkillsSnapshotVersion(params.workspaceDir);
    const pending = Promise.resolve(
      params.resolve({
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
    expect((await params.resolve()).snapshot).toEqual(result.snapshot);
  });

  it("rechecks eligibility after preparation without changing admitted configuration", async () => {
    const params = await fixture();
    let canExec = true;
    const pending = params.resolve({
      resolveEligibility: () => ({ nodeSkills: { canExec } }),
    });
    canExec = false;
    expect((await pending).snapshot.nodeSkillsEligibility).toEqual({ canExec: false });
  });

  it("keeps a shared rebuild alive for its remaining caller after another caller aborts", async () => {
    const params = await fixture();
    const controller = new AbortController();
    const reason = new Error("preparation cancelled");
    const first = params.resolve({
      assertCurrent: () => controller.signal.throwIfAborted(),
    });
    const rejected = expect(first).rejects.toBe(reason);
    const second = params.resolve();
    controller.abort(reason);

    const result = await second;
    await rejected;
    expect(result.snapshot.prompt).toContain("Original instructions");
    expect((await params.resolve()).snapshot).toEqual(result.snapshot);
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
