import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { captureMethodCall } from "../../test/helpers/capture-method-call.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { findLiveRegistryWorktreeByOwner } from "../agents/worktrees/registry.test-support.js";
import { ManagedWorktreeService } from "../agents/worktrees/service.js";
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
    workspaceRelativePath: "..notes/app",
    selectWorkspace: false,
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
    workspaceRelativePath: "",
    selectWorkspace: true,
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
    {
      request,
      catalogTarget,
      parentEntry,
      expectedEntry,
      expectedTitleSelection,
      workspaceRelativePath,
      selectWorkspace,
    },
    { signal },
  ) =>
    await withSessionTestState({ layout: "state-only" }, async (state) => {
      const configuredWorkspace = await copyGitWorkspace(gitWorkspaceTemplate, state.root);
      const sourceRoot = selectWorkspace
        ? await copyGitWorkspace(
            gitWorkspaceTemplate,
            tempDirs.make("openclaw-session-selected-repository-", await fs.realpath(os.tmpdir())),
          )
        : configuredWorkspace;
      const workspace = path.join(sourceRoot, workspaceRelativePath);
      await fs.mkdir(workspace, { recursive: true });
      configureModels(selectWorkspace ? configuredWorkspace : workspace);
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
            permissionMode: "workspace",
            ...(selectWorkspace ? { cwd: workspace } : {}),
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
        const materialized = findLiveRegistryWorktreeByOwner(process.env, "session", sessionKey);
        const worktreePath = requireNonEmptyString(materialized?.path, "materialized worktree");
        const executionCwd = requireNonEmptyString(entry?.spawnedCwd, "created execution cwd");
        expect(materialized?.repoRoot).toBe(sourceRoot);
        expect(entry).toMatchObject({ permissionMode: "workspace", sessionRoot: worktreePath });
        expect(executionCwd).toBe(path.join(worktreePath, workspaceRelativePath));
        await expect(fs.stat(executionCwd)).resolves.toBeDefined();
        if (selectWorkspace) {
          expect(entry?.worktree?.canonicalWorkspaceDir).toBe(sourceRoot);
        }
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

test("sessions.create skips the worktree setup script for non-admin callers", async () => {
  await expectNonAdminWorktreeSetupIsSkipped({
    workspaceTemplate: gitWorkspaceTemplate,
    prepareSessionStore: createSessionStoreDir,
  });
});
