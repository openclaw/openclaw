import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { RawData } from "ws";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { claimAgentRunContext, clearAgentRunContext } from "../infra/agent-run-registry.js";
import * as secureRandom from "../infra/secure-random.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { persistUserTurnTranscript } from "../sessions/user-turn-transcript.test-support.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setAvatar } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveCurrentUserProfileDisplay } from "./current-user-profile-display.js";
import {
  connectSessionClient,
  sessionClientCredentialPath,
} from "./session-message-client.test-support.js";
import { registerCronSessionCompletionEventTests } from "./session-message-cron.test-support.js";
import { findWatchedPresenceEntry, getConnId } from "./session-message-presence.test-support.js";
import { registerRecoveredSubagentSessionEventTest } from "./session-message-subagent.test-support.js";
import { createWorkerFanoutFixture } from "./session-message-worker.test-support.js";
import { removeSessionTestDirectories } from "./session-test-directories.test-support.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  connectOk,
  connectReq,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  writeSessionStore,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

const cleanupDirs: string[] = [];
const cleanupTestStates: OpenClawTestState[] = [];
const SETUP_RPC_TIMEOUT_MS = 30_000;
let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let subscribedOperatorWs: GatewayWs | undefined;

// No explicit hook timeout: the suite harness cold-imports the full gateway
// server graph, which can legitimately exceed 60s on contended CI runners.
// Sibling gateway suites rely on the shared project hookTimeout (120s, 180s on
// Windows) for the same boot; tightening it here caused flaky hook timeouts.
beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
  subscribedOperatorWs = await harness.openWs();
  await connectOk(subscribedOperatorWs, {
    scopes: ["operator.read"],
    timeoutMs: SETUP_RPC_TIMEOUT_MS,
  });
  await rpcReq(subscribedOperatorWs, "sessions.subscribe", undefined, SETUP_RPC_TIMEOUT_MS);
});

afterAll(async () => {
  subscribedOperatorWs?.close();
  await harness?.close();
});

afterEach(async () => {
  for (const state of cleanupTestStates.splice(0).toReversed()) {
    await state.cleanup();
  }
  await removeSessionTestDirectories(cleanupDirs.splice(0));
});

async function createSessionStoreFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-message-"));
  cleanupDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  return storePath;
}

async function createMainSessionStore(entry: StoreEntries[string] = {}): Promise<string> {
  return createSessionStore({ main: { sessionId: "sess-main", ...entry } });
}

type GatewayWs = Awaited<ReturnType<typeof harness.openWs>>;
type StoreEntries = Parameters<typeof writeSessionStore>[0]["entries"];

async function openTestSocket(options?: Parameters<typeof harness.openWs>[0]) {
  const ws = await harness.openWs(options);
  return Object.assign(ws, { [Symbol.dispose]: () => ws.close() });
}

async function createSessionStore(entries: StoreEntries, agentId?: string) {
  const updatedAt = Date.now();
  const storePath = await createSessionStoreFile();
  await writeSessionStore({
    storePath,
    entries: Object.fromEntries(
      Object.entries(entries).map(([key, entry]) => [key, { updatedAt, ...entry }]),
    ),
    ...(agentId ? { agentId } : {}),
  });
  return storePath;
}

async function appendAssistant(storePath: string, sessionKey: string, text: string) {
  const appended = await appendAssistantMessageToSessionTranscript({ storePath, sessionKey, text });
  expect(appended.ok).toBe(true);
  if (!appended.ok) {
    throw new Error(`append failed: ${appended.reason}`);
  }
  return appended;
}

function messageMetadata(message: unknown) {
  return requireRecord(requireRecord(message, "message")["__openclaw"], "metadata");
}

function eventMessage(frame: { payload?: unknown }) {
  return requireRecord(requireRecord(frame.payload, "event payload").message, "event message");
}

function expectNoSessionMessage(
  ws: GatewayWs,
  sessionKey: string,
  action: () => Promise<unknown> | void,
) {
  return expectNoMessageWithin({
    watch: (timeoutMs) => waitForSessionMessageEvent(ws, sessionKey, timeoutMs),
    action: async () => {
      await action();
    },
  });
}

function textMessage(text: string, role = "assistant", timestamp = Date.now()) {
  return { role, content: [{ type: "text", text }], timestamp };
}

function userTurn(id: string, text: string, timestamp = Date.now()) {
  return {
    eventId: id,
    message: { ...textMessage(text, "user", timestamp), idempotencyKey: `${id}:user` },
  };
}

function expectedUserMessage(id: string, text: string, seq: number) {
  return {
    __openclaw: { id, idempotencyKey: `${id}:user`, seq },
    content: [{ type: "text", text }],
    role: "user",
  };
}

function activeGoal(id: string, objective: string, tokensUsed: number) {
  return {
    schemaVersion: 1 as const,
    id,
    objective,
    status: "active" as const,
    createdAt: 1,
    updatedAt: 2,
    tokenStart: 0,
    tokensUsed,
    continuationTurns: 0,
  };
}

const spawnMetadata = {
  spawnedWorkspaceDir: "/tmp/subagent-workspace",
  forkedFromParent: true,
  spawnDepth: 2,
  subagentRole: "orchestrator" as const,
  subagentControlScope: "children" as const,
};

const copilotOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const copilotClient = {
  id: GATEWAY_CLIENT_IDS.BROWSER_COPILOT,
  version: "test",
  platform: "chrome",
  deviceFamily: "extension",
  mode: GATEWAY_CLIENT_MODES.UI,
};
const copilotOptions = {
  caps: [GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS, GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
  client: copilotClient,
  scopes: ["operator.read", "operator.write"],
};

async function rejectCopilot(
  deviceIdentityPath: string,
  options: Parameters<typeof connectReq>[1],
  error: { code?: string; message?: string },
  origin: string | undefined = copilotOrigin,
) {
  using ws = await openTestSocket({ origin });
  const response = await connectReq(ws, { ...copilotOptions, deviceIdentityPath, ...options });
  expect(response.ok).toBe(false);
  if (error.code) {
    expect(response.error?.code).toBe(error.code);
  }
  if (error.message) {
    expect(response.error?.message).toContain(error.message);
  }
}

async function withOperatorSessionSubscriber<T>(
  run: (ws: NonNullable<typeof subscribedOperatorWs>) => Promise<T>,
) {
  if (!subscribedOperatorWs) {
    throw new Error("subscribed operator websocket is not ready");
  }
  return await run(subscribedOperatorWs);
}

function matchingEvent(event: string, fields: Record<string, unknown> = {}) {
  return (frame: { type?: string; event?: string; payload?: unknown }) => {
    const payload = asOptionalRecord(frame.payload);
    return (
      frame.type === "event" &&
      frame.event === event &&
      Object.entries(fields).every(([key, value]) => payload?.[key] === value)
    );
  };
}

function collectEventPayloads(ws: GatewayWs, event: string, fields: Record<string, unknown> = {}) {
  const messages: Record<string, unknown>[] = [];
  const matches = matchingEvent(event, fields);
  const listener = (data: RawData) => {
    const frame = JSON.parse(rawDataToString(data));
    if (matches(frame)) {
      messages.push(requireRecord(frame.payload, "event payload"));
    }
  };
  ws.on("message", listener);
  return { messages, [Symbol.dispose]: () => ws.off("message", listener) };
}

function waitForSessionMessageEvent(ws: GatewayWs, sessionKey: string, timeoutMs?: number) {
  return onceMessage(ws, matchingEvent("session.message", { sessionKey }), timeoutMs);
}

async function subscribeMessages(ws: GatewayWs, key: string) {
  expect(await rpcReq(ws, "sessions.messages.subscribe", { key })).toMatchObject({
    ok: true,
    payload: { key, subscribed: true },
  });
}

function waitForSessionObserverEvent(ws: GatewayWs, runId: string, timeoutMs?: number) {
  return onceMessage(ws, matchingEvent("session.observer", { runId }), timeoutMs);
}

function waitForSessionsChangedMessagePhase(ws: GatewayWs, sessionKey: string) {
  return onceMessage(ws, matchingEvent("sessions.changed", { phase: "message", sessionKey }));
}

async function emitTranscriptUpdateAndCollectMessageEvent(params: {
  ws: GatewayWs;
  sessionKey: string;
  sessionFile: string;
  message: Record<string, unknown>;
  messageId: string;
  agentId?: string;
  messageSeq?: number;
}) {
  const messageEventPromise = waitForSessionMessageEvent(params.ws, params.sessionKey);

  const { ws: _ws, ...update } = params;
  emitSessionTranscriptUpdate(update);

  const messageEvent = await messageEventPromise;
  return { messageEvent };
}

async function expectNoMessageWithin(params: {
  action?: () => Promise<void> | void;
  watch: (timeoutMs: number) => Promise<unknown>;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 300;
  const received = params.watch(timeoutMs).then(
    () => true,
    () => false,
  );
  await params.action?.();
  await expect(received).resolves.toBe(false);
}

const requireRecord = createRequireRecord("object", "expected-label-object");

function expectRecordFields(value: unknown, expected: Record<string, unknown>): void {
  const record = requireRecord(value, "record");
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toEqual(expectedValue);
  }
}

function withMockedDateNow<T>(now: number, run: () => T): T {
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    return run();
  } finally {
    clock.mockRestore();
  }
}

function currentProfileAvatarUrl(profileId: string): string {
  const display = resolveCurrentUserProfileDisplay(profileId);
  expect(display.kind).toBe("resolved");
  if (display.kind !== "resolved") {
    throw new Error("expected a resolved current profile display");
  }
  return display.avatarUrl;
}

describe("session.message websocket events", () => {
  test("message subscriptions preserve declared viewers and disconnect removes only that connection", async () => {
    using observerWs = await openTestSocket();
    using watchedWs = await openTestSocket();
    const instanceId = "presence-watched-sessions";
    const observerConnId = getConnId(await connectOk(observerWs, { scopes: ["operator.read"] }));
    await connectOk(watchedWs, {
      scopes: ["operator.read"],
      client: {
        id: GATEWAY_CLIENT_IDS.TEST,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.TEST,
        instanceId,
      },
    });
    const keys = ["agent:main:watch-00", "agent:main:watch-01"];
    await createSessionStore(Object.fromEntries(keys.map((key) => [key, { sessionId: key }])));
    const findWatched = (message: unknown) => findWatchedPresenceEntry(message, instanceId);
    const declared = onceMessage(
      observerWs,
      (message) => JSON.stringify(findWatched(message)?.watchedSessions) === JSON.stringify(keys),
    );
    await rpcReq(watchedWs, "sessions.viewers.set", { sessionKeys: keys });
    const declaration = await declared;
    const watched = findWatched(declaration);
    const readWatched = async () => {
      const response = await rpcReq(observerWs, "system-presence", {});
      const payload: unknown = response.payload;
      const entries: unknown[] = Array.isArray(payload) ? payload : [];
      return asOptionalRecord(
        entries.find((entry) => asOptionalRecord(entry)?.instanceId === instanceId),
      )?.watchedSessions;
    };

    for (const key of ["agent:main:narration-0", "agent:main:narration-1"]) {
      expect((await rpcReq(watchedWs, "sessions.messages.subscribe", { key })).ok).toBe(true);
    }
    expect(await readWatched()).toEqual(keys);
    expect((await rpcReq(watchedWs, "sessions.messages.unsubscribe", { key: "" })).ok).toBe(false);
    expect(await readWatched()).toEqual(keys);

    const disconnected = onceMessage(
      observerWs,
      (message) =>
        message.type === "event" &&
        message.event === "presence" &&
        findWatched(message) === undefined,
    );
    watchedWs.close();
    const event = await disconnected;
    expect(requireRecord(event.payload, "presence payload").presence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connectionId: observerConnId,
          deviceId: watched?.deviceId,
          reason: "connect",
        }),
      ]),
    );
    const declaredPresenceVersion = declaration.stateVersion?.presence ?? 0;
    if (typeof declaredPresenceVersion !== "number") {
      throw new Error("Expected a numeric declared presence version");
    }
    expect(event.stateVersion?.presence).toBeGreaterThan(declaredPresenceVersion);
  });

  test("enforces session-scoped chat delivery on real gateway connections", async () => {
    const storePath = await createSessionStore({
      main: { sessionId: "sess-main" },
      other: { sessionId: "sess-other" },
    });
    const copilotIdentityPath = sessionClientCredentialPath(storePath, "copilot-device");
    using pairingWs = await openTestSocket({ origin: copilotOrigin });
    using mainWs = await openTestSocket({ origin: copilotOrigin });
    using otherWs = await openTestSocket();
    using legacyWs = await openTestSocket();
    const scopedCaps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    await rejectCopilot(
      sessionClientCredentialPath(storePath, "unpaired-copilot-device"),
      { prePairDevice: false },
      { code: "NOT_PAIRED" },
    );

    const pairedHello = await connectOk(pairingWs, {
      ...copilotOptions,
      deviceIdentityPath: copilotIdentityPath,
      prePairDevice: true,
      browserOrigin: copilotOrigin,
    });
    const deviceToken = (pairedHello as { auth?: { deviceToken?: string } }).auth?.deviceToken;
    expect(deviceToken).toBeTruthy();
    pairingWs.close();
    await rejectCopilot(
      copilotIdentityPath,
      { deviceToken, skipDefaultAuth: true },
      { code: "NOT_PAIRED", message: "dedicated paired device identity" },
      "chrome-extension://bcdefghijklmnopabcdefghijklmnopa",
    );

    await connectOk(mainWs, {
      ...copilotOptions,
      deviceIdentityPath: copilotIdentityPath,
      deviceToken,
      skipDefaultAuth: true,
    });
    await connectOk(otherWs, { scopes: ["operator.read"], caps: scopedCaps });
    await connectOk(legacyWs, { scopes: ["operator.read"] });
    await rpcReq(mainWs, "sessions.messages.subscribe", { key: "main" });
    await rpcReq(otherWs, "sessions.messages.subscribe", { key: "other" });

    using otherChats = collectEventPayloads(otherWs, "chat");
    const chatEvents = [mainWs, legacyWs].map((ws) =>
      onceMessage(ws, matchingEvent("chat", { sessionKey: "agent:main:main" })),
    );

    const [send, ...delivered] = await Promise.all([
      rpcReq(mainWs, "chat.send", {
        sessionKey: "main",
        message: "/status",
        toolBindings: {
          browser: {
            kind: "tab",
            tabId: 7,
            target: "host",
            profile: "chrome",
            targetId: "target-7",
          },
        },
        idempotencyKey: "scoped-delivery-proof",
      }),
      ...chatEvents,
    ]);
    expect(send.ok, JSON.stringify(send)).toBe(true);
    expect(delivered).toHaveLength(2);
    // Reasserting existing membership replies after any chat frame already queued on this socket.
    const barrier = rpcReq(otherWs, "sessions.messages.subscribe", { key: "other" });
    await expect(barrier).resolves.toMatchObject({ ok: true });
    expect(otherChats.messages).toHaveLength(0);
  });

  test("rejects client identity changes across a dedicated copilot pairing", async () => {
    const storePath = await createSessionStoreFile();
    const identityPath = sessionClientCredentialPath(storePath, "other-client-device");
    const copilotIdentityPath = sessionClientCredentialPath(storePath, "copilot-paired-device");
    using controlWs = await openTestSocket({ origin: `http://127.0.0.1:${harness.port}` });
    using pairingWs = await openTestSocket({ origin: copilotOrigin });
    using downgradeWs = await openTestSocket();
    const invalidConnections = [
      {
        name: "wrong-mode",
        options: { client: { ...copilotClient, mode: GATEWAY_CLIENT_MODES.WEBCHAT } },
        message: "requires ui mode",
      },
      {
        name: "missing-caps",
        options: { caps: [GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS] },
        message: "session-scoped-events",
      },
      {
        name: "web-origin",
        options: {},
        origin: `http://127.0.0.1:${harness.port}`,
        message: "canonical Chrome extension origin",
      },
    ];
    for (const invalid of invalidConnections) {
      await rejectCopilot(
        sessionClientCredentialPath(storePath, `${invalid.name}-device`),
        { prePairDevice: false, ...invalid.options },
        { message: invalid.message },
        invalid.origin,
      );
    }

    await connectOk(controlWs, {
      client: { ...copilotClient, id: GATEWAY_CLIENT_IDS.CONTROL_UI },
      deviceIdentityPath: identityPath,
      prePairDevice: true,
      scopes: ["operator.read", "operator.write"],
    });
    controlWs.close();

    await rejectCopilot(
      identityPath,
      { prePairDevice: false },
      { code: "NOT_PAIRED", message: "dedicated paired device identity" },
    );

    await connectOk(pairingWs, {
      ...copilotOptions,
      deviceIdentityPath: copilotIdentityPath,
      prePairDevice: true,
      browserOrigin: copilotOrigin,
    });
    pairingWs.close();

    const downgrade = await connectReq(downgradeWs, {
      client: {
        ...copilotClient,
        id: GATEWAY_CLIENT_IDS.TEST,
        mode: GATEWAY_CLIENT_MODES.TEST,
      },
      deviceIdentityPath: copilotIdentityPath,
      prePairDevice: false,
      scopes: ["operator.read", "operator.write"],
    });
    expect(downgrade.ok).toBe(false);
    expect(downgrade.error?.code).toBe("NOT_PAIRED");
    expect(downgrade.error?.message).toContain("dedicated paired device identity");
  });

  registerRecoveredSubagentSessionEventTest({
    createSessionStoreFile,
    withOperatorSessionSubscriber,
    expectNoMessageWithin,
    expectRecordFields,
  });

  test("only sends transcript events to subscribed operator clients", async () => {
    const storePath = await createMainSessionStore();

    using subscribedWs = await openTestSocket();
    using unsubscribedWs = await openTestSocket();
    using nodeWs = await openTestSocket();
    await connectOk(subscribedWs, { scopes: ["operator.read"] });
    await rpcReq(subscribedWs, "sessions.subscribe");
    await connectOk(unsubscribedWs, { scopes: ["operator.read"] });
    await connectOk(nodeWs, { role: "node", scopes: [] });

    const subscribedEvent = waitForSessionMessageEvent(subscribedWs, "agent:main:main");
    const appended = await appendAssistant(storePath, "agent:main:main", "subscribed only");
    const event = await subscribedEvent;
    expectRecordFields(event, {
      type: "event",
      event: "session.message",
    });
    expectRecordFields(event.payload, {
      agentId: "main",
      sessionId: "sess-main",
      sessionKey: "agent:main:main",
      messageId: appended.messageId,
    });
    expectRecordFields(requireRecord(event.payload, "payload").message, {
      role: "assistant",
      content: [{ type: "text", text: "subscribed only" }],
    });
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath,
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({
          content: [{ type: "text", text: "subscribed only" }],
        }),
      }),
    );
    await expectNoMessageWithin({
      watch: (timeoutMs) =>
        onceMessage(unsubscribedWs, matchingEvent("session.message"), timeoutMs),
    });
    await expectNoMessageWithin({
      watch: (timeoutMs) => onceMessage(nodeWs, matchingEvent("session.message"), timeoutMs),
    });
  });

  registerCronSessionCompletionEventTests({
    getHarness: () => harness,
    createSessionStoreFile,
    connectSessionClient,
    waitForSessionMessageEvent,
  });

  test("projects same-clock avatar revisions across socket, history, and message reads", async () => {
    const profileState = await createOpenClawTestState({
      label: "session-message-current-profile-display",
      layout: "state-only",
      prepareProfileCatalog: true,
    });
    cleanupTestStates.push(profileState);
    const sessionId = "sess-current-profile-display";
    const sessionKey = "agent:main:current-profile-display";
    const sessionEntry = { sessionId, updatedAt: 1 };
    const storePath = await createSessionStore({ "current-profile-display": sessionEntry });
    // A deterministic ID avoids UUID fragments that transcript redaction treats as secrets.
    const uuid = vi
      .spyOn(secureRandom, "generateSecureUuid")
      .mockReturnValue("00000000-0000-4000-8000-000000000001");
    const profile = (() => {
      try {
        return ensureProfileForEmail("current-profile-display@example.com");
      } finally {
        uuid.mockRestore();
      }
    })();
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    using ws = await openTestSocket();
    await connectOk(ws, {
      caps: [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
      scopes: ["operator.read"],
    });
    await subscribeMessages(ws, sessionKey);
    const avatar = (message: unknown) => messageMetadata(message).senderProfileAvatarUrl;
    const checkReads = async (messageId: string, expected: string) => {
      const history = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", { sessionKey });
      const direct = await rpcReq<{ ok?: boolean; message?: unknown }>(ws, "chat.message.get", {
        sessionKey,
        messageId,
      });
      expect(history.ok).toBe(true);
      expect(direct).toMatchObject({ ok: true, payload: { ok: true } });
      const row = history.payload?.messages?.find(
        (message) => messageMetadata(message).id === messageId,
      );
      expect([avatar(row), avatar(direct.payload?.message)]).toEqual([expected, expected]);
    };
    let previousAvatar: string | undefined;
    let previousMessageId: string | undefined;
    for (const [index, bytes] of [
      [1, 2, 3],
      [4, 5, 6],
    ].entries()) {
      withMockedDateNow(1_800_000_000_000, () => {
        expect(setAvatar(profile.id, new Uint8Array(bytes), "image/png").ok).toBe(true);
      });
      const currentAvatar = currentProfileAvatarUrl(profile.id);
      expect(currentAvatar).not.toBe(previousAvatar);
      const delivered = waitForSessionMessageEvent(ws, sessionKey);
      const persisted = await persistUserTurnTranscript({
        agentId: "main",
        sessionEntry,
        sessionId,
        sessionKey,
        storePath,
        input: {
          idempotencyKey: `current-profile-display:${index}`,
          sender: {
            id: profile.id,
            identity: { type: "profile", id: profile.id },
            name: "Ada",
            username: "ada",
          },
          text: `attributed turn ${index}`,
        },
      });
      expect(persisted).toBeDefined();
      expect(avatar(eventMessage(await delivered))).toBe(currentAvatar);
      await checkReads(persisted!.messageId, currentAvatar);
      if (previousMessageId) {
        await checkReads(previousMessageId, currentAvatar);
      }
      previousAvatar = currentAvatar;
      previousMessageId = persisted!.messageId;
    }
  });

  test("delivers every message from one committed turn to web and TUI in transcript order", async () => {
    const sessionId = "sess-web-tui-committed-turn";
    const sessionKey = "agent:main:web-tui-committed-turn";
    const storePath = await createSessionStore({ "web-tui-committed-turn": { sessionId } });
    const target = { agentId: "main", sessionId, sessionKey, storePath };

    const earlierMessage = {
      id: "committed-existing-turn",
      text: "An existing message establishes the active-branch sequence.",
    };
    const seeded = await persistSessionTranscriptTurn(target, {
      messages: [userTurn(earlierMessage.id, earlierMessage.text, 1_699_999_999_999)],
    });
    expect(seeded.messages.filter((m) => m.appended)).toHaveLength(1);

    using webWs = await openTestSocket({ origin: `http://127.0.0.1:${harness.port}` });
    using tuiWs = await openTestSocket();
    const committedMessages = [
      { id: "committed-web-turn", text: "The same prompt from either client." },
      { id: "committed-tui-turn", text: "The same prompt from either client." },
      { id: "committed-final-turn", text: "The third message in the same transaction." },
    ];

    await connectSessionClient(webWs, storePath, "committed-web-device", "web");
    await connectSessionClient(tuiWs, storePath, "committed-tui-device", "tui");
    for (const ws of [webWs, tuiWs]) {
      await subscribeMessages(ws, sessionKey);
    }

    using webEvents = collectEventPayloads(webWs, "session.message", { sessionKey });
    using tuiEvents = collectEventPayloads(tuiWs, "session.message", { sessionKey });
    // The final message is the barrier; collectors retain every preceding frame in socket order.
    const deliveriesByClient = [webWs, tuiWs].map((ws) =>
      onceMessage(ws, matchingEvent("session.message", { messageId: "committed-final-turn" })),
    );
    const committedTurn = {
      messages: committedMessages.map(({ id, text }, index) =>
        userTurn(id, text, 1_700_000_000_000 + index),
      ),
    };
    const persisted = await persistSessionTranscriptTurn(target, committedTurn);
    expect(persisted.messages.filter((m) => m.appended)).toHaveLength(committedMessages.length);

    await Promise.all(deliveriesByClient);
    for (const { messages } of [webEvents, tuiEvents]) {
      expect(messages).toMatchObject(
        committedMessages.map(({ id, text }, index) => ({
          messageId: id,
          messageSeq: index + 2,
          sessionKey,
          message: expectedUserMessage(id, text, index + 2),
        })),
      );
    }

    using reconnectedTuiWs = await openTestSocket();
    await connectOk(reconnectedTuiWs, { scopes: ["operator.read"] });
    const history = await rpcReq<{ messages?: unknown[] }>(reconnectedTuiWs, "chat.history", {
      sessionKey,
    });
    reconnectedTuiWs.close();
    expect(history.ok).toBe(true);
    expect(history.payload?.messages).toMatchObject(
      [earlierMessage, ...committedMessages].map(({ id, text }, index) =>
        expectedUserMessage(id, text, index + 1),
      ),
    );

    const duplicateDeliveries = [webWs, tuiWs].map((ws) =>
      onceMessage(ws, matchingEvent("session.message", { sessionKey }), 300).then(
        () => true,
        () => false,
      ),
    );
    const replayed = await persistSessionTranscriptTurn(target, committedTurn);
    expect(replayed.messages.filter((m) => m.appended)).toHaveLength(0);
    await expect(Promise.all(duplicateDeliveries)).resolves.toEqual([false, false]);
  });

  test("forwards blocked placeholders without requiring a transcript file", async () => {
    const storePath = await createMainSessionStore();
    const blocked = { blockedBy: "policy-plugin", blockedAt: 1 };
    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent } = await emitTranscriptUpdateAndCollectMessageEvent({
        ws,
        sessionKey: "agent:main:main",
        sessionFile: path.join(path.dirname(storePath), "sess-main.jsonl"),
        messageId: "blocked-message",
        message: {
          ...textMessage("The agent cannot read this message.", "user"),
          __openclaw: { beforeAgentRunBlocked: blocked },
        },
      });
      const message = eventMessage(messageEvent);
      expectRecordFields(message, {
        role: "user",
        content: [{ type: "text", text: "The agent cannot read this message." }],
      });
      expect(messageMetadata(message).beforeAgentRunBlocked).toEqual(blocked);
    });
  });

  test("does not broadcast hidden runtime-context custom messages as live chat messages", async () => {
    const storePath = await createSessionStore({
      "hidden-runtime": { sessionId: "sess-hidden-runtime" },
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const changedEventPromise = waitForSessionsChangedMessagePhase(
        ws,
        "agent:main:hidden-runtime",
      );
      await expectNoSessionMessage(ws, "agent:main:hidden-runtime", () => {
        emitSessionTranscriptUpdate({
          sessionFile: path.join(path.dirname(storePath), "sess-hidden-runtime.jsonl"),
          sessionKey: "agent:main:hidden-runtime",
          messageId: "runtime-context-1",
          messageSeq: 1,
          message: {
            role: "custom",
            customType: "openclaw.runtime-context",
            content: "secret runtime context",
            display: false,
          },
        });
      });

      const changedEvent = await changedEventPromise;
      expectRecordFields(changedEvent.payload, {
        sessionKey: "agent:main:hidden-runtime",
        phase: "message",
        goal: null,
      });
    });
  });

  test("routes a subscribed global observer event through the real gateway socket once", async () => {
    testState.agentsConfig = { ownership: "explicit", entries: { main: {}, work: {} } };
    testState.agentConfig = { sessionStore: { agentId: "work" } };
    await createSessionStore({ global: { sessionId: "sess-work-observer" } }, "work");
    using workWs = await openTestSocket();
    using mainWs = await openTestSocket();
    const runId = "run-work-global-observer";
    using workEvents = collectEventPayloads(workWs, "session.observer");
    using mainEvents = collectEventPayloads(mainWs, "session.observer");
    try {
      const caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
      await connectOk(workWs, { scopes: ["operator.read"], caps });
      await connectOk(mainWs, { scopes: ["operator.read"], caps });
      expect(
        await rpcReq(workWs, "sessions.messages.subscribe", {
          key: " GLOBAL ",
          agentId: " WORK ",
        }),
      ).toMatchObject({ ok: true, payload: { key: "global", subscribed: true } });
      expect(
        await rpcReq(mainWs, "sessions.messages.subscribe", { key: "global", agentId: "main" }),
      ).toMatchObject({ ok: false });
      await rpcReq(workWs, "sessions.observer.visibility", { visible: true });
      await rpcReq(mainWs, "sessions.observer.visibility", { visible: true });

      const workEvent = waitForSessionObserverEvent(workWs, runId);
      const noMainEvent = expectNoMessageWithin({
        watch: (timeoutMs) => waitForSessionObserverEvent(mainWs, runId, timeoutMs),
        timeoutMs: 250,
      });
      emitAgentEvent({
        runId,
        sessionKey: "global",
        agentId: "work",
        stream: "item",
        data: {
          kind: "preamble",
          phase: "update",
          progressText: "Inspecting the work session",
        },
      });

      await workEvent;
      await noMainEvent;
      // A response on each socket follows every event already queued for that client.
      await expect(
        rpcReq(workWs, "sessions.messages.subscribe", { key: "global", agentId: "work" }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        rpcReq(mainWs, "sessions.observer.visibility", { visible: true }),
      ).resolves.toMatchObject({ ok: true });
      expect(workEvents.messages).toHaveLength(1);
      expect(mainEvents.messages).toHaveLength(0);
    } finally {
      testState.agentsConfig = undefined;
      testState.agentConfig = undefined;
      testState.sessionStorePath = undefined;
    }
  });

  test("includes spawn and route metadata on session.message transcript events", async () => {
    const goal = activeGoal("goal-child", "Finish child work", 42);
    const metadata = {
      spawnedBy: "agent:main:main",
      ...spawnMetadata,
      spawnedCwd: "/tmp/task-repo",
      displayName: "Ops Child",
      goal,
      parentSessionKey: "agent:main:main",
      lastChannel: "telegram",
      lastTo: "-100123",
      lastAccountId: "acct-1",
      lastThreadId: 42,
    };
    const message = textMessage("spawn and thread route snapshot");
    await createSessionStore({ child: { sessionId: "sess-child", ...metadata } });
    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent } = await emitTranscriptUpdateAndCollectMessageEvent({
        ws,
        sessionKey: "agent:main:child",
        sessionFile: "agent:main:child",
        message,
        messageId: "msg-spawn",
      });
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:child",
        ...metadata,
        goal: { ...goal, tokenStartFresh: true },
      });
    });
  });

  test("sessions.messages.subscribe only delivers transcript events for the requested session", async () => {
    const storePath = await createSessionStore({
      main: { sessionId: "sess-main" },
      worker: { sessionId: "sess-worker" },
    });
    using ws = await openTestSocket();
    await connectOk(ws, { scopes: ["operator.read"] });
    await subscribeMessages(ws, "agent:main:main");

    const mainEvent = waitForSessionMessageEvent(ws, "agent:main:main");
    await Promise.all([appendAssistant(storePath, "agent:main:main", "main only"), mainEvent]);
    await expectNoSessionMessage(ws, "agent:main:worker", () =>
      appendAssistant(storePath, "agent:main:worker", "worker hidden"),
    );

    const unsubscribeRes = await rpcReq(ws, "sessions.messages.unsubscribe", {
      key: "agent:main:main",
    });
    expect(unsubscribeRes.ok).toBe(true);
    expect(unsubscribeRes.payload?.subscribed).toBe(false);

    await expectNoSessionMessage(ws, "agent:main:main", () =>
      appendAssistant(storePath, "agent:main:main", "hidden after unsubscribe"),
    );
  });

  test("streams worker commits and local-equivalent live events to the selected session", async () => {
    const sessionId = "sess-worker-commit-fanout";
    const sessionKey = "agent:main:worker";
    const storePath = await createSessionStore({ worker: { sessionId } });
    const { committer, identity, receiver, push, sessionTarget, source } =
      await createWorkerFanoutFixture({
        storePath,
        sessionId,
        sessionKey,
      });
    using ws = await openTestSocket();
    using workerChats = collectEventPayloads(ws, "chat", { runId: "worker" });
    try {
      await connectOk(ws, { scopes: ["operator.read"] });
      await subscribeMessages(ws, sessionKey);

      const eventPromises = [1, 2, 3].map((messageSeq) =>
        onceMessage(ws, matchingEvent("session.message", { sessionKey, messageSeq })),
      );
      const outcome = await committer.commit({
        assertCurrent: () => {
          source.receiptAuthority();
          return undefined;
        },
        sessionTarget,
        identity,
        request: {
          runEpoch: identity.ownerEpoch,
          seq: 1,
          baseLeafId: null,
          messages: ["first", "second", "third"].map((text, index) => ({
            role: "user" as const,
            content: [{ type: "text" as const, text }],
            timestamp: 100 + index,
          })),
        },
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        throw new Error(`expected worker transcript commit, received ${outcome.reason}`);
      }
      const events = await Promise.all(eventPromises);
      const payloads = events.map((event) =>
        requireRecord(event.payload, "session.message payload"),
      );
      expect(
        payloads.map((payload) => {
          const metadata = messageMetadata(payload.message);
          return [payload.messageId, payload.messageSeq, metadata.id, metadata.seq];
        }),
      ).toEqual(outcome.result.entryIds.map((id, index) => [id, index + 1, id, index + 1]));

      const waitForChat = (runId: string, timeoutMs?: number) =>
        onceMessage(ws, matchingEvent("chat", { runId }), timeoutMs);
      const [workerEvent] = await Promise.all([
        waitForChat("worker"),
        expectNoSessionMessage(ws, sessionKey, async () => {
          expect((await push()).ok).toBe(true);
        }),
      ]);
      const workerChat = requireRecord(workerEvent.payload, "worker chat");
      await expectNoMessageWithin({
        watch: (timeoutMs) => waitForChat("worker", timeoutMs),
        action: async () => {
          expect(await push()).toEqual({ ok: true, result: { ackedSeq: 1 } });
        },
      });
      expect(workerChats.messages).toHaveLength(1);

      claimAgentRunContext("local", {
        sessionKey,
        sessionId,
        agentId: "main",
        isControlUiVisible: false,
      });
      const localEvent = waitForChat("local");
      emitAgentEvent({
        runId: "local",
        stream: "assistant",
        data: { text: "hello", delta: "hello" },
      });
      const localChat = requireRecord((await localEvent).payload, "local chat");
      for (const payload of [workerChat, localChat]) {
        payload.runId = "normalized";
        requireRecord(payload.message, "chat message").timestamp = 0;
      }
      expect(workerChat).toEqual(localChat);
      await expectNoMessageWithin({
        watch: (timeoutMs) => waitForChat("stale", timeoutMs),
        action: async () => {
          expect((await push(3, "stale")).ok).toBe(false);
        },
      });
    } finally {
      receiver.clear();
      clearAgentRunContext("local");
      ws.close();
      await source.release();
    }
  });
});
