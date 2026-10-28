import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
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
import * as skillsRefresh from "./refresh.js";
import {
  recordRemoteSkillNodeInfo,
  removeRemoteNodeSkills,
  replaceRemoteNodeSkills,
} from "./remote-skills.js";
import { resolveReusableWorkspaceSkillSnapshot } from "./session-snapshot.js";

const names = (skills?: ReadonlyArray<{ name: string }>) => skills?.map(({ name }) => name);
const resolution = (s: SkillSnapshot) => [s.prompt, s.resolvedSkills, s.discoverySkills];
const missingTool = { metadata: '{"openclaw":{"requires":{"bins":["fixture-missing-tool"]}}}' };
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
    skillRoot = path.join(workspaceDir, "skills"),
  ) => writeSkill({ dir: path.join(skillRoot, name), name, description, ...options });
  await write("probe", "Requires a local tool", missingTool);
  const visibleFile = path.join(workspaceDir, "skills", "visible", "SKILL.md");
  await write("visible", "Original instructions");
  const config: OpenClawConfig = { plugins: { enabled: false } };
  const params = { workspaceDir, config, watch: false as const };
  const resolve = (
    options: Partial<Parameters<typeof resolveReusableWorkspaceSkillSnapshot>[0]> = {},
  ) => resolveReusableWorkspaceSkillSnapshot({ ...params, ...options });
  const catalog = (snapshot: Parameters<typeof prepareInstalledSkillCatalog>[0]["snapshot"]) =>
    prepareInstalledSkillCatalog({ snapshot, workspaceDir });
  const source = (snapshot: SkillSnapshot, name: string) =>
    catalog(snapshot).find((skill) => skill.name === name)?.source.filePath;
  const build = () =>
    buildSkillSnapshot(workspaceDir, {
      config,
      snapshotVersion: getSkillsSnapshotVersion(workspaceDir),
    });
  const install = () => {
    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "fixture-missing-tool"), "fixture", { mode: 0o755 });
  };
  const prepare = (
    options: Omit<Parameters<typeof ensureSkillSnapshot>[0], "agentId" | "workspaceDir" | "cfg">,
  ) => ensureSkillSnapshot({ agentId: "main", workspaceDir, cfg: config, ...options });
  return { ...params, visibleFile, write, resolve, catalog, source, build, install, prepare };
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
let params: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  params = await fixture();
});
it.each([
  { name: "deploy", savedName: "deploy", reservedName: undefined },
  { name: "probe", savedName: "snapshot-node-probe", reservedName: undefined },
  { name: "probe", savedName: "snapshot-node-probe-2", reservedName: "snapshot-node-probe" },
])("pins node $savedName", async ({ name, savedName, reservedName }) => {
  if (reservedName) {
    await params.write(reservedName, "Unavailable local provider", missingTool);
  }
  const nodeId = "snapshot-node";
  const eligibility = { nodeSkills: { canExec: true } };
  onTestFinished(() => removeRemoteNodeSkills(nodeId));
  onTestFinished(bindWorkspace(params.workspaceDir));
  recordRemoteSkillNodeInfo({ nodeId, commands: ["system.run"] });
  const content = `---\nname: ${name}\ndescription: Node\n---\nNode instructions`;
  replaceRemoteNodeSkills({
    nodeId,
    skills: [{ name, description: "Node", content }],
  });
  const { snapshot: original } = await params.resolve({ eligibility });
  const saved = persist(original);
  const localDir = path.join(params.workspaceDir, "skills", name);
  await params.write(name, "Local deployment");
  const { snapshot: fresh } = await params.resolve({ eligibility });
  const { snapshot: hydrated } = await params.resolve({
    eligibility,
    existingSnapshot: expectDefined(saved, "persisted node snapshot"),
  });
  expect(resolution(hydrated)).toEqual(resolution(original));
  const nodeFile = `node://snapshot-node/skills/${name}/SKILL.md`;
  expect(params.source(hydrated, savedName)).toBe(nodeFile);
  expect(params.source(fresh, name)).toBe(path.join(localDir, "SKILL.md"));
  expect(params.source(fresh, reservedName ? savedName : `snapshot-node-${name}`)).toBe(nodeFile);
});

it.each([
  { maxSkillsInPrompt: 1, retained: true, remote: false },
  { maxSkillsInPrompt: 2, retained: false, remote: false },
  { maxSkillsInPrompt: 1, retained: false, remote: true },
])(
  "retains provider ($maxSkillsInPrompt, retained=$retained, remote=$remote)",
  async ({ maxSkillsInPrompt, retained, remote }) => {
    params.config.skills = { load: { watch: false }, limits: { maxSkillsInPrompt } };
    const alternateRoot = path.join(params.workspaceDir, ".agents", "skills");
    await params.write("probe", "Original", { body: "Original implementation" }, alternateRoot);
    await params.write("alpha", "Always available", {}, alternateRoot);
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
    const resolveEntries = workspaceSkillLoader.resolveWorkspaceSkillPromptEntries;
    const selection = vi
      .spyOn(workspaceSkillLoader, "resolveWorkspaceSkillPromptEntries")
      .mockImplementationOnce((workspaceDir, options) =>
        resolveEntries(workspaceDir, { ...options, entries: originalEntries }),
      );
    const original = retained ? (await params.resolve()).snapshot : await params.build();
    selection.mockRestore();
    const saved = structuredClone(persist(original));
    params.install();
    const { snapshot: fresh } = await params.resolve();
    const { snapshot: hydrated } = await params.resolve({ existingSnapshot: saved });
    expect(resolution(hydrated)).toEqual(resolution(original));
    expect(hydrated.skills).toEqual(original.skills);
    expect(params.catalog(hydrated)).toHaveLength(2);
    const file = expectDefined(params.source(hydrated, "probe"), "saved provider");
    expect(file).toBe(path.join(alternateRoot, "probe", "SKILL.md"));
    expect(hydrated.discoverySkills?.find((skill) => skill.name === "probe")?.fileHost).toBe(
      remote ? "workspace" : undefined,
    );
    expect(fs.readFileSync(file, "utf8")).toContain("Original implementation");
    expect(params.source(fresh, "probe")).toBe(
      path.join(params.workspaceDir, "skills", "probe", "SKILL.md"),
    );
  },
);

it("does not revive an ineligible source during cold snapshot hydration", async () => {
  await params.write("env-probe", "Environment prerequisite", {
    metadata: '{"openclaw":{"requires":{"env":["W8_SKILL_ENV_FIXTURE"]}}}',
  });
  vi.stubEnv("W8_SKILL_ENV_FIXTURE", "fixture");
  const original = await params.build();
  expect(names(original.discoverySkills)).toEqual(["env-probe", "visible"]);
  const saved = persist(original);
  vi.stubEnv("W8_SKILL_ENV_FIXTURE", undefined);
  const project = skillsRefresh.projectSkillSnapshot;
  let selectedSkills: SkillSnapshot["discoverySkills"];
  vi.spyOn(skillsRefresh, "projectSkillSnapshot").mockImplementation(async (input) => {
    const projected = await project(input);
    selectedSkills = projected.discoverySkills;
    return projected;
  });
  const { snapshot } = await params.resolve({
    existingSnapshot: expectDefined(saved, "saved snapshot"),
  });
  expect(snapshot.prompt).toBe(original.prompt);
  expect(names(snapshot.resolvedSkills)).toEqual(["visible"]);
  expect(names(snapshot.discoverySkills)).toEqual(["visible"]);
  // Discovery already excluded the ineligible source; hydration retains that selection.
  expect(snapshot.discoverySkills).toBe(selectedSkills);
});

it("discovers newly installed dependencies for fresh sessions without rewriting active snapshots", async () => {
  vi.stubEnv("OPENCLAW_TEST_FAST", "0");
  params.config.skills = { load: { watch: false }, limits: { maxSkillsInPrompt: 1 } };
  const sessionStore: Record<string, SessionEntry> = {};
  const sessionKey = "agent:main:before-install";
  const prepare = (key: string) =>
    params.prepare({
      sessionEntry: sessionStore[key],
      sessionStore,
      sessionKey: key,
      isFirstTurnInSession: sessionStore[key] === undefined,
    });
  const original = await prepare(sessionKey);
  expect(names(original.skillsSnapshot?.skills)).toEqual(["visible"]);
  params.install();
  expect((await prepare(sessionKey)).skillsSnapshot).toBe(original.skillsSnapshot);
  const fresh = await prepare("agent:main:after-install");
  expect(names(fresh.skillsSnapshot?.skills)).toEqual(["probe", "visible"]);
  sessionStore[sessionKey] = stripRuntimeOnlySessionSkillsFields(
    expectDefined(sessionStore[sessionKey], "original session"),
  );
  const hydrated = await prepare(sessionKey);
  expect(hydrated.skillsSnapshot?.prompt).toBe(original.skillsSnapshot?.prompt);
  expect(names(hydrated.skillsSnapshot?.resolvedSkills)).toEqual(["visible"]);
  expect(names(params.catalog(hydrated.skillsSnapshot))).toEqual(["visible"]);
});

it.each([
  [true, true, false],
  [true, false, false],
  [false, true, false],
  [false, false, false],
  [false, true, true],
  [false, false, true],
] as const)(
  "preserves concurrent reply state (first turn %s, handle %s, warm %s)",
  async (isFirstTurnInSession, useHandle, warm) => {
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
      params.prepare({
        sessionEntry,
        sessionStore,
        sessionEntryHandle,
        sessionKey,
        isFirstTurnInSession,
      });
    if (warm) {
      await prepare();
      sessionEntry = expectDefined(sessionStore[sessionKey], "prepared warm session entry");
    }
    const pending = prepare();
    const concurrent: SessionEntry = {
      ...sessionEntry,
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
  const requestedVersion = getSkillsSnapshotVersion(params.workspaceDir);
  const pending = params.resolve({ snapshotVersion: requestedVersion });
  const content = "---\nname: visible\ndescription: Updated instructions\n---\n";
  fs.writeFileSync(params.visibleFile, content);
  const currentVersion = bumpSkillsSnapshotVersion({ workspaceDir: params.workspaceDir });
  const { snapshot } = await pending;
  expect(snapshot.prompt).toContain("Updated instructions");
  expect(snapshot.prompt).not.toContain("Original instructions");
  expect(snapshot.version).toBe(currentVersion);
  expect((await params.resolve()).snapshot).toEqual(snapshot);
});

it("rechecks eligibility after preparation without changing admitted configuration", async () => {
  let canExec = true;
  const pending = params.resolve({
    resolveEligibility: () => ({ nodeSkills: { canExec } }),
  });
  canExec = false;
  expect((await pending).snapshot.nodeSkillsEligibility).toEqual({ canExec: false });
});

it("keeps a shared rebuild alive for its remaining caller after another caller aborts", async () => {
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
  vi.stubEnv("ASYNC_SKILL_FIXTURE", undefined);
  params.config.skills = { entries: { visible: { env: { ASYNC_SKILL_FIXTURE: "owned" } } } };
  const controller = new AbortController();
  const reason = new Error("attempt cancelled");
  const pending = prepareEmbeddedSkills({
    attempt: { config: params.config },
    effectiveWorkspace: params.workspaceDir,
    sandbox: null,
    sessionAgentId: "main",
    includeCodeModeSkills: true,
    assertCurrent: () => controller.signal.throwIfAborted(),
  });
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
