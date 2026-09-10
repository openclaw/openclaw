import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { waitForFile } from "../../test/helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import {
  interruptSessionWorkAdmissions,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import {
  controlUiClient,
  initializeRepository,
  settleWorkspaceRuns,
} from "./server.sessions.create.projects.test-support.js";
import { dispatchInboundMessageMock, testState } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const titleMocks = vi.hoisted(() => ({ generate: vi.fn(), open: vi.fn(), lookup: vi.fn() }));
vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback: titleMocks.generate,
}));
vi.mock("../plugins/session-discussion-registry.js", () => ({
  getSessionDiscussionProvider: () => {
    titleMocks.lookup();
    return { id: "synthetic", open: titleMocks.open };
  },
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
afterEach(() => {
  titleMocks.generate.mockReset();
  titleMocks.open.mockReset();
  titleMocks.lookup.mockReset();
  dispatchInboundMessageMock.mockReset();
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
});

test.each(["keep", "delete"] as const)(
  "names a remote session without blocking placement or deletion (%s)",
  async (outcome) => {
    const naming = createDeferredCore<string>();
    titleMocks.generate.mockReturnValue(naming.promise);
    const { storePath } = await createSessionStoreDir();
    const context = {
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set(["title-listener"]),
      chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
    };
    let key: string | undefined;
    try {
      const created = await directSessionReq<{ key: string; runStarted: boolean }>(
        "sessions.create",
        {
          agentId: "main",
          repository: { url: "https://github.com/openclaw/openclaw.git" },
          titleSource: "Explain how the updater safely rolls back a failed release",
        },
        { ...controlUiClient, context },
      );
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(created.payload?.runStarted).toBe(false);
      key = created.payload!.key;
      await vi.waitFor(() => expect(titleMocks.generate).toHaveBeenCalledOnce());
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.displayName,
      ).toBeUndefined();
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      // Cloud dispatch uses this drain before provisioning; optional naming cannot hold it.
      expect(
        await interruptSessionWorkAdmissions({
          scope: storePath,
          identities: [key],
          timeoutMs: 100,
        }),
      ).toBe(true);
      if (outcome === "delete") {
        const deleted = await directSessionReq<{ deleted: boolean }>("sessions.delete", { key });
        expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
        expect(deleted.payload?.deleted).toBe(true);
      }
      naming.resolve("Explain safe updater rollback");
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      if (outcome === "delete") {
        expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
        return;
      }
      await vi.waitFor(() =>
        expect(
          loadSessionEntry({ agentId: "main", sessionKey: key!, storePath })?.displayName,
        ).toBe("Explain safe updater rollback"),
      );
      await vi.waitFor(() =>
        expect(context.broadcastToConnIds).toHaveBeenCalledWith(
          "sessions.changed",
          expect.objectContaining({ sessionKey: key, reason: "chat.title" }),
          expect.anything(),
          expect.anything(),
        ),
      );
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      naming.resolve("Explain safe updater rollback");
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      await settleWorkspaceRuns(context, storePath, key);
    }
  },
);

test.each(["adopted", "incognito"] as const)(
  "creation title input leaves an %s session unnamed",
  async (kind) => {
    const { storePath } = await createSessionStoreDir();
    const key = "agent:main:dashboard:adopted-title";
    const params = { agentId: "main", ...(kind === "incognito" ? { incognito: true } : { key }) };
    const client = { client: { connect: { scopes: ["operator.admin"] } } as never };
    if (kind === "adopted") {
      expect((await directSessionReq("sessions.create", params, client)).ok).toBe(true);
    }
    const result = await directSessionReq<{ key: string }>(
      "sessions.create",
      { ...params, titleSource: "A different task must not name this existing conversation" },
      client,
    );
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    await settleWorkspaceRuns({ chatAbortControllers: new Map() }, storePath, key);
    expect(titleMocks.generate).not.toHaveBeenCalled();
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: result.payload!.key, storePath })
        ?.displayName,
    ).toBeUndefined();
  },
);

test("successful naming survives setup failure and is shared with discussion open and retry", async () => {
  const naming = createDeferredCore<string>();
  titleMocks.generate.mockReturnValue(naming.promise);
  titleMocks.open.mockResolvedValue({ state: "available" });
  const root = tempDirs.make("openclaw-session-worktree-retry-scope-");
  const workspace = await initializeRepository(root, "workspace");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const setup = path.join(workspace, ".openclaw");
  await fs.mkdir(setup);
  const starts = path.join(setup, "starts");
  await fs.writeFile(
    path.join(setup, "worktree-setup.sh"),
    '#!/bin/sh\necho started >> "$OPENCLAW_SOURCE_TREE_PATH/.openclaw/starts"\nexit 1\n',
    { mode: 0o755 },
  );
  const context = {
    broadcast: vi.fn(),
    chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
    dedupe: new Map(),
  };
  dispatchInboundMessageMock.mockResolvedValue({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  });
  let key: string | undefined;
  try {
    const created = await directSessionReq<{
      key: string;
      runId: string;
      sessionId: string;
      runStarted: boolean;
    }>(
      "sessions.create",
      {
        agentId: "main",
        message: "Start work in the checkout",
        worktree: true,
      },
      { client: { connect: { scopes: ["operator.admin"] } } as never, context },
    );
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.runStarted).toBe(true);
    key = created.payload!.key;
    await vi.waitFor(() => expect(titleMocks.generate).toHaveBeenCalledOnce());
    const discussion = directSessionReq(
      "session.discussion.open",
      { sessionKey: key },
      { ...controlUiClient, context },
    );
    await vi.waitFor(() => expect(titleMocks.lookup).toHaveBeenCalledOnce());
    expect(titleMocks.open).not.toHaveBeenCalled();
    expect(titleMocks.generate).toHaveBeenCalledOnce();
    naming.resolve("Workspace repair plan");
    expect((await discussion).ok).toBe(true);
    await waitForFile(starts, SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS);
    await settleWorkspaceRuns(context, storePath, key);
    expect(context.broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: created.payload!.runId,
        state: "error",
        errorMessage: expect.stringContaining("worktree setup failed"),
      }),
      expect.anything(),
    );
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.displayName).toBe(
      "Workspace repair plan",
    );
    expect(titleMocks.generate).toHaveBeenCalledOnce();

    const retried = await directSessionReq(
      "chat.send",
      {
        agentId: "main",
        sessionKey: key,
        message: "Continue without repository setup",
        idempotencyKey: "write-only-setup-retry",
      },
      { ...controlUiClient, context },
    );
    expect(retried.ok, JSON.stringify(retried.error)).toBe(true);
    await settleWorkspaceRuns(context, storePath, key);
    expect(await fs.readFile(starts, "utf8")).toBe("started\n");
    expect(titleMocks.generate).toHaveBeenCalledOnce();
    expect(managedWorktrees.findLiveByOwner("session", key)?.branch).toContain(
      "workspace-repair-plan",
    );
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    const entry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    expect(entry).toMatchObject({
      sessionId: created.payload!.sessionId,
      worktree: { canonicalWorkspaceDir: workspace },
    });
    expect(entry).not.toHaveProperty("pendingWorktree");
  } finally {
    naming.resolve("Workspace repair plan");
    await settleWorkspaceRuns(context, storePath, key, true);
    const owned = key ? managedWorktrees.findLiveByOwner("session", key) : undefined;
    if (owned) {
      await managedWorktrees.remove({
        id: owned.id,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
  }
});

test("sessions.create rejects another plugin's session before naming or worktree preparation", async () => {
  const root = tempDirs.make("openclaw-session-protected-title-");
  const workspace = await initializeRepository(root, "workspace");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:protected-title";
  const scope = { agentId: "main", sessionKey, storePath };
  const client = {
    connect: { scopes: ["operator.admin"] },
    internal: { pluginRuntimeOwnerId: "synthetic-owner" },
  };
  const created = await directSessionReq(
    "sessions.create",
    { agentId: "main", key: sessionKey },
    { client: client as never },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const entry = loadSessionEntry(scope);
  expect(entry?.pluginOwnerId).toBe("synthetic-owner");
  titleMocks.generate.mockResolvedValue("Protected title");
  const result = await directSessionReq(
    "sessions.create",
    { agentId: "main", key: sessionKey, worktree: true, message: "Inspect this repository" },
    {
      client: { ...client, internal: { pluginRuntimeOwnerId: "synthetic-requester" } } as never,
    },
  );
  expect(result.ok).toBe(false);
  expect(result.error?.message).toContain("did not create it");
  expect(titleMocks.generate).not.toHaveBeenCalled();
  expect(loadSessionEntry(scope)).toEqual(entry);
  expect(managedWorktrees.findLiveByOwner("session", sessionKey)).toBeUndefined();
});
