import { execFile } from "node:child_process";
import "../agents/subagents/spawn/subagent-spawn-model.mocks.shared.js";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { captureMethodCall } from "../../test/helpers/capture-method-call.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { persistSubagentSessionTiming } from "../agents/subagents/registry/subagent-registry-helpers.js";
import { getSubagentRunsForChildSession } from "../agents/subagents/registry/subagent-registry-memory.js";
import * as spawnRuntime from "../agents/subagents/spawn/subagent-spawn.runtime.js";
import { createSessionsSpawnTool } from "../agents/tools/sessions-spawn-tool.js";
import * as repositoryPaths from "../agents/worktrees/repository-paths.js";
import { managedWorktrees, ManagedWorktreeService } from "../agents/worktrees/service.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import * as sessionAccess from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { withTimeout } from "../infra/fs-safe.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { withProjectCheckoutLifecycle } from "../projects/project-checkout.js";
import { registerProjectRegistry, removeProjectRegistry } from "../projects/project-registry.js";
import {
  captureSessionControllerSettlement,
  isSessionMutationActive,
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
} from "../sessions/session-controller.lifecycle.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as leaseAcquisition from "../state/openclaw-state-lease-acquisition.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import { createWorktreeSpawnRepositoryFixture } from "./server.sessions.create-worktree-spawn.test-support.js";
import {
  controlUiClient,
  settleWorkspaceRuns,
} from "./server.sessions.create.projects.test-support.js";
import * as worktreePreparation from "./session-worktree-preparation.js";
import { agentDiscoveryMock, dispatchInboundMessageMock, testState } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const projectCloneMocks = vi.hoisted(() => ({
  materializeProjectClone: vi.fn(),
  refreshProjectClone: vi.fn(),
}));
vi.mock("../projects/project-clone.js", () => projectCloneMocks);

let createRepository: ReturnType<typeof createWorktreeSpawnRepositoryFixture>;
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness(async (makeTempDir) => {
  createRepository = createWorktreeSpawnRepositoryFixture(
    makeTempDir("openclaw-spawn-repo-seeds-"),
  );
});
const execFileAsync = promisify(execFile);
const parentKey = "agent:main:dashboard:project-parent";
const parentCreateParams = {
  key: parentKey,
  agentId: "main",
  worktree: true,
  worktreeName: "parent",
  worktreeBaseRef: "main",
};
function connection(backend = false, scopes = ["operator.write"]) {
  return {
    minProtocol: 1,
    maxProtocol: 1,
    scopes,
    client: {
      id: backend ? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT : GATEWAY_CLIENT_NAMES.CONTROL_UI,
      version: "test",
      platform: backend ? "node" : "web",
      mode: backend ? GATEWAY_CLIENT_MODES.BACKEND : GATEWAY_CLIENT_MODES.WEBCHAT,
    },
  };
}
const adminRequest = { client: { connect: connection(false, ["operator.admin"]) } };
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let repository: string;
let storePath: string;

type CreatedWorktreeSession = {
  key: string;
  sessionId: string;
  runId: string;
  runStarted: boolean;
  entry: SessionEntry;
  worktree: { id: string; path: string };
};

function readEntry(sessionKey: string) {
  return loadSessionEntry({ agentId: "main", sessionKey, storePath });
}
function writeEntry(sessionKey: string, entry: SessionEntry) {
  replaceSessionEntrySync({ agentId: "main", sessionKey, storePath }, entry);
}
type CreationOptions = Parameters<typeof directSessionReq<CreatedWorktreeSession>>[2];
function requestCreation(params: Record<string, unknown>, options: CreationOptions = adminRequest) {
  return directSessionReq<CreatedWorktreeSession>(
    "sessions.create",
    { agentId: "main", ...params },
    options,
  );
}
async function accepted<T>(request: Promise<{ ok: boolean; error?: unknown; payload?: T }>) {
  const result = await request;
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  return result.payload!;
}
const createSession = (params: Record<string, unknown>) => accepted(requestCreation(params));
async function expectCreationError(request: Promise<unknown>, message: unknown, code?: string) {
  const result = await request;
  expect(result).toMatchObject({ ok: false, error: { message, ...(code ? { code } : {}) } });
}
const runtimeContext = () => ({
  broadcast: vi.fn(),
  dedupe: new Map(),
});
function mockDispatch() {
  dispatchInboundMessageMock.mockResolvedValue({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  });
}
const git = (...args: string[]) => execFileAsync("git", ["-C", repository, ...args]);
const readReadme = (dir: string) => fs.readFile(path.join(dir, "README.md"), "utf8");

function spawnClient(requesterSessionKey = parentKey) {
  return {
    connect: { scopes: ["operator.write"] },
    internal: {
      syntheticClient: true as const,
      sessionCreation: {
        via: "spawn" as const,
        actor: { type: "agent" as const, id: "main" },
        requesterSessionKey,
        inheritedToolPolicy: { version: 1 as const, allow: ["read"], deny: [] },
      },
    },
  };
}

function requestChild(
  params: Record<string, unknown> = {},
  requesterSessionKey = parentKey,
  options?: CreationOptions,
) {
  return requestCreation(
    {
      label: "Project child",
      parentSessionKey: requesterSessionKey,
      spawnDepth: 1,
      worktree: true,
      ...params,
    },
    options ?? { client: spawnClient(requesterSessionKey) as never },
  );
}
const createChild = (...args: Parameters<typeof requestChild>) => accepted(requestChild(...args));

async function createDirectProjectParent() {
  const project = await registerProjectRegistry({ path: repository });
  const created = await createSession({ projectId: project.id });
  expect(created.entry).toMatchObject({
    projectId: project.id,
    spawnedCwd: repository,
    sessionRoot: repository,
  });
  expect(created.entry.worktree).toBeUndefined();
  return { ...created, project };
}

async function createManagedProjectParent(required = false) {
  const created = await createSession({ ...parentCreateParams, cwd: repository });
  if (required) {
    writeEntry(parentKey, { ...created.entry, sandbox: "required" });
  }
  return created;
}

async function createVisibleSpawnTool() {
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const context = createDirectChatContext({
    getRuntimeConfig,
    trackExecution: async (run) => await run(),
  });
  const registerRun = vi.fn();
  const tool = createSessionsSpawnTool({
    agentSessionKey: parentKey,
    config: getRuntimeConfig(),
    registerRun,
    countActiveRuns: () => 0,
  });
  const spawn = (options: Record<string, unknown>) =>
    withPluginRuntimeGatewayContextResolver(
      () => context,
      () => tool.execute("select-project", { task: "Read README.md", visible: true, ...options }),
    );
  return { context, registerRun, spawn };
}

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "openclaw-spawn-repo-" });
  const defaultWorkspace = path.join(state.root, "non-git-workspace");
  await fs.mkdir(defaultWorkspace);
  repository = await createRepository(state.root, "selected-project");
  testState.agentConfig = { workspace: defaultWorkspace };
  ({ storePath } = await createSessionStoreDir());
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const { provider, model } = resolveDefaultModelForAgent({
    cfg: getRuntimeConfig(),
    agentId: "main",
  });
  agentDiscoveryMock.models = [
    { provider, id: model, name: "Default fixture model", reasoning: false },
  ];
});

afterEach(async () => {
  await disposeSessionReadContexts();
  vi.restoreAllMocks();
  projectCloneMocks.materializeProjectClone.mockReset();
  projectCloneMocks.refreshProjectClone.mockReset();
  testState.agentConfig = undefined;
  testState.agentsConfig = undefined;
  await state?.cleanup();
});

afterAll(closeStateDatabaseForTest);

test.each([
  ["registered", true],
  ["github", true],
  ["inherited", true],
  ["registered", false],
  ["github", false],
] as const)(
  "required visible spawn selects %s project (managed worktree: %s)",
  async (source, worktree) => {
    const { entry: parent } = await createManagedProjectParent(true);
    const projectName = worktree ? "tool-selected-project" : "sandbox-external-project";
    const otherRepository = await createRepository(state.root, projectName);
    const project = await registerProjectRegistry({ path: otherRepository });
    projectCloneMocks.materializeProjectClone.mockResolvedValue(project);
    const { context, registerRun, spawn } = await createVisibleSpawnTool();
    const createWorktree = vi.spyOn(ManagedWorktreeService.prototype, "createWithOutcome");
    const bindChild = vi.spyOn(sessionAccess, "createSessionEntryWithTranscript");
    mockDispatch();
    let childKey: string | undefined;
    let creationError: unknown;
    try {
      const result = await spawn({
        // Sandbox rejection must not await unrelated automatic title generation.
        label: worktree ? "Selected project child" : "Rejected project child",
        ...(source === "registered"
          ? { projectId: project.id }
          : source === "github"
            ? {
                projectGitUrl: worktree
                  ? "git@github.com:example/selected.git"
                  : "https://github.com/example/restricted.git",
              }
            : {}),
        ...(worktree
          ? {
              worktree: true,
              worktreeName: "selected-child",
              worktreeBaseRef: "main",
            }
          : {}),
      }).catch((error: unknown) => {
        creationError = error;
        return undefined;
      });
      if (isRecord(result?.details) && typeof result.details.childSessionKey === "string") {
        childKey = result.details.childSessionKey;
      }
      if (childKey) {
        await settleWorkspaceRuns(context, storePath, childKey);
      }
      const child = childKey ? readEntry(childKey) : undefined;
      if (!worktree) {
        if (source === "registered") {
          expect(creationError).toMatchObject({
            message: expect.stringContaining("outside the sandboxed agent workspace"),
          });
          expect(childKey).toBeUndefined();
          expect(bindChild).not.toHaveBeenCalled();
          expect(registerRun).not.toHaveBeenCalled();
        } else {
          expect(creationError).toBeUndefined();
          expect(child).toMatchObject({ sandbox: "required", status: "failed" });
          expect(child?.lastRunError).toContain("outside the sandboxed agent workspace");
        }
        expect(createWorktree).not.toHaveBeenCalled();
        if (childKey) {
          expect(await managedWorktrees.findLiveByOwner("session", childKey)).toBeUndefined();
        }
        expect(child?.worktree).toBeUndefined();
        expect(child?.projectId).toBeUndefined();
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        return;
      }
      expect(result?.details, JSON.stringify(result?.details)).toMatchObject({
        status: "accepted",
      });
      expect(childKey).toEqual(expect.any(String));
      expect(child).toMatchObject({ parentSessionId: parent.sessionId, sandbox: "required" });
      if (source !== "inherited") {
        expect(child?.projectId).toBe(project.id);
      }
      expect(child?.worktree?.repoRoot).toBe(source === "inherited" ? repository : otherRepository);
      expect(await readReadme(child!.spawnedCwd!)).toBe(
        source === "inherited" ? "selected-project\n" : `${projectName}\n`,
      );
      if (source === "github") {
        expect(projectCloneMocks.materializeProjectClone).toHaveBeenCalledWith(
          expect.objectContaining({ gitUrl: "https://github.com/example/selected.git" }),
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
      } else {
        expect(projectCloneMocks.materializeProjectClone).not.toHaveBeenCalled();
      }
      await expect(fs.stat(path.join(child!.spawnedCwd!, "setup-marker.txt"))).rejects.toThrow();
      expect(registerRun).toHaveBeenCalledOnce();
    } finally {
      if (childKey) {
        await settleWorkspaceRuns(context, storePath, childKey, true);
      }
      dispatchInboundMessageMock.mockReset();
    }
  },
);

test("worktree spawns inherit the managed parent when the default workspace is unavailable", async () => {
  const { entry: parent } = await createManagedProjectParent(true);
  const defaultWorkspace = path.join(state.root, "non-git-workspace");
  await fs.rmdir(defaultWorkspace);
  await fs.writeFile(defaultWorkspace, "unavailable workspace");

  const child = await createChild();
  expect(readEntry(child.key)).toMatchObject({
    parentSessionId: parent.sessionId,
    sandbox: "required",
    worktree: { id: child.worktree.id, repoRoot: repository },
  });
  expect(child.worktree.path).not.toBe(parent.spawnedCwd);
  expect(await readReadme(child.worktree.path)).toBe("selected-project\n");
  expect(await fs.readFile(defaultWorkspace, "utf8")).toBe("unavailable workspace");
});

test.each(["startup", "source settlement"] as const)(
  "cleans the committed native child when Stop interrupts %s",
  async (failure) => {
    const parent = await createDirectProjectParent();
    const scope = { agentId: "main", storePath };
    const originalKeys = await sessionAccess.listSessionEntryKeysReadOnly(scope);
    const { getRuntimeConfig } = await getGatewayConfigModule();
    const context = createDirectChatContext({
      getRuntimeConfig,
      trackExecution: async (run) => run(),
    });
    const methodRegistry = createRequestGatewayMethodRegistry();
    const runtime = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () => methodRegistry,
      isDispatchAvailable: () => true,
    });
    context.recoveryRuntime = runtime.recovery;
    onTestFinished(() => runtime.close());
    const invocation = new AbortController();
    const tool = createSessionsSpawnTool({
      agentSessionKey: parent.key,
      expectedParentSessionId: parent.entry.sessionId,
      config: getRuntimeConfig(),
      countActiveRuns: () => 0,
    });
    let sourceSettled = false;
    if (failure === "source settlement") {
      const prepare = worktreePreparation.prepareSessionWorktreeCreation;
      vi.spyOn(worktreePreparation, "prepareSessionWorktreeCreation").mockImplementation(
        async (...args) => {
          const prepared = await prepare(...args);
          if (!prepared.ok || !prepared.value.withCommit) {
            throw new Error("Expected the inherited project source commit owner");
          }
          const withCommit = prepared.value.withCommit;
          return {
            ...prepared,
            value: {
              ...prepared.value,
              withCommit: async (commit) => {
                await withCommit(commit);
                sourceSettled = true;
                invocation.abort(new Error("Stop after child commit"));
                // Model source settlement failure after the real child write has completed.
                throw new Error("Source settlement stopped after child commit");
              },
            },
          };
        },
      );
    }
    const upsert = spawnRuntime.upsertSessionEntryCore;
    let committedChildKey: string | undefined;
    vi.spyOn(spawnRuntime, "upsertSessionEntryCore").mockImplementation(async (...args) => {
      const entry = await upsert(...args);
      committedChildKey = args[0].sessionKey;
      expect(readEntry(committedChildKey)).toMatchObject({
        sessionId: entry?.sessionId,
        lifecycleRevision: entry?.lifecycleRevision,
      });
      if (failure === "startup") {
        invocation.abort(new Error("Stop after child commit"));
      }
      return entry;
    });
    const result = await withPluginRuntimeGatewayContextResolver(
      () => context,
      () =>
        tool.execute(
          "post-commit-stop",
          { task: "Read README.md", worktree: true },
          invocation.signal,
        ),
    ).catch((error: unknown) => error);
    expect(result).not.toMatchObject({ details: { status: "accepted" } });
    expect(committedChildKey).toEqual(expect.any(String));
    expect(sourceSettled).toBe(failure === "source settlement");
    expect(await sessionAccess.listSessionEntryKeysReadOnly(scope)).toEqual(originalKeys);
    expect([...getSubagentRunsForChildSession(committedChildKey!)]).toEqual([]);
    expect(await managedWorktrees.listRegistryRecords()).toEqual([]);
  },
);

test.for(["invocation", "configured"] as const)(
  "stops native worktree spawn from its %s signal while its inherited registered source is busy",
  async (cancelSource, { signal }) => {
    const parent = await createDirectProjectParent();
    const scope = { agentId: "main", storePath };
    const originalKeys = await sessionAccess.listSessionEntryKeysReadOnly(scope);
    const originalCheckouts = (await git("worktree", "list", "--porcelain")).stdout;
    const { getRuntimeConfig } = await getGatewayConfigModule();
    const context = createDirectChatContext({
      getRuntimeConfig,
      trackExecution: async (run) => run(),
    });
    const invocation = new AbortController();
    const configured = new AbortController();
    const cancelled = cancelSource === "invocation" ? invocation : configured;
    const tool = createSessionsSpawnTool({
      signal: configured.signal,
      agentSessionKey: parent.key,
      expectedParentSessionId: parent.entry.sessionId,
      config: getRuntimeConfig(),
      countActiveRuns: () => 0,
    });
    const publishChild = vi.spyOn(spawnRuntime, "upsertSessionEntryCore");
    const held = createDeferredCore<() => void>();
    const release = createDeferredCore();
    const holder = withProjectCheckoutLifecycle(repository, {}, async (lease) => {
      held.resolve(lease.assertOwned);
      await release.promise;
    });
    const operations: Promise<unknown>[] = [holder];
    let continuedAfterStop = false;
    try {
      const assertHeld = await withinTest(
        awaitGateBeforeSettlement(held.promise, holder, "Source holder did not acquire custody"),
        signal,
      );
      const waiting = createDeferredCore();
      const continued = createDeferredCore();
      const acquire = leaseAcquisition.acquireOpenClawStateLease;
      vi.spyOn(leaseAcquisition, "acquireOpenClawStateLease").mockImplementation((options) =>
        acquire({
          ...options,
          acquire: async (...args) => {
            const selectedSource = options.label.endsWith(`projects.checkout/${repository}`);
            if (selectedSource && cancelled.signal.aborted) {
              continued.resolve();
            }
            const outcome = await options.acquire(...args);
            if (selectedSource && outcome.kind === "held") {
              // Observe actual SQLite contention; do not replace acquisition or its cancellation.
              waiting.resolve();
            }
            return outcome;
          },
        }),
      );
      let failure: unknown;
      const spawning = withPluginRuntimeGatewayContextResolver(
        () => context,
        () =>
          tool.execute(
            "native-source-stop",
            { task: "Read README.md", worktree: true, worktreeName: "stopped-child" },
            invocation.signal,
          ),
      ).catch((error: unknown) => {
        failure = error;
        return undefined;
      });
      operations.push(spawning);
      await withinTest(
        awaitGateBeforeSettlement(
          waiting.promise,
          spawning,
          "Native child did not wait for its source",
        ),
        signal,
      );
      cancelled.abort(new Error("Stop native source wait"));
      continuedAfterStop = await withinTest(
        Promise.race([spawning.then(() => false), continued.promise.then(() => true)]),
        signal,
      );
      assertHeld();
      expect(publishChild).not.toHaveBeenCalled();
      expect(await sessionAccess.listSessionEntryKeysReadOnly(scope)).toEqual(originalKeys);
      release.resolve();
      const result = await withinTest(spawning, signal);
      if (failure) {
        expect(failure).toBeInstanceOf(Error);
      } else {
        expect(result?.details).toMatchObject({ status: "error" });
      }
    } finally {
      release.resolve();
      await Promise.allSettled(operations);
    }
    expect(publishChild).not.toHaveBeenCalled();
    expect(await sessionAccess.listSessionEntryKeysReadOnly(scope)).toEqual(originalKeys);
    expect(await managedWorktrees.listRegistryRecords()).toEqual([]);
    expect((await git("worktree", "list", "--porcelain")).stdout).toBe(originalCheckouts);
    expect(continuedAfterStop, "Native child kept acquiring after Stop").toBe(false);
  },
);

test("required project preparation isolates host filters without rejecting the registered source", async () => {
  await createManagedProjectParent(true);
  const marker = path.join(state.root, "host-filter-marker");
  const script = path.join(state.root, "host-filter.cjs");
  await fs.writeFile(
    script,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); process.stdin.pipe(process.stdout);`,
  );
  await fs.writeFile(path.join(repository, ".gitattributes"), "README.md filter=synthetic\n");
  await git("add", ".gitattributes");
  await git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "filter declaration",
  );
  await git("config", "filter.synthetic.smudge", `"${process.execPath}" "${script}"`);
  const project = await registerProjectRegistry({ path: repository });
  const key = "agent:main:dashboard:filtered-project";
  await createChild({ key, projectId: project.id });
  const child = readEntry(key);
  expect(child).toMatchObject({ sandbox: "required", projectId: project.id });
  expect(child?.worktree?.id).toBe((await managedWorktrees.findLiveByOwner("session", key))?.id);
  expect(child?.spawnedCwd).not.toBe(repository);
  expect(await readReadme(child!.spawnedCwd!)).toBe(await readReadme(repository));
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(path.join(child!.spawnedCwd!, "setup-marker.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("visible spawn tool preserves project validation and external cwd authorization", async () => {
  await createManagedProjectParent();
  const project = await registerProjectRegistry({ path: repository });
  const { registerRun, spawn } = await createVisibleSpawnTool();
  const gitUrl = "https://github.com/example/selected.git";
  for (const options of [
    { projectId: project.id, cwd: repository },
    { projectGitUrl: gitUrl, cwd: repository },
    { projectId: project.id, projectGitUrl: gitUrl },
  ]) {
    await expect(spawn(options)).rejects.toThrow(/cannot be combined/);
  }
  for (const projectGitUrl of [
    "/tmp/repo",
    "file:///tmp/repo",
    "https://example.com/repo.git",
    "not-a-url",
  ]) {
    await expect(spawn({ projectGitUrl })).rejects.toThrow(
      "Use a GitHub HTTPS or git@github.com repository URL",
    );
  }
  await expect(spawn({ projectId: "missing-project" })).rejects.toThrow("unknown project id");
  const result = await spawn({ cwd: repository, worktree: true });
  expect(result.details).toMatchObject({
    status: "forbidden",
    error: expect.stringContaining("requires operator.admin"),
  });
  expect(registerRun).not.toHaveBeenCalled();
  expect(projectCloneMocks.materializeProjectClone).not.toHaveBeenCalled();
});

test.each(["archive", "unregister", "replace"] as const)(
  "worktree spawns roll back after parent %s during preparation",
  async (change) => {
    const directParent = change === "replace" ? undefined : await createDirectProjectParent();
    const selectedParent = directParent ?? (await createManagedProjectParent());
    let createdPath: string | undefined;
    const createWorktree = captureMethodCall("createWithOutcome")(ManagedWorktreeService.prototype);
    vi.spyOn(ManagedWorktreeService.prototype, "createWithOutcome").mockImplementation(
      async function (this: ManagedWorktreeService, params) {
        const outcome = await createWorktree(this, params);
        createdPath = outcome.record.path;
        if (change === "unregister" && directParent) {
          expect(await removeProjectRegistry(directParent.project)).toBe(true);
        } else {
          writeEntry(selectedParent.key, {
            ...selectedParent.entry,
            ...(change === "archive"
              ? { archivedAt: Date.now() }
              : { sessionId: "replaced-parent" }),
          });
        }
        return outcome;
      },
    );
    const key = `agent:main:dashboard:direct-parent-${change}-child`;
    await expect(requestChild({ key }, selectedParent.key)).rejects.toThrow(
      change === "replace"
        ? /Spawn parent managed worktree changed|Session access facts are unavailable/
        : "Spawn parent project changed",
    );
    expect(await managedWorktrees.findLiveByOwner("session", key)).toBeUndefined();
    expect(readEntry(key)).toBeUndefined();
    if (change !== "replace") {
      if (!createdPath) {
        throw new Error("Expected the preparation to allocate a checkout");
      }
      await expect(fs.stat(createdPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);

test("worktree spawns do not inherit an unregistered parent working directory", async () => {
  const created = await createSession({ cwd: repository });
  await expectCreationError(requestChild({}, created.key), "agent workspace is not a git checkout");
});

test.each(["empty metadata", "missing worktree target", "partial metadata"])(
  "child sessions preserve %s without inventing a checkout",
  async (damage) => {
    const workspace = path.join(state.root, "non-git-workspace");
    const metadata = path.join(workspace, ".git");
    const contents = "gitdir: missing-worktree\n";
    if (damage === "missing worktree target") {
      await fs.writeFile(metadata, contents);
    } else {
      await fs.mkdir(damage === "partial metadata" ? path.join(metadata, "objects") : metadata, {
        recursive: true,
      });
    }
    await createSession({ key: parentKey });
    if (damage === "empty metadata") {
      const child = await createChild({ worktree: false });
      expect(child.entry.worktree).toBeUndefined();
      const stored = readEntry(child.key);
      expect(stored).toMatchObject({ parentSessionKey: parentKey });
      expect(stored?.pendingWorktree).toBeUndefined();
      expect(await fs.readdir(metadata)).toEqual([]);
      await expect(repositoryPaths.resolveRepositoryPaths(workspace)).rejects.toThrow(
        "not a git checkout",
      );
      await expectCreationError(
        requestChild(),
        "agent workspace is not a git checkout",
        "INVALID_REQUEST",
      );
      return;
    }
    await expectCreationError(
      requestChild(),
      expect.stringContaining("checkout preserved"),
      "UNAVAILABLE",
    );
    if (damage === "missing worktree target") {
      expect(await fs.readFile(metadata, "utf8")).toBe(contents);
    } else {
      expect(await fs.readdir(metadata)).toEqual(["objects"]);
    }
  },
);

test("keyed worktree creation reuses its recorded base after reopening the registry", async () => {
  await git("branch", "selected-base");
  const params = {
    ...parentCreateParams,
    worktreeName: undefined,
    worktreeBaseRef: "selected-base",
    label: "Release planning",
    cwd: repository,
  };
  const allocate = captureMethodCall("createWithOutcome")(ManagedWorktreeService.prototype);
  using allocation = vi
    .spyOn(ManagedWorktreeService.prototype, "createWithOutcome")
    .mockImplementation(function (this: ManagedWorktreeService, input) {
      expect(isSessionMutationActive(storePath, [input.ownerId])).toBe(true);
      return allocate(this, input);
    });
  const created = await createSession(params);
  const parent = created.entry;
  expect(created.worktree).toMatchObject({ branch: "openclaw/release-planning" });
  expect(parent).toMatchObject({
    spawnedCwd: created.worktree.path,
    sessionRoot: created.worktree.path,
  });
  expect(parent.permissionMode).toBeUndefined();
  expect(readEntry(parentKey)?.permissionMode).toBeUndefined();
  await git("branch", "-D", "selected-base");
  await closeStateDatabaseForTest();
  const reused = await createSession(params);
  allocation.mockRestore();
  expect(reused).toMatchObject({
    entry: { sessionId: parent.sessionId },
    worktree: { id: parent.worktree?.id },
  });
  const recorded = await managedWorktrees.findLiveByOwner("session", parentKey);
  expect(recorded).toMatchObject({
    id: created.worktree.id,
    path: created.worktree.path,
    ownerKind: "session",
    ownerId: parentKey,
    baseRef: "selected-base",
  });

  for (const changed of [{ worktreeBaseRef: "HEAD" }, { worktreeName: "other-name" }]) {
    await expectCreationError(
      requestCreation({ ...params, ...changed }),
      expect.stringContaining("already bound"),
      "INVALID_REQUEST",
    );
  }
  const otherRepository = await createRepository(state.root, "other-replay-project");
  await expectCreationError(
    requestCreation({ ...params, cwd: otherRepository }),
    "session worktree belongs to a different repository",
  );
  const foreign = await managedWorktrees.create({
    repoRoot: repository,
    baseRef: "main",
    ownerKind: "manual",
    name: "foreign-owner",
    runSetupScript: false,
  });
  writeEntry(parentKey, {
    ...parent,
    worktree: { id: foreign.id, branch: foreign.branch, repoRoot: foreign.repoRoot },
  });
  await expectCreationError(
    requestCreation(params),
    "session worktree binding has a different owner",
  );
  expect(await managedWorktrees.findLiveByOwner("session", parentKey)).toEqual(recorded);
});

test("trusted cross-agent worktree spawns select the target agent's workspace", async () => {
  await createManagedProjectParent();
  const otherRepository = await createRepository(state.root, "other-project");
  testState.agentsConfig = {
    entries: { main: {}, other: { workspace: otherRepository } },
  };
  const config = await getGatewayConfigModule();
  config.clearRuntimeConfigSnapshot();
  config.clearConfigCache();
  const created = await createChild({ agentId: "other" });
  expect(created.entry.worktree?.repoRoot).toBe(otherRepository);
});

test("parent linkage does not authorize an operator's out-of-workspace source", async () => {
  await createManagedProjectParent();
  const linked = directSessionReq(
    "sessions.create",
    { agentId: "main", label: "Operator child", parentSessionKey: parentKey, worktree: true },
    { client: { connect: { scopes: ["operator.write"] } } as never },
  );
  await expectCreationError(linked, "agent workspace is not a git checkout");
  await expectCreationError(requestChild({ cwd: repository }), "missing scope: operator.admin");
});

test("trusted worktree spawns reject a stale parent registry binding", async () => {
  const { entry: parent } = await createManagedProjectParent();
  writeEntry(parentKey, { ...parent, worktree: { ...parent.worktree!, id: "another-worktree" } });
  await expect(requestChild()).rejects.toThrow("Spawn parent managed worktree changed");
});

test("publishes a failed worktree spawn only after its durable session failure", async () => {
  await createManagedProjectParent();
  const key = "agent:main:dashboard:failed-worktree-child";
  const target = { agentId: "main", sessionKey: key, storePath };
  const preparation = createDeferredCore<never>();
  void preparation.promise.catch(() => {});
  const preparationStarted = createDeferredCore();
  const createWorktree = vi
    .spyOn(ManagedWorktreeService.prototype, "createWithOutcome")
    .mockImplementationOnce(() => {
      preparationStarted.resolve();
      return preparation.promise;
    });
  const failure = new Error(
    "git ls-tree -r --format=%(objectsize) c79ad267ba623c1a323f1f6e8b60228bd5a30ce5 -- failed (timed out after 120 seconds; signal SIGTERM):\n4514\n4168\nCheck repository access and disk space.",
  );
  let registryStartedAt = 0;
  let publishedEntry: SessionEntry | undefined;
  let registryProjection: Promise<void> | undefined;
  const context = {
    ...runtimeContext(),
    broadcast: vi.fn((event: string, payload: unknown) => {
      if (
        event !== "chat" ||
        !isRecord(payload) ||
        payload.state !== "error" ||
        typeof payload.runId !== "string"
      ) {
        return;
      }
      publishedEntry = loadSessionEntry(target);
      // The completion waiter observes the terminal after the spawn ACK registered
      // its own later start time. Exercise the real registry projection as it settles.
      registryProjection = persistSubagentSessionTiming({
        runId: payload.runId,
        childSessionKey: key,
        requesterSessionKey: parentKey,
        requesterDisplayKey: parentKey,
        task: "Read README.md",
        cleanup: "keep",
        createdAt: registryStartedAt,
        sessionStartedAt: registryStartedAt,
        execution: {
          status: "terminal",
          startedAt: registryStartedAt,
          endedAt: Date.now(),
          outcome: { status: "error", error: String(failure) },
        },
        completion: { required: false },
        delivery: { status: "not_required" },
        endedReason: "subagent-error",
      });
    }),
  };
  const client = spawnClient();
  try {
    const created = await createChild(
      { key, label: "Failed worktree child", worktreeName: "failed-child", task: "Read README.md" },
      parentKey,
      { client: { ...client, connect: connection(true) }, context },
    );
    expect(created.runStarted).toBe(true);
    const { runId, sessionId } = created;
    const admittedRun = rpcSourceTesting.get(runId)!;
    expect(admittedRun.input.claim).toBeUndefined();
    registryStartedAt = Date.now() + 1;
    const released = captureSessionControllerSettlement({ scope: storePath, identities: [key] });
    expect(released).toBeDefined();
    expect(loadSessionEntry(target)?.pendingWorktree?.workspace).toBe(repository);
    await preparationStarted.promise;
    expect(createWorktree).toHaveBeenCalledOnce();
    preparation.reject(failure);
    await withTimeout(released!, SESSION_CONTROLLER_DRAIN_TIMEOUT_MS, "failed workspace proof");
    await registryProjection;

    expect.soft(publishedEntry).toMatchObject({
      sessionId,
      status: "failed",
      lastRunId: runId,
      lastRunError: expect.stringContaining("git ls-tree"),
    });
    expect.soft(loadSessionEntry(target)).toMatchObject({
      status: "failed",
      lastRunId: runId,
      lastRunError: expect.stringContaining("timed out after 120 seconds"),
    });
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    const notices = (await loadTranscriptEvents({ ...target, sessionId })).filter(
      (event) => isRecord(event) && event.customType === "run-failed-before-reply",
    );
    expect(notices).toMatchObject([
      { details: { runId, error: expect.stringContaining("git ls-tree") }, display: true },
    ]);
    const listed = await directSessionReq<{
      sessions: Array<{ key: string; lastRunError?: string }>;
    }>("sessions.list", { agentId: "main" }, adminRequest);
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    expect(listed.payload?.sessions.find((row) => row.key === key)).toMatchObject({
      lastRunError: expect.stringContaining("git ls-tree"),
    });
  } finally {
    preparation.reject(failure);
    await settleWorkspaceRuns(context, storePath, key, true);
    await registryProjection;
  }
});

test.each(["archive", "stale-child"] as const)(
  "deferred worktree preparation follows its child owner after %s",
  async (change) => {
    const { entry: parent } = await createManagedProjectParent();
    const chatSendOwner = await import("./server-methods/chat-send-external-entry.js");
    const initialSend = vi
      .spyOn(chatSendOwner, "handleDirectExternalChatSend")
      .mockImplementation(async ({ respond }) => {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "initial turn unavailable"));
      });
    const key = `agent:main:dashboard:deferred-${change}`;
    await createChild({ key, task: "Read README.md" });
    const acceptedChild = readEntry(key)!;
    expect(acceptedChild.pendingWorktree?.workspace).toBe(repository);
    expect(acceptedChild.worktree).toBeUndefined();
    expect(await managedWorktrees.findLiveByOwner("session", key)).toBeUndefined();
    initialSend.mockRestore();
    const context = runtimeContext();
    const operator = { ...controlUiClient, context };
    if (change === "archive") {
      await accepted(
        directSessionReq(
          "sessions.patch",
          {
            key: parentKey,
            archived: true,
            expectedSessionId: parent.sessionId,
          },
          operator,
        ),
      );
      expect(readEntry(parentKey)?.archivedAt).toBeDefined();
    }
    mockDispatch();
    const resolveRepository = vi.spyOn(repositoryPaths, "resolveRepositoryPaths");
    const createWorktree = vi.spyOn(ManagedWorktreeService.prototype, "createWithOutcome");
    let replaced = false;
    const unsubscribe = onAgentEvent((event) => {
      if (
        change === "stale-child" &&
        !replaced &&
        event.sessionKey === key &&
        event.data.phase === "preparing_workspace"
      ) {
        replaced = true;
        writeEntry(key, {
          ...acceptedChild,
          sessionId: "replacement-child",
        });
      }
    });
    try {
      await accepted(
        directSessionReq(
          "chat.send",
          {
            agentId: "main",
            sessionKey: key,
            message: "Continue the accepted task",
            idempotencyKey: `retry-deferred-${change}`,
          },
          operator,
        ),
      );
      await settleWorkspaceRuns(context, storePath, key);
      const child = readEntry(key)!;
      if (change === "stale-child") {
        expect(replaced).toBe(true);
        expect(resolveRepository).not.toHaveBeenCalled();
        expect(createWorktree).not.toHaveBeenCalled();
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(child).toMatchObject({ sessionId: "replacement-child" });
        expect(child.worktree).toBeUndefined();
      } else {
        expect(child).toMatchObject({
          sessionId: acceptedChild.sessionId,
          parentSessionId: parent.sessionId,
          worktree: { repoRoot: repository },
        });
        expect(child.pendingWorktree).toBeUndefined();
        const owned = (await managedWorktrees.findLiveByOwner("session", key))!;
        expect(owned.id).toBe(child.worktree?.id);
        expect(await readReadme(owned.path)).toBe("selected-project\n");
        await expect(fs.stat(path.join(owned.path, "setup-marker.txt"))).rejects.toThrow();
        expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      }
    } finally {
      unsubscribe();
      await settleWorkspaceRuns(context, storePath, key, true);
      dispatchInboundMessageMock.mockReset();
    }
  },
);

test("an existing child row does not replace an unaccepted parent project source", async () => {
  const selectedParent = await createDirectProjectParent();
  const key = "agent:main:dashboard:unaccepted-parent-source";
  await createChild({ key, worktree: false }, selectedParent.key);
  const child = readEntry(key);
  if (!child) {
    throw new Error("Expected the initial child row");
  }
  expect(child.worktree).toBeUndefined();
  expect(child.pendingWorktree).toBeUndefined();
  expect(await removeProjectRegistry(selectedParent.project)).toBe(true);

  await expect(requestChild({ key }, selectedParent.key)).rejects.toThrow(
    "Spawn parent project changed",
  );
  expect(await managedWorktrees.findLiveByOwner("session", key)).toBeUndefined();
  expect(readEntry(key)).toMatchObject({
    sessionId: child.sessionId,
  });
  expect(readEntry(key)?.worktree).toBeUndefined();
});
