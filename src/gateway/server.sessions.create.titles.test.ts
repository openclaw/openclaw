import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { interruptSessionControllerEffects } from "../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  controlUiClient,
  initializeRepository,
  removeOwnedSessionWorktree,
  settleWorkspaceRuns,
  successfulSessionRequest as request,
} from "./server.sessions.create.projects.test-support.js";
import { sessionTitleRequests } from "./session-title-state.js";
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
afterEach(async () => {
  await disposeSessionReadContexts();
  titleMocks.generate.mockReset();
  titleMocks.open.mockReset();
  titleMocks.lookup.mockReset();
  dispatchInboundMessageMock.mockReset();
  testState.agentConfig = undefined;
});

const readEntry = (storePath: string, sessionKey: string) =>
  loadSessionEntry({ agentId: "main", sessionKey, storePath });
const adminClient = { client: { connect: { scopes: ["operator.admin"] } } as never };

test("keeps an automatic title through seven follow-ups and accepts an explicit rename", async () => {
  const { storePath } = await createSessionStoreDir();
  const context = { dedupe: new Map() };
  const options = { ...controlUiClient, context };
  dispatchInboundMessageMock.mockResolvedValue({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  });
  const titleStarted = createDeferredCore();
  titleMocks.generate.mockImplementation(() => {
    titleStarted.resolve();
    return "Release planning";
  });
  const { key, sessionId } = await request<{ key: string; sessionId: string }>(
    "sessions.create",
    { agentId: "main", message: "Help me plan the release" },
    options,
  );
  await settleWorkspaceRuns(context, storePath, key);
  await titleStarted.promise;
  await sessionTitleRequests.get({ storePath, sessionKey: key, sessionId });
  expect(readEntry(storePath, key)?.displayName).toBe("Release planning");
  titleMocks.generate.mockResolvedValue("Land PR and archive");
  for (let index = 0; index < 7; index++) {
    await request(
      "chat.send",
      {
        sessionKey: key,
        message: "Land the PR and archive it",
        idempotencyKey: `follow-up-${index}`,
      },
      options,
    );
    await settleWorkspaceRuns(context, storePath, key);
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  }
  expect(readEntry(storePath, key)?.displayName).toBe("Release planning");
  expect(titleMocks.generate).toHaveBeenCalledOnce();
  await request("sessions.patch", { key, label: "My release" }, options);
  expect(readEntry(storePath, key)?.label).toBe("My release");
});

async function workspaceFixture(prefix: string) {
  const workspace = await initializeRepository(tempDirs.make(prefix), "workspace");
  testState.agentConfig = { workspace };
  return { workspace, ...(await createSessionStoreDir()) };
}
async function cleanupWorktree(context: unknown, storePath: string, key?: string) {
  await settleWorkspaceRuns(context, storePath, key, true);
  await removeOwnedSessionWorktree(key);
}

test.for(["keep", "delete"] as const)(
  "names a remote session without blocking placement or deletion (%s)",
  async (outcome, { signal }) => {
    const naming = createDeferredCore<string>();
    const namingStarted = createDeferredCore();
    titleMocks.generate.mockImplementation(() => {
      namingStarted.resolve();
      return naming.promise;
    });
    const { storePath } = await createSessionStoreDir();
    const context = {
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set(["title-listener"]),
    };
    let key: string | undefined;
    try {
      const created = await request<{ key: string; runStarted: boolean }>(
        "sessions.create",
        {
          agentId: "main",
          repository: { url: "https://github.com/openclaw/openclaw.git" },
          titleSource: "Explain how the updater safely rolls back a failed release",
        },
        { ...controlUiClient, context },
      );
      expect(created.runStarted).toBe(false);
      key = created.key;
      await racePromiseWithAbortSignal(namingStarted.promise, signal);
      expect(titleMocks.generate).toHaveBeenCalledOnce();
      expect(readEntry(storePath, key)?.displayName).toBeUndefined();
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      // Cloud dispatch uses this drain before provisioning; optional naming cannot hold it.
      expect(
        await interruptSessionControllerEffects({
          scope: storePath,
          identities: [key],
          timeoutMs: 100,
        }),
      ).toBe(true);
      if (outcome === "delete") {
        expect(await request("sessions.delete", { key })).toMatchObject({ deleted: true });
      }
      naming.resolve("Explain safe updater rollback");
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      if (outcome === "delete") {
        expect(readEntry(storePath, key)).toBeUndefined();
        return;
      }
      await vi.waitFor(() =>
        expect(readEntry(storePath, key!)?.displayName).toBe("Explain safe updater rollback"),
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
    if (kind === "adopted") {
      await request("sessions.create", params, adminClient);
    }
    const result = await request<{ key: string }>(
      "sessions.create",
      { ...params, titleSource: "A different task must not name this existing conversation" },
      adminClient,
    );
    await settleWorkspaceRuns({}, storePath, key);
    expect(titleMocks.generate).not.toHaveBeenCalled();
    expect(readEntry(storePath, result.key)?.displayName).toBeUndefined();
  },
);

test("sessions.create records prepared title provenance only for a new generated display name", async () => {
  const { storePath } = await createSessionStoreDir();
  const client = { client: { connect: { scopes: ["operator.admin"] } } as never };
  const generated = await directSessionReq<{ key: string }>(
    "sessions.create",
    { agentId: "main", displayName: "Prepared title", displayNameSource: "generated" },
    client,
  );
  expect(generated.ok, JSON.stringify(generated.error)).toBe(true);
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: generated.payload!.key, storePath })
      ?.titleRefinement,
  ).toMatchObject({
    sessionId: expect.any(String),
    generatedName: "Prepared title",
    taskMessagesSinceTitle: 0,
    skipNextMessage: true,
  });

  const explicit = await directSessionReq<{ key: string }>(
    "sessions.create",
    { agentId: "main", displayName: "Operator title" },
    client,
  );
  expect(explicit.ok, JSON.stringify(explicit.error)).toBe(true);
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: explicit.payload!.key, storePath })
      ?.titleRefinement,
  ).toBeUndefined();
});

test("successful naming survives setup failure and is shared with discussion open and retry", async () => {
  const naming = createDeferredCore<string>();
  titleMocks.generate.mockReturnValue(naming.promise);
  titleMocks.open.mockResolvedValue({ state: "available" });
  const { workspace, storePath } = await workspaceFixture("openclaw-session-worktree-retry-scope-");
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
    dedupe: new Map(),
  };
  dispatchInboundMessageMock.mockResolvedValue({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  });
  let key: string | undefined;
  try {
    const created = await request<{
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
      { ...adminClient, context },
    );
    expect(created.runStarted).toBe(true);
    key = created.key;
    await settleWorkspaceRuns(context, storePath, key);
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
    await settleWorkspaceRuns(context, storePath, key);
    expect(context.broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: created.runId,
        state: "error",
        errorMessage: expect.stringContaining("worktree setup failed"),
      }),
      expect.anything(),
    );
    expect(await fs.readFile(starts, "utf8")).toBe("started\n");
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(readEntry(storePath, key)?.displayName).toBe("Workspace repair plan");
    expect(titleMocks.generate).toHaveBeenCalledOnce();

    await request(
      "chat.send",
      {
        agentId: "main",
        sessionKey: key,
        message: "Continue without repository setup",
        idempotencyKey: "write-only-setup-retry",
      },
      { ...controlUiClient, context },
    );
    await settleWorkspaceRuns(context, storePath, key);
    expect(await fs.readFile(starts, "utf8")).toBe("started\n");
    expect(titleMocks.generate).toHaveBeenCalledOnce();
    expect((await managedWorktrees.findLiveByOwner("session", key))?.branch).toContain(
      "workspace-repair-plan",
    );
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    const entry = readEntry(storePath, key);
    expect(entry).toMatchObject({
      sessionId: created.sessionId,
      worktree: { canonicalWorkspaceDir: workspace },
    });
    expect(entry).not.toHaveProperty("pendingWorktree");
  } finally {
    naming.resolve("Workspace repair plan");
    await cleanupWorktree(context, storePath, key);
  }
});

test.each(["generator error", "delayed title"])(
  "sessions.create preserves background title recovery after %s",
  async (failure) => {
    const { storePath } = await workspaceFixture("openclaw-session-worktree-recovery-");
    const key = "agent:main:dashboard:worktree-title-fallback";
    const target = { sessionKey: key, storePath };
    const title = createDeferredCore<string>();
    const titleStarted = createDeferredCore();
    const dispatchStarted = createDeferredCore();
    const dispatchFinished = createDeferredCore();
    const preparationFailed = createDeferredCore<Error>();
    const context = {
      broadcast: vi.fn<GatewayRequestContext["broadcast"]>((event, payload) => {
        if (event === "chat" && isRecord(payload) && payload.state === "error") {
          preparationFailed.resolve(
            new Error(
              typeof payload.errorMessage === "string"
                ? payload.errorMessage
                : "Session failed before dispatch",
            ),
          );
        }
      }),
    };
    const waitForPreparation = async (started: Promise<void>) => {
      const error = await Promise.race([started, preparationFailed.promise]);
      if (error) {
        throw error;
      }
    };
    const delayed = failure === "delayed title";
    titleMocks.generate.mockImplementation(() => {
      titleStarted.resolve();
      return delayed ? title.promise : Promise.reject(new Error("boom"));
    });
    dispatchInboundMessageMock.mockImplementationOnce(async () => {
      dispatchStarted.resolve();
      await dispatchFinished.promise;
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
    try {
      const created = await request<{ runStarted: boolean }>(
        "sessions.create",
        {
          agentId: "main",
          key,
          worktree: true,
          message: "Investigate the raw fallback title",
        },
        { ...adminClient, context },
      );

      expect(created.runStarted).toBe(true);
      await waitForPreparation(dispatchStarted.promise);
      await waitForPreparation(titleStarted.promise);
      const branch = loadSessionEntry(target)?.worktree?.branch;
      expect(branch).toMatch(/^openclaw\/[a-z]+-[a-z]+$/);
      expect(titleMocks.generate).toHaveBeenCalledOnce();
      dispatchFinished.resolve();
      await settleWorkspaceRuns(context, storePath, key);
      if (delayed) {
        expect(loadSessionEntry(target)?.displayName).toBeUndefined();
        title.resolve("Late investigation title");
        await vi.waitFor(
          () => expect(loadSessionEntry(target)?.displayName).toBe("Late investigation title"),
          { interval: 1 },
        );
        expect(loadSessionEntry(target)?.worktree?.branch).toBe(branch);
      } else {
        await vi.waitFor(() =>
          expect(loadSessionEntry(target)?.displayName).toMatch(/^[a-z]+-[a-z]+$/),
        );
      }
      expect(loadSessionEntry(target)?.worktree?.branch).toBe(branch);
      expect(titleMocks.generate).toHaveBeenCalledTimes(delayed ? 1 : 2);
    } finally {
      title.resolve("Fixture cleanup");
      dispatchFinished.resolve();
      await cleanupWorktree(context, storePath, key);
    }
  },
);

test("creates a two-word worktree name before an initial turn can generate its title", async () => {
  const { storePath } = await workspaceFixture("openclaw-session-worktree-naming-");
  const context = {
    dedupe: new Map(),
  };
  titleMocks.generate.mockResolvedValue("Canvas video and device presence");
  let key: string | undefined;
  try {
    const created = await request<{ key: string }>(
      "sessions.create",
      {
        agentId: "main",
        worktree: true,
        titleSource: "Can you use the canvas feature to show a video on my screen?",
      },
      { ...controlUiClient, context },
    );
    key = created.key;
    await settleWorkspaceRuns(context, storePath, key);
    const branch = (await managedWorktrees.findLiveByOwner("session", key))?.branch;
    expect(branch).toMatch(/^openclaw\/[a-z]+-[a-z]+$/);
    const entry = readEntry(storePath, key);
    expect(entry?.worktree?.branch).toBe(branch);
  } finally {
    await cleanupWorktree(context, storePath, key);
  }
});

test("sessions.create rejects another plugin's session before naming or worktree preparation", async () => {
  const { storePath } = await workspaceFixture("openclaw-session-protected-title-");
  const sessionKey = "agent:main:dashboard:protected-title";
  const scope = { agentId: "main", sessionKey, storePath };
  const client = {
    connect: { scopes: ["operator.admin"] },
    internal: { pluginRuntimeOwnerId: "synthetic-owner" },
  };
  await request(
    "sessions.create",
    { agentId: "main", key: sessionKey },
    { client: client as never },
  );
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
  expect(await managedWorktrees.findLiveByOwner("session", sessionKey)).toBeUndefined();
});
