import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveEmbeddedSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import { clearFollowupDrainCallback } from "../../auto-reply/reply/queue/drain.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "../../auto-reply/reply/queue/enqueue.js";
import { clearFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import type { FollowupRun } from "../../auto-reply/reply/queue/types.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import {
  clearCommandLane,
  CommandLaneClearedError,
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
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
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../../state/user-profile-writes.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayClient,
} from "./types.js";

const mocks = vi.hoisted(() => ({
  readMediaBuffer: vi.fn(),
  unexpected: (operation: string) => () => {
    throw new Error(`Unexpected ${operation}`);
  },
}));

// Queued sources stay idle: this boundary only cuts history and settles pending work.
vi.mock("../../auto-reply/reply/queue/drain.js", () => ({
  clearFollowupDrainCallback: vi.fn(),
  dropAbortedFollowups: mocks.unexpected("followup drain"),
  kickFollowupDrainIfIdle: mocks.unexpected("followup drain"),
  rememberFollowupDrainCallback: mocks.unexpected("followup drain"),
}));
vi.mock("../../auto-reply/reply/queue/delivery-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auto-reply/reply/queue/delivery-context.js")>()),
  createOverflowSummaryRetrySource: mocks.unexpected("queue overflow"),
  resolveFollowupAuthorizationKey: mocks.unexpected("queue overflow"),
  resolveFollowupDeliveryStorageKey: mocks.unexpected("queue overflow"),
}));
vi.mock("../../agents/model-thinking-default.js", () => ({
  resolveThinkingSelection: mocks.unexpected("model selection refresh"),
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
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { sessionRewindHandlers } from "./sessions-rewind.js";

// One teardown owns drainage and deletion so a failed drain retains the fixture root.
const tempDirs = createTempDirTracker();
const sessionKey = "agent:main:rewind-handler";
const sourceSessionId = "rewind-handler-source";
const sourceScope = { agentId: "main", sessionKey };
const transcriptScope = { ...sourceScope, sessionId: sourceSessionId };
const sessionLane = resolveEmbeddedSessionLane(sessionKey);
const storedImageId = "stored-image.png";
const storedImagePath = `/state/media/inbound/${storedImageId}`;
const storedImageData = Buffer.from("stored-image");
const editorAttachments = [
  { mimeType: "image/png", data: "aW1hZ2U=" },
  { mimeType: "image/png", data: storedImageData.toString("base64") },
];
const queuedCommandSettlements = new Set<Promise<void>>();

function messageEvent(id: string, parentId: string | null, message: Record<string, unknown>) {
  return { type: "message" as const, id, parentId, message };
}

function expectReply(respond: ReturnType<typeof vi.fn>, payload: unknown) {
  expect(respond).toHaveBeenCalledWith(true, payload, undefined);
}

function expectRejected(
  respond: ReturnType<typeof vi.fn>,
  message: unknown,
  code: string = ErrorCodes.INVALID_REQUEST,
) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code, message }),
  );
}

const readSource = () => readSessionEntryReadOnlyInWorker(sourceScope);
const readEntries = () =>
  readSessionEntrySummariesInWorker({
    agentId: "main",
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
  });

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
  setRuntimeConfigSnapshot(context().getRuntimeConfig());
  await upsertSessionEntryCore(sourceScope, {
    sessionId: sourceSessionId,
    updatedAt: Date.now(),
  });
  for (const event of [
    { type: "session", id: sourceSessionId, version: 3 },
    messageEvent("user-entry", null, {
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
    }),
    messageEvent("assistant-entry", "user-entry", { role: "assistant", content: "answer" }),
    messageEvent("off-path-entry", null, { role: "user", content: "inactive" }),
    {
      type: "leaf",
      id: "active-leaf",
      parentId: "off-path-entry",
      targetId: "assistant-entry",
    },
  ]) {
    if (event.type === "message") {
      await appendTranscriptMessage(transcriptScope, {
        eventId: event.id,
        message: event.message,
        parentId: event.parentId,
      });
    } else {
      await appendTranscriptEvent(transcriptScope, event);
    }
  }
  await waitForSessionTranscriptIndexReconcile({ agentId: "main" });
});

afterEach(async () => {
  for (const key of [sessionKey, sourceSessionId]) {
    clearFollowupQueue(key);
    clearFollowupDrainCallback(key);
    clearCommandLane(resolveEmbeddedSessionLane(key));
  }
  setCommandLaneConcurrency(sessionLane, 1);
  await Promise.all(queuedCommandSettlements);
  queuedCommandSettlements.clear();
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

function context(active = false): GatewayRequestContext {
  return {
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(
      active ? [["active-run", { sessionId: sourceSessionId, sessionKey }]] : undefined,
    ),
    getRuntimeConfig: () => ({ agents: { entries: { main: {} } } }),
    getSessionEventSubscriberConnIds: () => new Set(),
  } as unknown as GatewayRequestContext;
}

type MessageCutMethod =
  | "sessions.branches.list"
  | "sessions.branches.switch"
  | "sessions.fork"
  | "sessions.rewind";

async function invoke(
  method: MessageCutMethod,
  entryId?: string,
  options: Partial<GatewayRequestHandlerOptions> = {},
) {
  const respond = vi.fn();
  await expectDefined(
    sessionRewindHandlers[method],
    `${method} handler`,
  )({
    req: { id: `${method}-request` } as never,
    params: {
      sessionKey,
      ...(method === "sessions.branches.switch"
        ? { leafEntryId: entryId }
        : method === "sessions.branches.list"
          ? {}
          : { entryId }),
    },
    respond,
    context: context(),
    client: null,
    isWebchatConnect: () => false,
    ...options,
  });
  return respond;
}

type QueuedSessionWork = {
  command: Promise<string>;
  followup: FollowupRun;
  hasCommandRun: () => boolean;
};

function enqueueSessionWork(label: string): QueuedSessionWork {
  const followup: FollowupRun = {
    prompt: `${label} follow-up`,
    enqueuedAt: Date.now(),
    turnAdoptionLifecycle: { admission: "cancel-only", onAdopted: () => {}, onSettled: vi.fn() },
    run: {
      agentId: "main",
      sessionId: sourceSessionId,
      sessionKey,
      agentDir: "/tmp",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp",
      config: {},
      provider: "openai",
      model: "gpt-test",
      timeoutMs: 10_000,
      blockReplyBreak: "text_end",
    },
  };
  expect(
    enqueueFollowupRun(sessionKey, followup, { mode: "followup" }, "none", undefined, false),
  ).toBe(true);

  setCommandLaneConcurrency(sessionLane, 0);
  let commandRan = false;
  const command = enqueueCommandInLane(sessionLane, async () => {
    commandRan = true;
    return `${label} command`;
  });
  const settlement = command.then(
    () => undefined,
    () => undefined,
  );
  queuedCommandSettlements.add(settlement);

  return { command, followup, hasCommandRun: () => commandRan };
}

function expectSessionWorkQueued(work: QueuedSessionWork): void {
  expect(getFollowupQueueDepth(sessionKey)).toBe(1);
  expect(work.followup.turnAdoptionLifecycle?.onSettled).not.toHaveBeenCalled();
  expect(getCommandLaneSnapshot(sessionLane)).toMatchObject({
    activeCount: 0,
    queuedCount: 1,
  });
  expect(work.hasCommandRun()).toBe(false);
}

async function expectSessionWorkCleared(work: QueuedSessionWork): Promise<void> {
  expect(getFollowupQueueDepth(sessionKey)).toBe(0);
  expect(work.followup.turnAdoptionLifecycle?.onSettled).toHaveBeenCalledOnce();
  expect(getCommandLaneSnapshot(sessionLane)).toMatchObject({
    activeCount: 0,
    queuedCount: 0,
  });
  await expect(work.command).rejects.toBeInstanceOf(CommandLaneClearedError);
  expect(work.hasCommandRun()).toBe(false);
}

async function archiveSourceSession(storePath?: string): Promise<void> {
  const entry = await patchSessionEntryCore({ ...sourceScope, storePath }, () => ({
    archivedAt: Date.now(),
  }));
  expectDefined(entry, "source session");
}

async function restrictedOperator(email: string, agentId: string, sandbox?: "required") {
  const profile = await ensureCanonicalUserProfileForEmail(email);
  await setCanonicalUserProfileRole(profile.id, "guest");
  const client: GatewayClient = {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "test", version: "test", platform: "test", mode: "test" },
      scopes: ["operator.write"],
    },
    authenticatedUserProfile: {
      profileId: profile.id,
      displayName: profile.displayName,
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    },
  };
  const runtimeConfig: GatewayRequestContext["getRuntimeConfig"] = () => ({
    agents: { entries: { main: {} } },
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others: "view" },
            agents: [agentId],
            scopes: ["operator.read", "operator.write"],
            ...(sandbox ? { sandbox } : {}),
          },
        },
      },
    },
  });
  return {
    profile,
    options: { client, context: { ...context(), getRuntimeConfig: runtimeConfig } },
  };
}

describe("session message-cut methods", () => {
  it("rejects a disallowed agent fork without restricting existing-session rewind", async () => {
    const { options } = await restrictedOperator(
      "restricted-fork-creator@example.com",
      "guest-only",
    );
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };

    const fork = await invoke("sessions.fork", "user-entry", options);
    expectRejected(fork, expect.stringContaining('agent "main"'), ErrorCodes.FORBIDDEN);
    expect(await readEntries()).toHaveLength(1);

    const rewind = await invoke("sessions.rewind", "user-entry", options);
    expectReply(rewind, expect.any(Object));
  });

  it("stamps a required sandbox on a session fork created by a restricted operator", async () => {
    const { options, profile } = await restrictedOperator(
      "sandbox-required-fork-creator@example.com",
      "main",
      "required",
    );
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };

    const fork = await invoke("sessions.fork", "user-entry", options);
    const forkKey = (fork.mock.calls[0]?.[1] as { sessionKey?: string } | undefined)?.sessionKey;

    expectReply(fork, expect.objectContaining({ sessionKey: expect.any(String) }));
    expect(
      await readSessionEntryReadOnlyInWorker({ agentId: "main", sessionKey: forkKey ?? "" }),
    ).toMatchObject({
      createdActor: { type: "human", id: profile.id },
      sandbox: "required",
    });
    expect(await readSource()).not.toHaveProperty("sandbox");
  });

  it("returns an empty branch list for a not-yet-materialized session", async () => {
    const respond = await invoke("sessions.branches.list", undefined, {
      params: { sessionKey: "agent:main:never-materialized" },
    });
    expect(respond).toHaveBeenCalledWith(true, { branches: [] }, undefined);
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
        expect((await readSource())?.sessionId).not.toBe(sourceSessionId);
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

      expectReply(respond, expect.objectContaining({ editorText: "edit me" }));
      await expectSessionWorkCleared(work);
    },
  );

  it("rewinds research's global session without clearing main's shared lane", async () => {
    const key = "global";
    const lane = resolveEmbeddedSessionLane(key);
    const target = { agentId: "research", sessionKey: key, sessionId: "research-rewind" };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    await appendTranscriptMessage(target, {
      eventId: "research-user",
      message: { role: "user", content: "research question" },
      parentId: null,
    });
    setCommandLaneConcurrency(lane, 0);
    const commands = [
      enqueueCommandInLane(lane, async () => "main tagged", {
        sessionTarget: { agentId: "main", sessionKey: key, sessionId: "main-rewind" },
      }),
      enqueueCommandInLane(lane, async () => "main untagged"),
      enqueueCommandInLane(lane, async () => "research", { sessionTarget: target }),
    ];
    const settled = Promise.allSettled(commands);
    try {
      const respond = await invoke("sessions.rewind", "research-user", {
        params: { sessionKey: key, agentId: target.agentId, entryId: "research-user" },
        context: {
          ...context(),
          getRuntimeConfig: () => ({ agents: { entries: { main: {}, research: {} } } }),
        },
      });
      expectReply(respond, { editorText: "research question" });
      setCommandLaneConcurrency(lane, 1);
      expect(await settled).toEqual([
        { status: "fulfilled", value: "main tagged" },
        { status: "fulfilled", value: "main untagged" },
        { status: "rejected", reason: expect.any(CommandLaneClearedError) },
      ]);
    } finally {
      clearCommandLane(lane);
      setCommandLaneConcurrency(lane, 1);
      await settled;
    }
  });

  it("preserves queued session work after a rejected branch switch", async () => {
    const work = enqueueSessionWork("rejected branch switch");
    expectSessionWorkQueued(work);

    const respond = await invoke("sessions.branches.switch", "missing");

    expectRejected(respond, expect.stringContaining("branch entry not found"));
    expectSessionWorkQueued(work);

    setCommandLaneConcurrency(sessionLane, 1);
    await expect(work.command).resolves.toBe("rejected branch switch command");
    expect(work.hasCommandRun()).toBe(true);
  });

  it.each([
    ["user-entry", "entry is not a branch tip"],
    ["assistant-entry", "branch is already active"],
  ])("rejects invalid branch switch target %s", async (entryId, message) => {
    const respond = await invoke("sessions.branches.switch", entryId);
    expectRejected(respond, expect.stringContaining(message));
  });

  it.each(["sessions.rewind", "sessions.fork"] as const)(
    "%s restores canonical inbound media facts and skips invalid URI hints",
    async (method) => {
      await appendTranscriptMessage(transcriptScope, {
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
      });
      const respond = await invoke(method, "canonical-image");
      expectReply(
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
    await patchSessionEntryCore(sourceScope, () => ({
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
    expectReply(
      fork,
      expect.objectContaining({
        editorText: "edit me",
        editorAttachments,
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
      expect.objectContaining({
        kind: "created",
        actorType: "human",
        actorId: profileId,
      }),
    );

    const rewind = await invoke("sessions.rewind", "user-entry");
    expectReply(rewind, { editorText: "edit me", editorAttachments });
    expect(mocks.readMediaBuffer).toHaveBeenCalledTimes(4);
    expect((await readSource())?.sandboxMode).toBe("off");
    expect((await readEntries()).map((row) => row.sessionKey).toSorted()).toEqual(
      [sessionKey, forkKey ?? ""].toSorted(),
    );
  });

  it.each([
    ["sessions.rewind", "user-entry", "Rewind"],
    ["sessions.branches.switch", "off-path-entry", "Branch switch"],
  ] as const)("rejects archived %s", async (method, entryId, label) => {
    await archiveSourceSession();

    const respond = await invoke(method, entryId);

    expectRejected(respond, `${label} is unavailable for archived sessions.`);
  });

  it("rechecks archived state after waiting for the session lifecycle lock", async () => {
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
    const mutationEntered = createDeferredCore();
    const releaseMutation = createDeferredCore();
    const archiving = runExclusiveSessionLifecycleMutation("archive", {
      scope: storePath,
      identities: [sourceSessionId],
      run: async () => {
        mutationEntered.resolve();
        await releaseMutation.promise;
        await archiveSourceSession(storePath);
      },
    });
    await mutationEntered.promise;

    const rewinding = invoke("sessions.rewind", "user-entry");
    releaseMutation.resolve();
    await archiving;

    const respond = await rewinding;
    expectRejected(respond, "Rewind is unavailable for archived sessions.");
  });

  it.each([
    ["missing", "message entry not found"],
    ["assistant-entry", "entry is not a user message"],
    ["off-path-entry", "not on the active path"],
  ])("returns a typed validation error for %s", async (entryId, message) => {
    const respond = await invoke("sessions.rewind", entryId);
    expectRejected(respond, expect.stringContaining(message));
  });

  it.each([
    ["sessions.fork", "Fork"],
    ["sessions.rewind", "Rewind"],
    ["sessions.branches.switch", "Branch switch"],
  ] as const)("rejects %s while the source run is active", async (method, label) => {
    const respond = await invoke(
      method,
      method === "sessions.branches.switch" ? "off-path-entry" : "user-entry",
      { context: context(true) },
    );

    expectRejected(
      respond,
      `${label} is unavailable while the agent is working.`,
      ErrorCodes.UNAVAILABLE,
    );
  });
});
