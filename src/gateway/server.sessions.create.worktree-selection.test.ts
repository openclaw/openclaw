import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { captureMethodCall } from "../../test/helpers/capture-method-call.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as registryReads from "../agents/worktrees/registry-read.js";
import { findLiveRegistryWorktreeByOwner } from "../agents/worktrees/registry.test-support.js";
import { ManagedWorktreeService } from "../agents/worktrees/service.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import {
  copyGitWorkspace,
  createGitWorkspace,
  settleWorkspaceRuns,
  waitForCreatedSessionRun,
} from "./server.sessions.create.projects.test-support.js";
import {
  setupSessionCreateHandlerTestHarness,
  dashboardTitleGenerationMocks,
  requireNonEmptyString,
  removeSessionWorktree,
} from "./server.sessions.create.test-support.js";
import { expectNonAdminWorktreeSetupIsSkipped } from "./server.sessions.create.worktree-scope.test-support.js";
import {
  agentDiscoveryMock,
  dispatchInboundMessageMock,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { createClaudeCliRegistrationFixture } from "./test-helpers.plugin-registry.js";
import { sessionStoreEntry, directSessionReq } from "./test/server-sessions.test-helpers.js";

let gitWorkspaceTemplate: string;
const { createSessionStoreDir, withSessionTestState } = setupSessionCreateHandlerTestHarness(
  async (makeTempDir) => {
    gitWorkspaceTemplate = await createGitWorkspace(makeTempDir("openclaw-session-git-template-"));
  },
);
const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type CreatedSession = { key: string; entry: SessionEntry; runId: string; runStarted: boolean };
const createSession = (params: Record<string, unknown>, context?: Record<string, unknown>) =>
  directSessionReq<CreatedSession>(
    "sessions.create",
    { agentId: "main", ...params },
    {
      client: { connect: { scopes: ["operator.admin"] } } as never,
      context,
    },
  );
async function createState(prefix: string) {
  const state = await createOpenClawTestState({ layout: "state-only", prefix });
  onTestFinished(async () => {
    await disposeSessionReadContexts();
    testState.agentConfig = undefined;
    await state.cleanup();
  });
  return state;
}

function managedWorktreeFixture(
  params: Pick<ManagedWorktreeRecord, "id" | "name" | "ownerId" | "path" | "repoRoot">,
): ManagedWorktreeRecord {
  return {
    ...params,
    baseRef: "HEAD",
    branch: `openclaw/${params.name}`,
    createdAt: 1,
    lastActiveAt: 1,
    ownerKind: "session",
    repoFingerprint: "test-repository",
  };
}

function selection(provider: string, model: string, runtime: string, profile: string) {
  return {
    expectedEntry: {
      providerOverride: provider,
      modelOverride: model,
      agentRuntimeOverride: runtime,
      authProfileOverride: profile,
    },
    expectedTitleSelection: {
      regularModelRef: `${provider}/${model}@${profile}`,
      agentHarnessRuntimeOverride: runtime,
      preferredProfile: profile,
    },
  };
}
const parentSelection = selection("openai", "gpt-5.6-sol", "codex", "parent-work");

function configureModels(workspace: string, restricted = false) {
  testState.agentConfig = {
    workspace,
    model: { primary: "openai/gpt-5.6-luna" },
    ...(restricted ? { models: { "openai/gpt-5.6-luna": {} } } : {}),
  };
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", provider: "openai" },
    ...(!restricted ? [{ id: "gpt-5.6-sol", name: "GPT 5.6 Sol", provider: "openai" }] : []),
    { id: "sonnet-4.6", name: "Sonnet 4.6", provider: "anthropic" },
  ];
}

test.for([
  {
    name: "registered catalog target",
    request: { catalogId: "claude" },
    catalogTarget: {
      model: "anthropic/sonnet-4.6@catalog-work",
      agentRuntime: "claude-cli",
    },
    parentEntry: undefined,
    ...selection("anthropic", "claude-sonnet-4-6", "claude-cli", "catalog-work"),
  },
  {
    name: "inherited parent",
    request: { parentSessionKey: "main" },
    catalogTarget: undefined,
    parentEntry: {
      ...parentSelection.expectedEntry,
      modelOverrideSource: "user" as const,
      authProfileOverrideSource: "user" as const,
    },
    ...parentSelection,
  },
])(
  "sessions.create names its session during checkout preparation through the $name selection",
  async (
    { request, catalogTarget, parentEntry, expectedEntry, expectedTitleSelection },
    { signal },
  ) =>
    await withSessionTestState({ layout: "state-only" }, async (state) => {
      const workspace = await copyGitWorkspace(gitWorkspaceTemplate, state.root);
      configureModels(workspace);
      if (catalogTarget) {
        const registry = createEmptyPluginRegistry();
        registry.sessionCatalogs.push({
          pluginId: "anthropic",
          source: "test",
          provider: {
            id: "claude",
            label: "Claude Code",
            resolveCreateSession: () => catalogTarget,
            list: vi.fn(async () => []),
            read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
          },
        });
        registry.cliBackends.push(createClaudeCliRegistrationFixture());
        setActivePluginRegistry(registry);
      }
      const { storePath } = await createSessionStoreDir();
      if (parentEntry) {
        await writeSessionStore({
          entries: { main: sessionStoreEntry("worktree-title-parent", parentEntry) },
        });
      }
      let sessionKey: string | undefined;
      const titlePersisted = createDeferredCore();
      const preparingWorkspace = createDeferredCore();
      const releaseWorkspace = createDeferredCore();
      const createWorktree = captureMethodCall("createWithOutcome")(
        ManagedWorktreeService.prototype,
      );
      const worktreeSpy = vi
        .spyOn(ManagedWorktreeService.prototype, "createWithOutcome")
        .mockImplementation(async function (this: ManagedWorktreeService, params) {
          preparingWorkspace.resolve();
          await releaseWorkspace.promise;
          return createWorktree(this, params);
        });
      const checkTitle = () => {
        if (
          sessionKey &&
          loadSessionEntry({ agentId: "main", sessionKey, storePath })?.displayName ===
            "Attachment Repair"
        ) {
          titlePersisted.resolve();
        }
      };
      const stopTitleObserver = sessionChanges.subscribe(checkTitle);
      const context = {};
      const attachment = {
        type: "file",
        mimeType: "text/plain",
        content: Buffer.from(`Pasted deployment plan ${"x".repeat(2_000)}`).toString("base64"),
      };
      dashboardTitleGenerationMocks.generate.mockResolvedValueOnce("Attachment Repair");
      const dispatchCountBefore = dispatchInboundMessageMock.mock.calls.length;
      dispatchInboundMessageMock.mockResolvedValueOnce({
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
      });
      try {
        const created = await createSession(
          {
            worktree: true,
            message: "Review this rollout [[reply_to_current]]",
            attachments: [attachment],
            ...request,
          },
          context,
        );

        expect(created.ok, JSON.stringify(created.error)).toBe(true);
        expect(created.payload?.entry).toMatchObject(expectedEntry);
        expect(created.payload, JSON.stringify(created.payload)).toMatchObject({
          runStarted: true,
        });
        sessionKey = requireNonEmptyString(created.payload?.key, "created session key");
        await withinTest(preparingWorkspace.promise, signal);
        checkTitle();
        await withinTest(titlePersisted.promise, signal);
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatchCountBefore);
        releaseWorkspace.resolve();
        expect(await waitForCreatedSessionRun(context, storePath, sessionKey)).toBe(true);
        const entry = loadSessionEntry({ agentId: "main", sessionKey, storePath });
        expect(entry).toMatchObject({ displayName: "Attachment Repair" });
        expect(entry?.worktree?.branch).toMatch(/^openclaw\/[a-z0-9-]+$/u);
        expect(entry?.worktree?.branch).not.toBe("openclaw/attachment-repair");
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatchCountBefore + 1);
        expect(dashboardTitleGenerationMocks.generate).toHaveBeenCalledWith(
          expect.objectContaining(expectedTitleSelection),
        );
        expect(dashboardTitleGenerationMocks.generate).toHaveBeenCalledOnce();
      } finally {
        stopTitleObserver();
        releaseWorkspace.resolve();
        await settleWorkspaceRuns(context, storePath, sessionKey, true);
        worktreeSpy.mockRestore();
        await removeSessionWorktree(sessionKey);
        setActivePluginRegistry(createEmptyPluginRegistry());
        testState.agentConfig = undefined;
      }
    }),
);

test("sessions.create does not start title generation for a model denied by policy", async () => {
  const openClawState = await createState("openclaw-session-worktree-title-denied-model-");
  const workspace = await copyGitWorkspace(gitWorkspaceTemplate, openClawState.root);
  configureModels(workspace, true);
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:denied-title-route";
  const created = await createSession({
    key,
    model: "anthropic/sonnet-4.6@work",
    worktree: true,
    message: "Keep this title source on an allowed route",
  });

  expect(created.ok).toBe(false);
  expect(created.error?.message).toContain("model not allowed");
  expect(dashboardTitleGenerationMocks.generate).not.toHaveBeenCalled();
  expect(findLiveRegistryWorktreeByOwner(process.env, "session", key)).toBeUndefined();
  expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
});

test("sessions.create maps worktree options and preserves a nested dot-prefixed workspace cwd", async () => {
  const workspaceRelativePath = "..notes/app";
  const openClawState = await createState("openclaw-session-worktree-options-");
  const repoRoot = await copyGitWorkspace(gitWorkspaceTemplate, openClawState.root);
  const workspace = path.join(repoRoot, workspaceRelativePath);
  const worktreePath = path.join(openClawState.root, "managed-worktree");
  const key = "agent:main:dashboard:worktree-options";
  await execFileAsync("git", ["-C", repoRoot, "branch", "base-branch"]);
  await Promise.all([
    fs.mkdir(workspace, { recursive: true }),
    fs.mkdir(worktreePath, { recursive: true }),
  ]);
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  const createSpy = vi
    .spyOn(ManagedWorktreeService.prototype, "createWithOutcome")
    .mockResolvedValue({
      record: managedWorktreeFixture({
        id: "worktree-options",
        name: "target-task",
        ownerId: key,
        path: worktreePath,
        repoRoot,
      }),
      materialized: true,
    });
  try {
    const created = await createSession({
      key,
      worktree: true,
      worktreeName: "target-task",
      worktreeBaseRef: "base-branch",
      permissionMode: "workspace",
    });

    expect(created.ok).toBe(true);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: workspace,
        ownerKind: "session",
        ownerId: key,
        name: "target-task",
        baseRef: "base-branch",
      }),
    );
    expect(created.payload?.entry).toMatchObject({
      permissionMode: "workspace",
      sessionRoot: worktreePath,
      spawnedCwd: path.join(worktreePath, workspaceRelativePath),
      worktree: {
        id: "worktree-options",
        branch: "openclaw/target-task",
        repoRoot,
      },
    });
    await expect(fs.stat(path.join(worktreePath, workspaceRelativePath))).resolves.toBeDefined();

    const rejected = await createSession({ worktreeName: "no-flag" });
    expect(rejected.ok).toBe(false);
  } finally {
    createSpy.mockRestore();
  }
});

test("sessions.create maps an admin-selected worktree cwd", async () => {
  const openClawState = await createState("openclaw-session-selected-workspace-");
  const selectedRoot = tempDirs.make(
    "openclaw-session-selected-repository-",
    await fs.realpath(os.tmpdir()),
  );
  const [configuredWorkspace, selectedWorkspace] = await Promise.all([
    copyGitWorkspace(gitWorkspaceTemplate, openClawState.root),
    copyGitWorkspace(gitWorkspaceTemplate, selectedRoot),
  ]);
  const worktreePath = path.join(openClawState.root, "selected-worktree");
  const key = "agent:main:dashboard:selected-workspace";
  await fs.mkdir(worktreePath, { recursive: true });
  const record = managedWorktreeFixture({
    id: "selected-worktree",
    name: "selected-worktree",
    ownerId: key,
    path: worktreePath,
    repoRoot: selectedWorkspace,
  });
  testState.agentConfig = { workspace: configuredWorkspace };
  await createSessionStoreDir();
  const createSpy = vi
    .spyOn(ManagedWorktreeService.prototype, "createWithOutcome")
    .mockResolvedValue({ record, materialized: true });
  const findSpy = vi.spyOn(registryReads, "readSessionWorktreeBinding").mockResolvedValue(record);
  try {
    const created = await createSession({ key, worktree: true, cwd: selectedWorkspace });

    expect(created.ok).toBe(true);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: selectedWorkspace }),
    );
    expect(created.payload?.entry.spawnedCwd).toBe(worktreePath);
    expect(created.payload?.entry.worktree?.canonicalWorkspaceDir).toBe(selectedWorkspace);
  } finally {
    createSpy.mockRestore();
    findSpy.mockRestore();
  }
});

test("sessions.create skips the worktree setup script for non-admin callers", async () => {
  await expectNonAdminWorktreeSetupIsSkipped({
    workspaceTemplate: gitWorkspaceTemplate,
    prepareSessionStore: createSessionStoreDir,
  });
});
