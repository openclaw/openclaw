import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  enqueueFollowupRun,
  getFollowupQueueDepth,
  type FollowupRun,
} from "../../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import {
  cfg,
  expectCutFailure,
  expectCutReply,
  holdLifecycle,
  installHarness,
  invokeHandler as invoke,
  messageCutContext as context,
  restrictedOperator,
  sessionKey,
  sourceSessionId,
} from "./sessions-rewind.handler.test-support.js";
import type { GatewayClient } from "./types.js";

const mocks = vi.hoisted(() => ({ readMediaBuffer: vi.fn(), upstreamFork: vi.fn() }));

// mock-isolation: Queued sources stay idle while this boundary cuts history and settles work.
vi.mock("../../auto-reply/reply/queue/drain.js", () => ({
  clearFollowupDrainCallback: vi.fn(),
  dropAbortedFollowups: () => {
    throw new Error("Unexpected followup drain");
  },
  rememberFollowupDrainCallback: () => {
    throw new Error("Unexpected followup drain");
  },
}));
vi.mock("../../auto-reply/reply/queue/delivery-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auto-reply/reply/queue/delivery-context.js")>()),
  createOverflowSummaryRetrySource: () => {
    throw new Error("Unexpected queue overflow");
  },
  resolveFollowupAuthorizationKey: () => {
    throw new Error("Unexpected queue overflow");
  },
  resolveFollowupDeliveryStorageKey: () => {
    throw new Error("Unexpected queue overflow");
  },
}));
vi.mock("../../agents/model-thinking-default.js", () => ({
  resolveThinkingSelection: () => {
    throw new Error("Unexpected model selection refresh");
  },
}));
vi.mock("../../auto-reply/thinking.js", async () => {
  const { normalizeThinkLevel } = await import("../../auto-reply/thinking.shared.js");
  return { normalizeThinkLevel };
});

vi.mock("../../media/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../media/store.js")>();
  return { ...actual, readMediaBuffer: mocks.readMediaBuffer };
});

import { resolveSessionStorePathCore } from "../../config/sessions.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  readSessionEntryReadOnlyInWorker,
  readSessionEntrySummariesInWorker,
} from "../../config/sessions/session-entry-read-runtime.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  captureSessionTarget,
  type SessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import {
  bindSessionControllerSource,
  beginSessionControllerSourceInjection,
} from "../../sessions/session-controller.mailbox.js";
import {
  isRpcSourceRegistered,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import {
  cancelCapturedSessionControllerSource,
  captureSessionControllerStop,
} from "../../sessions/session-controller.stop.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import { upsertSessionUpstreamLink } from "../../sessions/session-upstream-links.js";
import { registerChatAbortController } from "../chat-abort.js";
import { claimRpcSourceForTest, createRpcSourceForTest } from "../test-helpers.rpc-source.js";

// One teardown owns drainage and deletion so a failed drain retains the fixture root.
const tempDirs = createTempDirTracker();
const storedImageId = "stored-image.png";
const storedImagePath = `/state/media/inbound/${storedImageId}`;
const storedImageData = Buffer.from("stored-image");

beforeEach(async () => {
  mocks.readMediaBuffer.mockReset().mockImplementation(async (id: string) => {
    if (id !== storedImageId) {
      throw new Error(`missing media: ${id}`);
    }
    return {
      id,
      path: storedImagePath,
      buffer: storedImageData,
      size: storedImageData.byteLength,
    };
  });
  setActivePluginRegistry(createEmptyPluginRegistry());
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-rewind-handler-"));
  setRuntimeConfigSnapshot(cfg);
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    { sessionId: sourceSessionId, updatedAt: Date.now() },
  );
  const scope = { agentId: "main", sessionId: sourceSessionId, sessionKey };
  await appendTranscriptEvent(scope, { type: "session", id: sourceSessionId, version: 3 });
  for (const [eventId, parentId, message] of [
    [
      "user-entry",
      null,
      {
        role: "user",
        content: [
          { type: "text", text: "edit me" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
        __openclaw: {
          media: [
            { path: storedImagePath, contentType: "image/png" },
            // Duplicate ref proves dedupe: the response must carry this image once.
            { path: storedImagePath, contentType: "image/png" },
            { path: `${storedImagePath}.missing`, contentType: "image/png" },
          ],
        },
      },
    ],
    ["assistant-entry", "user-entry", { role: "assistant", content: "answer" }],
    ["off-path-entry", null, { role: "user", content: "inactive" }],
  ] as const) {
    await appendTranscriptMessage(scope, { eventId, parentId, message });
  }
  await appendTranscriptEvent(scope, {
    type: "leaf",
    id: "active-leaf",
    parentId: "off-path-entry",
    targetId: "assistant-entry",
  });
  await waitForSessionTranscriptIndexReconcile({ agentId: "main" });
});

afterEach(async () => {
  clearQueuedSessionWork(
    captureSessionTarget({
      storeScope: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      sessionKey,
      agentId: "main",
      incarnation: sourceSessionId,
    }),
  );

  try {
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    resetPluginRuntimeStateForTest();
    clearRuntimeConfigSnapshot();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});

it("drains rewind fixture owners before closing handles and restoring selectors", ({
  onTestFinished,
}) => {
  const stateDir = process.env.OPENCLAW_STATE_DIR!;
  const agent = openOpenClawAgentDatabase({ agentId: "main" });
  const state = openOpenClawStateDatabase();
  const closing: unknown[] = [];
  registerOpenClawAgentDatabaseAsyncResource({
    agentId: "main",
    path: agent.path,
    revoke: () => {},
    close: async () => {
      await Promise.resolve();
      closing.push({
        agentOpen: agent.db.isOpen,
        stateOpen: state.db.isOpen,
        rootExists: fs.existsSync(stateDir),
        selector: process.env.OPENCLAW_STATE_DIR,
      });
    },
  });
  onTestFinished(() => {
    expect(closing).toEqual([
      { agentOpen: true, stateOpen: true, rootExists: true, selector: stateDir },
    ]);
    expect(agent.db.isOpen).toBe(false);
    expect(state.db.isOpen).toBe(false);
    expect(fs.existsSync(stateDir)).toBe(false);
  });
});

type QueuedSessionWork = {
  followup: FollowupRun;
  rpcSource: RpcSourceRef;
};

function clearQueuedSessionWork(target: SessionTarget | undefined): void {
  if (target) {
    cancelCapturedSessionControllerSource(
      captureSessionControllerStop({ targets: [target], includeActive: false }),
    );
  }
}

function enqueueSessionWork(label: string): QueuedSessionWork {
  const followup = createQueueTestRun(
    {
      prompt: `${label} follow-up`,
      turnAdoptionLifecycle: { admission: "cancel-only", onAdopted: () => {}, onSettled: vi.fn() },
    },
    { agentId: "main", sessionId: sourceSessionId, sessionKey },
  );
  const registration = registerSource(`queued-${label}`);
  followup.abortSignal = registration.controller.signal;
  bindSessionControllerSource(registration.entry.input, followup);
  expect(
    enqueueFollowupRun(sessionKey, followup, { mode: "followup" }, "none", undefined, false),
  ).toBe(true);
  return { followup, rpcSource: registration.entry };
}

function registerSource(runId: string) {
  const registration = registerChatAbortController({
    target: captureSessionTarget({
      storeScope: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      sessionKey,
      incarnation: sourceSessionId,
      agentId: "main",
    }),
    runId,
    sessionId: sourceSessionId,
    sessionKey,
    agentId: "main",
    kind: "chat-send",
    timeoutMs: 10_000,
  });
  if (!registration.registered) {
    throw new Error("Source registration failed");
  }
  return registration;
}

function expectSessionWorkQueued(work: QueuedSessionWork): void {
  expect(isRpcSourceRegistered(work.rpcSource)).toBe(true);
  expect(getFollowupQueueDepth(sessionKey)).toBe(1);
  expect(work.followup.controllerInput?.abortSignal.aborted).toBe(false);
  expect(work.followup.turnAdoptionLifecycle?.onSettled).not.toHaveBeenCalled();
}

async function expectSessionWorkCleared(work: QueuedSessionWork): Promise<void> {
  expect(getFollowupQueueDepth(sessionKey)).toBe(0);
  expect(work.followup.controllerInput?.abortSignal.aborted).toBe(true);
  await work.followup.controllerInput?.settlement.promise;
  expect(isRpcSourceRegistered(work.rpcSource)).toBe(false);
  expect(work.followup.turnAdoptionLifecycle?.onSettled).toHaveBeenCalledOnce();
}

async function archiveSourceSession(storePath?: string): Promise<void> {
  const entry = await patchSessionEntryCore({ agentId: "main", sessionKey, storePath }, () => ({
    archivedAt: Date.now(),
  }));
  expectDefined(entry, "source session");
}

describe("session message-cut methods", () => {
  it("rejects a disallowed agent fork without restricting existing-session rewind", async () => {
    const { options } = await restrictedOperator(
      "restricted-fork-creator@example.com",
      "guest-only",
    );
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };

    const fork = await invoke("sessions.fork", "user-entry", options);
    expectCutFailure(fork, {
      code: ErrorCodes.FORBIDDEN,
      message: expect.stringContaining('agent "main"'),
    });
    expect(
      await readSessionEntrySummariesInWorker({
        agentId: "main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      }),
    ).toHaveLength(1);

    const rewind = await invoke("sessions.rewind", "user-entry", options);
    expectCutReply(rewind, expect.any(Object));
  });

  it("stamps a required sandbox on a session fork created by a restricted operator", async () => {
    const { profile, options } = await restrictedOperator(
      "sandbox-required-fork-creator@example.com",
      "main",
      "required",
    );
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };

    const fork = await invoke("sessions.fork", "user-entry", options);
    const forkKey = (fork.mock.calls[0]?.[1] as { sessionKey?: string } | undefined)?.sessionKey;

    expectCutReply(fork, expect.objectContaining({ sessionKey: expect.any(String) }));
    expect(
      await readSessionEntryReadOnlyInWorker({ agentId: "main", sessionKey: forkKey ?? "" }),
    ).toMatchObject({ createdActor: { type: "human", id: profile.id }, sandbox: "required" });
    expect(
      await readSessionEntryReadOnlyInWorker({ agentId: "main", sessionKey }),
    ).not.toHaveProperty("sandbox");
  });

  it("returns an empty branch list for a not-yet-materialized session", async () => {
    const respond = await invoke("sessions.branches.list", undefined, {
      params: { sessionKey: "agent:main:never-materialized" },
    });
    expectCutReply(respond, { branches: [] });
  });

  it("clears queued session work after a successful branch switch", async () => {
    const work = enqueueSessionWork("branch switch");
    expectSessionWorkQueued(work);

    const respond = await invoke("sessions.branches.switch", "off-path-entry");

    expectCutReply(respond, {});
    await expectSessionWorkCleared(work);
  });

  it.each([false, true])(
    "settles a successful rewind after authority revocation=%s",
    async (revoke) => {
      const work = enqueueSessionWork("rewind");
      expectSessionWorkQueued(work);
      let current = true;
      const readMedia = expectDefined(
        mocks.readMediaBuffer.getMockImplementation(),
        "media reader",
      );
      mocks.readMediaBuffer.mockImplementation(async (id: string) => {
        const result = await readMedia(id);
        expect(
          (await readSessionEntryReadOnlyInWorker({ agentId: "main", sessionKey }))?.sessionId,
        ).not.toBe(sourceSessionId);
        if (revoke) {
          current = false;
        }
        return result;
      });
      const respond = await invoke("sessions.rewind", "user-entry", {
        sessionMutationCommitGuard: () => {
          if (!current) {
            throw new Error("rewind authority revoked after commit");
          }
        },
      });

      expectCutReply(respond, expect.objectContaining({ editorText: "edit me" }));
      await expectSessionWorkCleared(work);
    },
  );

  it("rewinds research's global session without clearing main's shared lane", async () => {
    const key = "global";
    const target = { agentId: "research", sessionKey: key, sessionId: "research-rewind" };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    await appendTranscriptMessage(target, {
      eventId: "research-user",
      message: { role: "user", content: "research question" },
      parentId: null,
    });
    const main = createQueueTestRun({ prompt: "main queued work" });
    Object.assign(main.run, { agentId: "main", sessionKey: key, sessionId: "main-rewind" });
    const research = createQueueTestRun({ prompt: "research queued work" });
    Object.assign(research.run, target);
    expect(enqueueFollowupRun(key, main, { mode: "followup" }, "none", undefined, false)).toBe(
      true,
    );
    expect(enqueueFollowupRun(key, research, { mode: "followup" }, "none", undefined, false)).toBe(
      true,
    );
    try {
      const respond = await invoke("sessions.rewind", "research-user", {
        params: { sessionKey: key, agentId: target.agentId, entryId: "research-user" },
        context: {
          ...context(),
          getRuntimeConfig: () => ({ agents: { entries: { main: {}, research: {} } } }),
        },
      });
      expectCutReply(respond, { editorText: "research question" });
      expect(main.controllerInput?.abortSignal.aborted).toBe(false);
      expect(research.controllerInput?.abortSignal.aborted).toBe(true);
    } finally {
      clearQueuedSessionWork(main.controllerInput?.mailbox.owner.target);
      clearQueuedSessionWork(research.controllerInput?.mailbox.owner.target);
    }
  });

  it("preserves queued session work after a rejected branch switch", async () => {
    const work = enqueueSessionWork("rejected branch switch");
    expectSessionWorkQueued(work);

    const respond = await invoke("sessions.branches.switch", "missing");

    expectCutFailure(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: expect.stringContaining("branch entry not found"),
    });
    expectSessionWorkQueued(work);
  });

  it("refuses rewind while pending input owns an in-flight native injection", async () => {
    const registration = registerSource("injecting-rewind");
    const source = registration.entry;
    const settled = vi.fn();
    void source.input.settlement.promise.then(settled);
    const injection = beginSessionControllerSourceInjection(source.input);
    try {
      expect(await injection.admit()).toBe(true);
      const respond = await invoke("sessions.rewind", "user-entry");
      expectCutFailure(respond, {
        code: ErrorCodes.UNAVAILABLE,
        message: "Rewind is unavailable while the agent is working.",
      });
      expect(source.input.abortSignal.aborted).toBe(false);
      expect(isRpcSourceRegistered(source)).toBe(true);
      expect(settled).not.toHaveBeenCalled();
    } finally {
      injection.finish(false);
      registration.cleanup();
      await source.input.settlement.promise;
    }
  });

  it.each([
    ["user-entry", "entry is not a branch tip"],
    ["assistant-entry", "branch is already active"],
  ])("rejects invalid branch switch target %s", async (entryId, message) => {
    const respond = await invoke("sessions.branches.switch", entryId);
    expectCutFailure(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: expect.stringContaining(message),
    });
  });

  it.each(["sessions.rewind", "sessions.fork"] as const)(
    "%s restores canonical inbound media facts and skips invalid URI hints",
    async (method) => {
      await appendTranscriptMessage(
        { agentId: "main", sessionId: sourceSessionId, sessionKey },
        {
          eventId: "canonical-image",
          parentId: "assistant-entry",
          message: {
            role: "user",
            content: "canonical image prompt",
            __openclaw: {
              media: [
                { url: `media://inbound/${storedImageId}`, contentType: "image/png" },
                { url: "media://inbound/%73tored-image.png", contentType: "image/png" },
                { url: `media://outbound/${storedImageId}`, contentType: "image/png" },
                { url: "media://inbound/nested%2Fimage.png", contentType: "image/png" },
                { url: `media://inbound/${storedImageId}?query=1`, contentType: "image/png" },
                { url: "https://example.test/stored-image.png", contentType: "image/png" },
                { url: "file:///tmp/stored-image.png", contentType: "image/png" },
              ],
            },
          },
        },
      );
      const respond = await invoke(method, "canonical-image");
      expectCutReply(
        respond,
        expect.objectContaining({
          editorText: "canonical image prompt",
          editorAttachments: [{ mimeType: "image/png", data: storedImageData.toString("base64") }],
        }),
      );
      expect(mocks.readMediaBuffer).toHaveBeenCalledTimes(1);
      expect(mocks.readMediaBuffer).toHaveBeenCalledWith(
        storedImageId,
        "inbound",
        expect.any(Number),
      );
    },
  );

  it("returns editor text for rewind and a new key for fork", async () => {
    await patchSessionEntryCore({ agentId: "main", sessionKey }, () => ({
      sandboxMode: "off",
      nativeRuntimeConsent: "native-fixture",
    }));
    const profileId = "profile-fork-creator";
    const fork = await invoke("sessions.fork", "user-entry", {
      client: {
        connect: { scopes: ["operator.write"] },
        authenticatedUserProfile: {
          profileId,
          displayName: "Fork Operator",
          hasAvatar: false,
          updatedAt: 1,
        },
      } as GatewayClient,
    });
    expectCutReply(
      fork,
      expect.objectContaining({
        editorText: "edit me",
        editorAttachments: [
          { mimeType: "image/png", data: "aW1hZ2U=" },
          { mimeType: "image/png", data: storedImageData.toString("base64") },
        ],
        sessionKey: expect.any(String),
      }),
    );
    expect(mocks.readMediaBuffer).toHaveBeenCalledTimes(2);
    const forkKey = (fork.mock.calls[0]?.[1] as { sessionKey?: string } | undefined)?.sessionKey;
    expect(forkKey).toBeTruthy();
    const forkEntry = await readSessionEntryReadOnlyInWorker({
      agentId: "main",
      sessionKey: forkKey ?? "",
    });
    expect(forkEntry).not.toHaveProperty("sandboxMode");
    expect(forkEntry).not.toHaveProperty("nativeRuntimeConsent");
    expect(forkEntry).toMatchObject({
      createdVia: "operator",
      createdActor: { type: "human", id: profileId },
      createdAt: expect.any(Number),
    });
    expect((await listSessionStateEventsSince(forkKey ?? "", "main", 0, 20)).events).toContainEqual(
      expect.objectContaining({ kind: "created", actorType: "human", actorId: profileId }),
    );

    const rewind = await invoke("sessions.rewind", "user-entry");
    expectCutReply(rewind, {
      editorText: "edit me",
      editorAttachments: [
        { mimeType: "image/png", data: "aW1hZ2U=" },
        { mimeType: "image/png", data: storedImageData.toString("base64") },
      ],
    });
    expect(mocks.readMediaBuffer).toHaveBeenCalledTimes(4);
    expect(
      (await readSessionEntryReadOnlyInWorker({ agentId: "main", sessionKey }))?.sandboxMode,
    ).toBe("off");
    expect(
      (
        await readSessionEntrySummariesInWorker({
          agentId: "main",
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        })
      )
        .map((row) => row.sessionKey)
        .toSorted(),
    ).toEqual([sessionKey, forkKey ?? ""].toSorted());
  });

  it.each([
    ["sessions.rewind", "user-entry", "Rewind"],
    ["sessions.branches.switch", "off-path-entry", "Branch switch"],
  ] as const)("rejects archived %s", async (method, entryId, label) => {
    await archiveSourceSession();

    const respond = await invoke(method, entryId);

    expectCutFailure(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: `${label} is unavailable for archived sessions.`,
    });
  });

  it("rechecks archived state after waiting for the session lifecycle lock", async () => {
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
    const { release, settled: archiving } = await holdLifecycle(storePath, sourceSessionId, () =>
      archiveSourceSession(storePath),
    );

    const rewinding = invoke("sessions.rewind", "user-entry");
    release();
    await archiving;

    const respond = await rewinding;
    expectCutFailure(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "Rewind is unavailable for archived sessions.",
    });
  });

  it.each([
    ["missing", "message entry not found"],
    ["assistant-entry", "entry is not a user message"],
    ["off-path-entry", "not on the active path"],
  ])("returns a typed validation error for %s", async (entryId, message) => {
    const respond = await invoke("sessions.rewind", entryId);
    expectCutFailure(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: expect.stringContaining(message),
    });
  });

  it.each([
    ["sessions.fork", "Fork", false],
    ["sessions.rewind", "Rewind", false],
    ["sessions.branches.switch", "Branch switch", false],
    ["sessions.fork", "Fork", true],
    ["sessions.rewind", "Rewind", true],
    ["sessions.branches.switch", "Branch switch", true],
  ] as const)(
    "rejects %s (%s) while its admitted producer has started=%s",
    async (method, label, executionStarted) => {
      const source = createRpcSourceForTest(
        {},
        {
          sessionKey,
          sessionId: sourceSessionId,
          agentId: "main",
          storeScope: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        },
      );
      const release = await claimRpcSourceForTest(source, { executionStarted });
      const respond = await invoke(
        method,
        method === "sessions.branches.switch" ? "off-path-entry" : "user-entry",
      );
      release();

      expectCutFailure(respond, {
        code: ErrorCodes.UNAVAILABLE,
        message: `${label} is unavailable while the agent is working.`,
      });
    },
  );
});

const forkFailure = {
  status: "failed",
  code: "upstream-unavailable",
  message: "Codex is offline. Try again.",
};

function installUpstreamForkHarness(
  executionEnvironment?: "host-only",
  contract: "dual" | "legacy" | "v2" = "v2",
): void {
  const sessionFork = { upstreamKinds: ["codex-app-server" as const], fork: mocks.upstreamFork };
  installHarness({
    ...(contract !== "v2"
      ? { ...(executionEnvironment ? { executionEnvironment } : {}), sessionFork }
      : {}),
    ...(contract !== "legacy"
      ? {
          sessionForkV2: {
            ...(executionEnvironment ? { executionEnvironment } : {}),
            ...sessionFork,
          },
        }
      : {}),
  });
}

function entries() {
  return readSessionEntrySummariesInWorker({
    agentId: "main",
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
  });
}

function expectExternalOwner(respond: ReturnType<typeof vi.fn>) {
  expectCutFailure(respond, {
    code: ErrorCodes.INVALID_REQUEST,
    message: expect.stringContaining("external agent harness"),
  });
}

describe("upstream session message-cut methods", () => {
  beforeEach(() => {
    mocks.upstreamFork.mockReset();
    expect(
      upsertSessionUpstreamLink({
        agentId: "main",
        catalogId: "codex",
        hostId: "gateway:local",
        marker: { turnId: "turn-2", userMessageCount: 1 },
        sessionKey,
        threadId: "thread-source",
        upstreamKind: "codex-app-server",
        upstreamRef: { connectionFingerprint: "fingerprint", threadId: "thread-source" },
      }),
    ).toBe(true);
  });
  it("rejects mutation but lists empty branches for externally owned conversations", async () => {
    const respond = await invoke("sessions.branches.switch", "off-path-entry");
    expectExternalOwner(respond);
    // Listing is read-only: "no local branches" is the truthful steady state,
    // not an error to latch into the UI.
    const listed = await invoke("sessions.branches.list");
    expectCutReply(listed, { branches: [] });
  });

  it.each(["sessions.rewind", "sessions.branches.switch"] as const)(
    "rejects %s for upstream-linked sessions even with a fork-capable harness",
    async (method) => {
      installUpstreamForkHarness();
      expectExternalOwner(await invoke(method));
      expect(mocks.upstreamFork).not.toHaveBeenCalled();
    },
  );

  it("delegates complete upstream fork materialization to the harness", async () => {
    installUpstreamForkHarness(undefined, "dual");
    mocks.upstreamFork.mockResolvedValue({
      status: "created",
      key: "agent:main:dashboard:forked",
      editorText: "edit me",
    });

    const respond = await invoke("sessions.fork");
    expectCutReply(respond, { editorText: "edit me", sessionKey: "agent:main:dashboard:forked" });
    expect(mocks.upstreamFork).toHaveBeenCalledWith(
      expect.objectContaining({
        assertCurrent: expect.any(Function),
        source: expect.objectContaining({ entryId: "user-entry", sessionKey }),
        targetKey: expect.stringMatching(/^agent:main:dashboard:/),
        upstream: expect.objectContaining({
          catalogId: "codex",
          hostId: "gateway:local",
          kind: "codex-app-server",
          threadId: "thread-source",
        }),
      }),
    );
  });

  it.each(["created", "failed"] as const)(
    "expires native-write authority when the upstream fork settles %s",
    async (outcome) => {
      installUpstreamForkHarness();
      let retainedAssertCurrent: (() => void) | undefined;
      mocks.upstreamFork.mockImplementation(
        async ({ assertCurrent }: { assertCurrent: () => void }) => {
          assertCurrent();
          retainedAssertCurrent = assertCurrent;
          return outcome === "created"
            ? { status: "created", key: "agent:main:dashboard:forked" }
            : forkFailure;
        },
      );

      await invoke("sessions.fork");

      const nativeWrites = vi.fn();
      expect(() => {
        expectDefined(retainedAssertCurrent, "retained native-write authority")();
        nativeWrites();
      }).toThrow("Session initialization source is closed");
      expect(nativeWrites).not.toHaveBeenCalled();
    },
  );

  it.each(["dual", "legacy", "v2"] as const)(
    "rejects the current creator's required sandbox before invoking a host-only %s upstream fork",
    async (contract) => {
      const { options } = await restrictedOperator(
        `sandbox-required-${contract}-fork@example.com`,
        "main",
        "required",
        false,
      );
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      installUpstreamForkHarness("host-only", contract);
      const fork = await withPluginRuntimeGatewayRequestScope(
        { client: options.client, isWebchatConnect: () => false },
        () => invoke("sessions.fork", undefined, options),
      );
      expectCutFailure(fork, {
        details: expect.objectContaining({
          code: "AGENT_RUNTIME_RESTRICTED",
          reason: "sandbox-required",
        }),
      });
      expect(mocks.upstreamFork).not.toHaveBeenCalled();
      expect(await entries()).toHaveLength(1);
    },
  );

  it.each([
    { failure: forkFailure, code: ErrorCodes.UNAVAILABLE },
    {
      failure: {
        status: "failed",
        code: "drift-mismatch",
        message: "boundary failed: drift-mismatch",
      },
      code: ErrorCodes.INVALID_REQUEST,
    },
  ])(
    "passes through $failure.code without mutating the local session",
    async ({ failure, code }) => {
      installUpstreamForkHarness();
      mocks.upstreamFork.mockResolvedValue(failure);
      const entryCount = (await entries()).length;
      expectCutFailure(await invoke("sessions.fork"), {
        code,
        details: { reason: failure.code },
        message: failure.message,
      });
      expect(await entries()).toHaveLength(entryCount);
    },
  );
});
