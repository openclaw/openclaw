import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { findLiveRegistryWorktreeByOwner } from "../agents/worktrees/registry.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import {
  copyGitWorkspace,
  createGitWorkspace,
  settleWorkspaceRuns,
  waitForCreatedSessionRun,
} from "./server.sessions.create.projects.test-support.js";
import {
  setupSessionCreateTestHarness,
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
import { sessionStoreEntry, directSessionReq } from "./test/server-sessions.test-helpers.js";

let gitWorkspaceTemplate: string;
const { createSessionStoreDir, withSessionTestState } = setupSessionCreateTestHarness(
  async (makeTempDir) => {
    gitWorkspaceTemplate = await createGitWorkspace(makeTempDir("openclaw-session-git-template-"));
  },
);
const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function managedWorktreeFixture(params: {
  id: string;
  name: string;
  ownerId: string;
  path: string;
  repoRoot: string;
}): NonNullable<ReturnType<typeof managedWorktrees.findLiveById>> {
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

test.each([
  {
    name: "agent default",
    request: {},
    catalogTarget: undefined,
    parentEntry: undefined,
    expectedEntry: {},
    expectedTitleSelection: { regularModelRef: "openai/gpt-5.6-luna" },
  },
  {
    name: "explicit model",
    request: { model: "anthropic/sonnet-4.6@work" },
    catalogTarget: undefined,
    parentEntry: undefined,
    expectedEntry: {
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      authProfileOverride: "work",
    },
    expectedTitleSelection: {
      regularModelRef: "anthropic/claude-sonnet-4-6@work",
      preferredProfile: "work",
    },
  },
  {
    name: "registered catalog target",
    request: { catalogId: "claude" },
    catalogTarget: {
      model: "anthropic/sonnet-4.6@catalog-work",
      agentRuntime: "claude-cli",
    },
    parentEntry: undefined,
    expectedEntry: {
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      agentRuntimeOverride: "claude-cli",
      authProfileOverride: "catalog-work",
    },
    expectedTitleSelection: {
      regularModelRef: "anthropic/claude-sonnet-4-6@catalog-work",
      agentHarnessRuntimeOverride: "claude-cli",
      preferredProfile: "catalog-work",
    },
  },
  {
    name: "inherited parent",
    request: { parentSessionKey: "main" },
    catalogTarget: undefined,
    parentEntry: {
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
      modelOverrideSource: "user" as const,
      agentRuntimeOverride: "codex",
      authProfileOverride: "parent-work",
      authProfileOverrideSource: "user" as const,
    },
    expectedEntry: {
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
      agentRuntimeOverride: "codex",
      authProfileOverride: "parent-work",
    },
    expectedTitleSelection: {
      regularModelRef: "openai/gpt-5.6-sol@parent-work",
      agentHarnessRuntimeOverride: "codex",
      preferredProfile: "parent-work",
    },
  },
])(
  "sessions.create shares a title routed through the $name selection with its worktree and first chat send",
  async ({ request, catalogTarget, parentEntry, expectedEntry, expectedTitleSelection }) =>
    await withSessionTestState({ layout: "state-only" }, async (state) => {
      const workspace = await copyGitWorkspace(gitWorkspaceTemplate, state.root);
      testState.agentConfig = {
        workspace,
        model: { primary: "openai/gpt-5.6-luna" },
      };
      agentDiscoveryMock.enabled = true;
      agentDiscoveryMock.models = [
        { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", provider: "openai" },
        { id: "gpt-5.6-sol", name: "GPT 5.6 Sol", provider: "openai" },
        { id: "sonnet-4.6", name: "Sonnet 4.6", provider: "anthropic" },
      ];
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
        registry.cliBackends.push({
          pluginId: "anthropic",
          source: "test",
          backend: {
            id: "claude-cli",
            modelProvider: "anthropic",
            config: { command: "claude" },
            bundleMcp: false,
          },
        });
        setActivePluginRegistry(registry);
      }
      const { storePath } = await createSessionStoreDir();
      if (parentEntry) {
        await writeSessionStore({
          entries: { main: sessionStoreEntry("worktree-title-parent", parentEntry) },
        });
      }
      let sessionKey: string | undefined;
      const pastedText = `Pasted deployment plan ${"x".repeat(2_000)}`;
      const context = { chatAbortControllers: new Map<string, ChatAbortControllerEntry>() };
      const message = "Review this rollout [[reply_to_current]]";
      const attachment = {
        type: "file",
        mimeType: "text/plain",
        content: Buffer.from(pastedText).toString("base64"),
      };
      dashboardTitleGenerationMocks.generate.mockResolvedValueOnce("Attachment Repair");
      const dispatchCountBefore = dispatchInboundMessageMock.mock.calls.length;
      dispatchInboundMessageMock.mockResolvedValueOnce({
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
      });
      try {
        const created = await directSessionReq<{
          key: string;
          entry: {
            providerOverride?: string;
            modelOverride?: string;
            agentRuntimeOverride?: string;
            authProfileOverride?: string;
          };
          runId: string;
          runStarted: boolean;
        }>(
          "sessions.create",
          {
            agentId: "main",
            worktree: true,
            message,
            attachments: [attachment],
            ...request,
          },
          { client: { connect: { scopes: ["operator.admin"] } } as never, context },
        );

        expect(created.ok, JSON.stringify(created.error)).toBe(true);
        expect(created.payload?.entry).toMatchObject(expectedEntry);
        expect(created.payload, JSON.stringify(created.payload)).toMatchObject({
          runStarted: true,
        });
        sessionKey = requireNonEmptyString(created.payload?.key, "created session key");
        expect(await waitForCreatedSessionRun(context, storePath, sessionKey)).toBe(true);
        expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
          displayName: "Attachment Repair",
          worktree: { branch: "openclaw/attachment-repair" },
        });
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatchCountBefore + 1);
        expect(dashboardTitleGenerationMocks.generate).toHaveBeenCalledWith(
          expect.objectContaining(expectedTitleSelection),
        );
        expect(dashboardTitleGenerationMocks.generate).toHaveBeenCalledOnce();
      } finally {
        await settleWorkspaceRuns(context, storePath, sessionKey, true);
        await removeSessionWorktree(sessionKey);
        setActivePluginRegistry(createEmptyPluginRegistry());
        testState.agentConfig = undefined;
      }
    }),
);

test("sessions.create does not start title generation for a model denied by policy", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-worktree-title-denied-model-",
  });
  const workspace = await copyGitWorkspace(gitWorkspaceTemplate, openClawState.root);
  testState.agentConfig = {
    workspace,
    model: { primary: "openai/gpt-5.6-luna" },
    models: { "openai/gpt-5.6-luna": {} },
  };
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", provider: "openai" },
    { id: "sonnet-4.6", name: "Sonnet 4.6", provider: "anthropic" },
  ];
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:denied-title-route";
  try {
    const created = await directSessionReq(
      "sessions.create",
      {
        agentId: "main",
        key,
        model: "anthropic/sonnet-4.6@work",
        worktree: true,
        message: "Keep this title source on an allowed route",
      },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok).toBe(false);
    expect(created.error?.message).toContain("model not allowed");
    expect(dashboardTitleGenerationMocks.generate).not.toHaveBeenCalled();
    expect(findLiveRegistryWorktreeByOwner(process.env, "session", key)).toBeUndefined();
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
  } finally {
    await disposeSessionReadContexts();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.create keeps the crustacean fallback when no title source exists", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-worktree-empty-title-",
  });
  const workspace = await copyGitWorkspace(gitWorkspaceTemplate, openClawState.root);
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  let worktreeId: string | undefined;
  try {
    const created = await directSessionReq<{ worktree: { id: string; branch: string } }>(
      "sessions.create",
      { agentId: "main", worktree: true },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    worktreeId = created.payload?.worktree.id;
    expect(created.payload?.worktree.branch).toMatch(
      /^openclaw\/[a-z]+-(?:barnacle|claw|crab|crayfish|krill|langoustine|lobster|prawn|shrimp|shell)$/,
    );
    expect(dashboardTitleGenerationMocks.generate).not.toHaveBeenCalled();
  } finally {
    if (worktreeId) {
      await managedWorktrees.remove({
        id: worktreeId,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
    await disposeSessionReadContexts();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test.each(["packages/app", "..notes"])(
  "sessions.create maps worktree options and preserves nested workspace cwd %s",
  async (workspaceRelativePath) => {
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-session-worktree-options-",
    });
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
    const createSpy = vi.spyOn(managedWorktrees, "createWithOutcome").mockResolvedValue({
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
      const created = await directSessionReq<{
        entry: {
          permissionMode?: string;
          sessionRoot?: string;
          spawnedCwd?: string;
          worktree?: { id: string; branch: string; repoRoot: string };
        };
        worktree: { id: string; path: string; branch: string };
      }>(
        "sessions.create",
        {
          agentId: "main",
          key,
          worktree: true,
          worktreeName: "target-task",
          worktreeBaseRef: "base-branch",
          permissionMode: "workspace",
        },
        { client: { connect: { scopes: ["operator.admin"] } } as never },
      );

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

      const rejected = await directSessionReq(
        "sessions.create",
        { agentId: "main", worktreeName: "no-flag" },
        { client: { connect: { scopes: ["operator.admin"] } } as never },
      );
      expect(rejected.ok).toBe(false);
    } finally {
      createSpy.mockRestore();
      await disposeSessionReadContexts();
      testState.agentConfig = undefined;
      await openClawState.cleanup();
    }
  },
);

test("sessions.create maps an admin-selected worktree cwd and rejects repository changes", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-selected-workspace-",
  });
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
    .spyOn(managedWorktrees, "createWithOutcome")
    .mockResolvedValue({ record, materialized: true });
  const findSpy = vi.spyOn(managedWorktrees, "findLiveById").mockReturnValue(record);
  try {
    const created = await directSessionReq<{
      entry: {
        spawnedCwd?: string;
        worktree?: { canonicalWorkspaceDir?: string };
      };
      worktree: { id: string; path: string };
    }>(
      "sessions.create",
      { agentId: "main", key, worktree: true, cwd: selectedWorkspace },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

    expect(created.ok).toBe(true);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: selectedWorkspace }),
    );
    expect(created.payload?.entry.spawnedCwd).toBe(worktreePath);
    expect(created.payload?.entry.worktree?.canonicalWorkspaceDir).toBe(selectedWorkspace);

    const mismatched = await directSessionReq(
      "sessions.create",
      { key, agentId: "main", worktree: true, cwd: configuredWorkspace },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );
    expect(mismatched).toMatchObject({
      ok: false,
      error: { message: "session worktree belongs to a different repository" },
    });
  } finally {
    createSpy.mockRestore();
    findSpy.mockRestore();
    await disposeSessionReadContexts();
    testState.agentConfig = undefined;
    await openClawState.cleanup();
  }
});

test("sessions.create skips the worktree setup script for non-admin callers", async () => {
  await expectNonAdminWorktreeSetupIsSkipped({
    workspaceTemplate: gitWorkspaceTemplate,
    prepareSessionStore: createSessionStoreDir,
  });
});
