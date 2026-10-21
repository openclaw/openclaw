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
import { SESSION_VIEWER_PRESENCE_MAX_KEYS } from "../../packages/gateway-protocol/src/schema/sessions-viewer-presence.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { claimAgentRunContext, clearAgentRunContext } from "../infra/agent-run-registry.js";
import * as secureRandom from "../infra/secure-random.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { persistUserTurnTranscript } from "../sessions/user-turn-transcript.test-support.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setAvatar, setDisplayName } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail, listProfiles } from "../state/user-profiles.js";
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
import { seedCompletedSessionTranscript } from "./session-row-fixtures.test-support.js";
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
  if (harness) {
    await harness.close();
  }
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

async function createMainSessionStore(
  entry: Parameters<typeof writeSessionStore>[0]["entries"][string] = {},
): Promise<string> {
  return createSessionStore({ main: { sessionId: "sess-main", ...entry } });
}

type GatewayWs = Awaited<ReturnType<typeof harness.openWs>>;
type StoreEntries = Parameters<typeof writeSessionStore>[0]["entries"];

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

async function writeTranscriptFixture(
  transcriptPath: string,
  sessionId: string,
  messageId: string,
  message: Record<string, unknown>,
) {
  await fs.writeFile(
    transcriptPath,
    [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ id: messageId, message }),
    ].join("\n"),
    "utf-8",
  );
}

async function createTranscriptSession(
  key: string,
  sessionId: string,
  messageId: string,
  message: Record<string, unknown>,
  entry: StoreEntries[string] = {},
  agentId?: string,
) {
  const storePath = await createSessionStoreFile();
  const transcriptPath = path.join(path.dirname(storePath), `${sessionId}.jsonl`);
  await writeSessionStore({
    entries: { [key]: { sessionId, sessionFile: transcriptPath, updatedAt: Date.now(), ...entry } },
    storePath,
    ...(agentId ? { agentId } : {}),
  });
  await writeTranscriptFixture(transcriptPath, sessionId, messageId, message);
  return { storePath, transcriptPath };
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

function waitForSessionMessageEvent(ws: GatewayWs, sessionKey: string, timeoutMs?: number) {
  return onceMessage(ws, matchingEvent("session.message", { sessionKey }), timeoutMs);
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

  emitSessionTranscriptUpdate({
    sessionFile: params.sessionFile,
    sessionKey: params.sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    message: params.message,
    messageId: params.messageId,
    ...(typeof params.messageSeq === "number" ? { messageSeq: params.messageSeq } : {}),
  });

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

function attributedMessageProjection(value: unknown) {
  const message = requireRecord(value, "attributed message");
  const metadata = requireRecord(message["__openclaw"], "attributed message metadata");
  return {
    role: message.role,
    content: message.content,
    __openclaw: {
      senderId: metadata.senderId,
      senderIdentity: metadata.senderIdentity,
      senderName: metadata.senderName,
      senderUsername: metadata.senderUsername,
      senderProfileAvatarUrl: metadata.senderProfileAvatarUrl,
    },
  };
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
  test("publishes only the explicit per-connection viewer replace-set", async () => {
    const observerWs = await harness.openWs();
    const watchedWs = await harness.openWs();
    const instanceId = "presence-watched-sessions";
    try {
      const observerConnId = getConnId(await connectOk(observerWs, { scopes: ["operator.read"] }));
      const watchedHello = await connectOk(watchedWs, {
        scopes: ["operator.read"],
        client: {
          id: GATEWAY_CLIENT_IDS.TEST,
          version: "1.0.0",
          platform: "test",
          mode: GATEWAY_CLIENT_MODES.TEST,
          instanceId,
        },
      });
      const initialPresenceVersion = (
        watchedHello as { snapshot?: { stateVersion?: { presence?: number } } }
      ).snapshot?.stateVersion?.presence;
      expect(initialPresenceVersion).toEqual(expect.any(Number));

      const findWatchedEntry = (message: unknown) => findWatchedPresenceEntry(message, instanceId);
      const declaredKeys = ["agent:main:watch-00", "agent:main:watch-01"];
      const replacementKey = "agent:main:replacement";
      const storePath = await createSessionStoreFile();
      await writeSessionStore({
        storePath,
        entries: Object.fromEntries(
          [...declaredKeys, replacementKey].map((key) => [
            key,
            { sessionId: key, updatedAt: Date.now() },
          ]),
        ),
      });
      const declaredPresence = onceMessage(observerWs, (message) => {
        const entry = findWatchedEntry(message);
        return (
          Array.isArray(entry?.watchedSessions) &&
          JSON.stringify(entry.watchedSessions) === JSON.stringify(declaredKeys)
        );
      });
      const declaration = await rpcReq(watchedWs, "sessions.viewers.set", {
        sessionKeys: [declaredKeys[1], declaredKeys[0], declaredKeys[1]],
      });
      expect(declaration).toMatchObject({ ok: true, payload: { sessionKeys: declaredKeys } });
      const declaredEvent = await declaredPresence;
      const declaredEntry = findWatchedEntry(declaredEvent);
      expect(declaredEntry?.watchedSessions).toEqual(declaredKeys);
      expect(declaredEntry?.deviceId).toEqual(expect.any(String));
      const ownerProfile = (await listProfiles()).find((profile) => profile.emails.length === 0);
      expect(ownerProfile).toBeDefined();
      expect(declaredEntry?.user).toEqual({
        id: ownerProfile!.id,
        identity: { type: "profile", id: ownerProfile!.id },
        avatarUrl: currentProfileAvatarUrl(ownerProfile!.id),
        ...(ownerProfile!.displayName ? { name: ownerProfile!.displayName } : {}),
      });
      expect(declaredEvent.stateVersion?.presence).toBeGreaterThan(initialPresenceVersion ?? 0);

      // Sidebar narration owns message subscriptions for running rows, but those
      // transport watches must never impersonate viewer presence.
      const narrationKeys = Array.from(
        { length: 6 },
        (_, index) => `agent:main:narration-${index}`,
      );
      for (const key of narrationKeys) {
        const response = await rpcReq(watchedWs, "sessions.messages.subscribe", { key });
        expect(response.ok).toBe(true);
      }
      const afterNarration = await rpcReq(observerWs, "system-presence", {});
      expect(
        (afterNarration.payload as unknown as Array<Record<string, unknown>>).find(
          (entry) => entry.instanceId === instanceId,
        )?.watchedSessions,
      ).toEqual(declaredKeys);

      // A failed message release cannot change the independently declared set.
      const failedUnsubscribe = await rpcReq(watchedWs, "sessions.messages.unsubscribe", {
        key: "",
      });
      expect(failedUnsubscribe.ok).toBe(false);
      const afterFailedUnsubscribe = await rpcReq(observerWs, "system-presence", {});
      expect(
        (afterFailedUnsubscribe.payload as unknown as Array<Record<string, unknown>>).find(
          (entry) => entry.instanceId === instanceId,
        )?.watchedSessions,
      ).toEqual(declaredKeys);

      const replacementPresence = onceMessage(observerWs, (message) => {
        const entry = findWatchedEntry(message);
        return Array.isArray(entry?.watchedSessions) && entry.watchedSessions[0] === replacementKey;
      });
      const replacement = await rpcReq(watchedWs, "sessions.viewers.set", {
        sessionKeys: [replacementKey],
      });
      expect(replacement).toMatchObject({ ok: true, payload: { sessionKeys: [replacementKey] } });
      const replacementEvent = await replacementPresence;
      expect(findWatchedEntry(replacementEvent)?.watchedSessions).toEqual([replacementKey]);

      const oversized = await rpcReq(watchedWs, "sessions.viewers.set", {
        sessionKeys: Array.from(
          { length: SESSION_VIEWER_PRESENCE_MAX_KEYS + 1 },
          (_, index) => `agent:main:oversized-${index}`,
        ),
      });
      expect(oversized.ok).toBe(false);
      const afterOversized = await rpcReq(observerWs, "system-presence", {});
      expect(
        (afterOversized.payload as unknown as Array<Record<string, unknown>>).find(
          (entry) => entry.instanceId === instanceId,
        )?.watchedSessions,
      ).toEqual([replacementKey]);

      const hiddenPresence = onceMessage(observerWs, (message) => {
        const entry = findWatchedEntry(message);
        return entry !== undefined && entry.watchedSessions === undefined;
      });
      expect(
        await rpcReq(watchedWs, "sessions.viewers.set", {
          sessionKeys: [],
        }),
      ).toMatchObject({ ok: true, payload: { sessionKeys: [] } });
      const hiddenEvent = await hiddenPresence;
      expect(findWatchedEntry(hiddenEvent)?.watchedSessions).toBeUndefined();

      const redeclaredPresence = onceMessage(observerWs, (message) => {
        const entry = findWatchedEntry(message);
        return Array.isArray(entry?.watchedSessions) && entry.watchedSessions[0] === replacementKey;
      });
      await rpcReq(watchedWs, "sessions.viewers.set", { sessionKeys: [replacementKey] });
      const redeclaredEvent = await redeclaredPresence;

      // The live same-device observer keeps its row; the disconnected tab is removed.
      const disconnectPresence = onceMessage(observerWs, (message) => {
        return (
          message.type === "event" &&
          message.event === "presence" &&
          findWatchedEntry(message) === undefined
        );
      });
      watchedWs.close();
      const disconnectedEvent = await disconnectPresence;
      expect(requireRecord(disconnectedEvent.payload, "presence payload").presence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            connectionId: observerConnId,
            deviceId: declaredEntry?.deviceId,
            reason: "connect",
          }),
        ]),
      );
      const redeclaredPresenceVersion = redeclaredEvent.stateVersion?.presence;
      expect(disconnectedEvent.stateVersion?.presence).toBeGreaterThan(
        typeof redeclaredPresenceVersion === "number" ? redeclaredPresenceVersion : 0,
      );
    } finally {
      observerWs.close();
      watchedWs.close();
    }
  });

  test("enforces session-scoped chat delivery on real gateway connections", async () => {
    const storePath = await createSessionStore({
      main: { sessionId: "sess-main" },
      other: { sessionId: "sess-other" },
    });
    const copilotIdentityPath = sessionClientCredentialPath(storePath, "copilot-device");
    const unpairedWs = await harness.openWs({ origin: copilotOrigin });
    const pairingWs = await harness.openWs({ origin: copilotOrigin });
    const wrongOriginWs = await harness.openWs({
      origin: "chrome-extension://bcdefghijklmnopabcdefghijklmnopa",
    });
    const mainWs = await harness.openWs({ origin: copilotOrigin });
    const otherWs = await harness.openWs();
    const legacyWs = await harness.openWs();
    let otherReceived = false;
    const observeOtherChat = (data: RawData) => {
      const message = requireRecord(JSON.parse(rawDataToString(data)), "gateway message");
      otherReceived ||= message.type === "event" && message.event === "chat";
    };
    try {
      const scopedCaps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
      const unpaired = await connectReq(unpairedWs, {
        ...copilotOptions,
        prePairDevice: false,
        deviceIdentityPath: sessionClientCredentialPath(storePath, "unpaired-copilot-device"),
      });
      expect(unpaired.ok).toBe(false);
      expect(unpaired.error?.code).toBe("NOT_PAIRED");
      unpairedWs.close();

      const pairedHello = await connectOk(pairingWs, {
        ...copilotOptions,
        deviceIdentityPath: copilotIdentityPath,
        prePairDevice: true,
        browserOrigin: copilotOrigin,
      });
      const deviceToken = (pairedHello as { auth?: { deviceToken?: string } }).auth?.deviceToken;
      expect(deviceToken).toBeTruthy();
      pairingWs.close();
      const wrongOrigin = await connectReq(wrongOriginWs, {
        ...copilotOptions,
        deviceIdentityPath: copilotIdentityPath,
        deviceToken,
        skipDefaultAuth: true,
      });
      expect(wrongOrigin.ok).toBe(false);
      expect(wrongOrigin.error?.code).toBe("NOT_PAIRED");
      expect(wrongOrigin.error?.message).toContain("dedicated paired device identity");
      wrongOriginWs.close();

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

      otherWs.on("message", observeOtherChat);
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
      expect(otherReceived).toBe(false);
    } finally {
      otherWs.off("message", observeOtherChat);
      unpairedWs.close();
      pairingWs.close();
      wrongOriginWs.close();
      mainWs.close();
      otherWs.close();
      legacyWs.close();
    }
  });

  test("rejects client identity changes across a dedicated copilot pairing", async () => {
    const storePath = await createSessionStoreFile();
    const identityPath = sessionClientCredentialPath(storePath, "other-client-device");
    const copilotIdentityPath = sessionClientCredentialPath(storePath, "copilot-paired-device");
    const controlWs = await harness.openWs({ origin: `http://127.0.0.1:${harness.port}` });
    const copilotWs = await harness.openWs({
      origin: copilotOrigin,
    });
    const pairingWs = await harness.openWs({
      origin: copilotOrigin,
    });
    const downgradeWs = await harness.openWs();
    const wrongModeWs = await harness.openWs({
      origin: copilotOrigin,
    });
    const webOriginWs = await harness.openWs({ origin: `http://127.0.0.1:${harness.port}` });
    const missingCapsWs = await harness.openWs({
      origin: copilotOrigin,
    });
    try {
      const wrongMode = await connectReq(wrongModeWs, {
        ...copilotOptions,
        prePairDevice: false,
        client: {
          ...copilotClient,
          id: GATEWAY_CLIENT_IDS.BROWSER_COPILOT,
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        },
        deviceIdentityPath: sessionClientCredentialPath(storePath, "wrong-mode-device"),
      });
      expect(wrongMode.ok).toBe(false);
      expect(wrongMode.error?.message).toContain("requires ui mode");
      wrongModeWs.close();

      const missingCaps = await connectReq(missingCapsWs, {
        ...copilotOptions,
        caps: [GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS],
        deviceIdentityPath: sessionClientCredentialPath(storePath, "missing-caps-device"),
        prePairDevice: false,
        scopes: ["operator.read", "operator.write"],
      });
      expect(missingCaps.ok).toBe(false);
      expect(missingCaps.error?.message).toContain("session-scoped-events");
      missingCapsWs.close();

      const webOrigin = await connectReq(webOriginWs, {
        ...copilotOptions,
        prePairDevice: false,
        deviceIdentityPath: sessionClientCredentialPath(storePath, "web-origin-device"),
      });
      expect(webOrigin.ok).toBe(false);
      expect(webOrigin.error?.message).toContain("canonical Chrome extension origin");
      webOriginWs.close();

      await connectOk(controlWs, {
        client: { ...copilotClient, id: GATEWAY_CLIENT_IDS.CONTROL_UI },
        deviceIdentityPath: identityPath,
        prePairDevice: true,
        scopes: ["operator.read", "operator.write"],
      });
      controlWs.close();

      const response = await connectReq(copilotWs, {
        ...copilotOptions,
        prePairDevice: false,
        deviceIdentityPath: identityPath,
      });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("NOT_PAIRED");
      expect(response.error?.message).toContain("dedicated paired device identity");

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
    } finally {
      controlWs.close();
      copilotWs.close();
      pairingWs.close();
      downgradeWs.close();
      wrongModeWs.close();
      webOriginWs.close();
      missingCapsWs.close();
    }
  });

  registerRecoveredSubagentSessionEventTest({
    createSessionStoreFile,
    withOperatorSessionSubscriber,
    expectNoMessageWithin,
    expectRecordFields,
  });

  test("includes spawned session ownership metadata on lifecycle sessions.changed events", async () => {
    await createSessionStore({
      child: {
        sessionId: "sess-child",
        goal: activeGoal("goal-child", "Finish child work", 42),
        spawnedBy: "agent:main:parent",
        ...spawnMetadata,
        spawnedCwd: "/tmp/task-repo",
        displayName: "Ops Child",
      },
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const changedEvent = onceMessage(
        ws,
        matchingEvent("sessions.changed", { sessionKey: "agent:main:child" }),
      );

      emitSessionLifecycleEvent({
        sessionKey: "agent:main:child",
        reason: "reactivated",
      });

      const event = await changedEvent;
      expectRecordFields(event.payload, {
        sessionKey: "agent:main:child",
        reason: "reactivated",
        spawnedBy: "agent:main:parent",
        ...spawnMetadata,
        spawnedCwd: "/tmp/task-repo",
        displayName: "Ops Child",
        goal: { ...activeGoal("goal-child", "Finish child work", 42), tokenStartFresh: true },
      });
    });
  });

  test("only sends transcript events to subscribed operator clients", async () => {
    const storePath = await createMainSessionStore();

    const subscribedWs = await harness.openWs();
    const unsubscribedWs = await harness.openWs();
    const nodeWs = await harness.openWs();
    try {
      await connectOk(subscribedWs, { scopes: ["operator.read"] });
      await rpcReq(subscribedWs, "sessions.subscribe");
      await connectOk(unsubscribedWs, { scopes: ["operator.read"] });
      await connectOk(nodeWs, { role: "node", scopes: [] });

      const subscribedEvent = waitForSessionMessageEvent(subscribedWs, "agent:main:main");
      const appended = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "subscribed only",
        storePath,
      });
      expect(appended.ok).toBe(true);
      const event = await subscribedEvent;
      expectRecordFields(event, {
        type: "event",
        event: "session.message",
      });
      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(unsubscribedWs, matchingEvent("session.message"), timeoutMs),
      });
      await expectNoMessageWithin({
        watch: (timeoutMs) => onceMessage(nodeWs, matchingEvent("session.message"), timeoutMs),
      });
    } finally {
      subscribedWs.close();
      unsubscribedWs.close();
      nodeWs.close();
    }
  });

  test("keeps web and TUI subscribers on the same authoritative session transcript", async () => {
    const sessionId = "sess-web-tui-shared";
    const sessionKey = "agent:main:web-tui-shared";
    const storePath = await createSessionStore({ "web-tui-shared": { sessionId } });

    const webWs = await harness.openWs({ origin: `http://127.0.0.1:${harness.port}` });
    const tuiWs = await harness.openWs();
    let reconnectedTuiWs: Awaited<ReturnType<typeof harness.openWs>> | undefined;
    try {
      await connectSessionClient(webWs, storePath, "shared-web-device", "web");
      await connectSessionClient(tuiWs, storePath, "shared-tui-device", "tui");
      for (const ws of [webWs, tuiWs]) {
        const subscription = await rpcReq(ws, "sessions.messages.subscribe", {
          key: sessionKey,
        });
        expect(subscription.ok).toBe(true);
      }

      const sharedMessages = [
        "Sent from the web.",
        "Sent from the TUI.",
        ...Array.from({ length: 30 }, (_, index) => `Shared burst message ${index + 1}.`),
      ];
      for (const [index, text] of sharedMessages.entries()) {
        const messageId = `shared-turn-${index + 1}`;
        const deliveries = [webWs, tuiWs].map((ws) =>
          onceMessage(ws, matchingEvent("session.message", { messageId })),
        );
        const persisted = await persistSessionTranscriptTurn(
          { agentId: "main", sessionId, sessionKey, storePath },
          {
            messages: [userTurn(messageId, text)],
          },
        );
        expect(persisted.appendedCount).toBe(1);
        for (const delivery of await Promise.all(deliveries)) {
          expectRecordFields(delivery.payload, {
            messageId,
            messageSeq: index + 1,
            sessionKey,
          });
          expect(requireRecord(delivery.payload, "shared session event").message).toMatchObject(
            expectedUserMessage(messageId, text, index + 1),
          );
        }
      }

      tuiWs.close();
      reconnectedTuiWs = await harness.openWs();
      await connectOk(reconnectedTuiWs, { scopes: ["operator.read"] });
      const history = await rpcReq(reconnectedTuiWs, "chat.history", { sessionKey });
      expect(history.ok).toBe(true);
      expect((history.payload as { messages?: unknown[] }).messages).toMatchObject(
        sharedMessages.map((text) => ({
          content: [{ type: "text", text }],
          role: "user",
        })),
      );
    } finally {
      webWs.close();
      tuiWs.close();
      reconnectedTuiWs?.close();
    }
  });

  registerCronSessionCompletionEventTests({
    getHarness: () => harness,
    createSessionStoreFile,
    connectSessionClient,
    waitForSessionMessageEvent,
  });

  test("projects current revisioned sender avatars consistently across live events and RPC reads", async () => {
    const SHARED_REV = 1_800_000_000_000;
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

    const profile = withMockedDateNow(SHARED_REV, () => {
      // Avoid random UUID spans such as `fc-...` that transcript redaction treats as secrets.
      const created = (() => {
        const profileIdSpy = vi
          .spyOn(secureRandom, "generateSecureUuid")
          .mockReturnValue("00000000-0000-4000-8000-000000000001");
        try {
          return ensureProfileForEmail("current-profile-display@example.com");
        } finally {
          profileIdSpy.mockRestore();
        }
      })();
      setDisplayName(created.id, "Old Display Name");
      expect(setAvatar(created.id, new Uint8Array([1, 2, 3]), "image/png").ok).toBe(true);
      return created;
    });
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const firstAvatarUrl = currentProfileAvatarUrl(profile.id);

    const ws = await harness.openWs();
    try {
      await connectOk(ws, {
        caps: [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
        scopes: ["operator.read"],
      });
      const subscription = await rpcReq(ws, "sessions.messages.subscribe", { key: sessionKey });
      expect(subscription.ok).toBe(true);

      const persistTurn = async (params: {
        idempotencyKey: string;
        senderName: string;
        text: string;
      }) => {
        const liveEvent = waitForSessionMessageEvent(ws, sessionKey);
        const persisted = await persistUserTurnTranscript({
          agentId: "main",
          sessionEntry,
          sessionId,
          sessionKey,
          storePath,
          input: {
            idempotencyKey: params.idempotencyKey,
            sender: {
              id: profile.id,
              identity: { type: "profile", id: profile.id },
              name: params.senderName,
              username: "ada",
            },
            text: params.text,
          },
        });
        expect(persisted).toBeDefined();
        return { persisted: persisted!, liveEvent: await liveEvent };
      };
      const readHistoryMessage = async (messageId: string) => {
        const response = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
          sessionKey,
        });
        expect(response.ok).toBe(true);
        const messages = response.payload?.messages ?? [];
        const message = messages.find((candidate) => {
          const record = requireRecord(candidate, "history message");
          const metadata = requireRecord(record["__openclaw"], "history message metadata");
          return metadata.id === messageId;
        });
        expect(message).toBeDefined();
        return message;
      };
      const readMessage = async (messageId: string) => {
        const response = await rpcReq<{ ok?: boolean; message?: unknown }>(ws, "chat.message.get", {
          sessionKey,
          messageId,
        });
        expect(response.ok).toBe(true);
        expect(response.payload?.ok).toBe(true);
        return response.payload?.message;
      };
      const expectedProjection = (text: string, senderName: string, avatarUrl: string) => ({
        role: "user",
        content: text,
        __openclaw: {
          senderId: profile.id,
          senderIdentity: { type: "profile", id: profile.id },
          senderName,
          senderUsername: "ada",
          senderProfileAvatarUrl: avatarUrl,
        },
      });
      const expectRpcParity = async (messageId: string, expected: unknown) => {
        expect(attributedMessageProjection(await readHistoryMessage(messageId))).toEqual(expected);
        expect(attributedMessageProjection(await readMessage(messageId))).toEqual(expected);
      };
      const expectEmitterParity = async (
        turn: Awaited<ReturnType<typeof persistTurn>>,
        expected: unknown,
      ) => {
        const liveMessage = requireRecord(
          turn.liveEvent.payload,
          "session.message payload",
        ).message;
        expect(attributedMessageProjection(liveMessage)).toEqual(expected);
        await expectRpcParity(turn.persisted.messageId, expected);
      };

      const first = await persistTurn({
        idempotencyKey: "current-profile-display:first",
        senderName: "Historical Ada",
        text: "first attributed turn",
      });
      const firstExpected = expectedProjection(
        "first attributed turn",
        "Historical Ada",
        firstAvatarUrl,
      );
      await expectEmitterParity(first, firstExpected);

      withMockedDateNow(SHARED_REV, () => {
        setDisplayName(profile.id, "Current Ada");
        expect(setAvatar(profile.id, new Uint8Array([4, 5, 6]), "image/png").ok).toBe(true);
      });
      const secondAvatarUrl = currentProfileAvatarUrl(profile.id);
      expect(secondAvatarUrl).not.toBe(firstAvatarUrl);

      const second = await persistTurn({
        idempotencyKey: "current-profile-display:second",
        senderName: "Current Ada",
        text: "second attributed turn",
      });
      const secondExpected = expectedProjection(
        "second attributed turn",
        "Current Ada",
        secondAvatarUrl,
      );
      await expectEmitterParity(second, secondExpected);

      const refreshedFirstExpected = expectedProjection(
        "first attributed turn",
        "Historical Ada",
        secondAvatarUrl,
      );
      await expectRpcParity(first.persisted.messageId, refreshedFirstExpected);
    } finally {
      ws.close();
    }
  });

  test("delivers every message from one committed turn to web and TUI in transcript order", async () => {
    const sessionId = "sess-web-tui-committed-turn";
    const sessionKey = "agent:main:web-tui-committed-turn";
    const storePath = await createSessionStore({ "web-tui-committed-turn": { sessionId } });

    const earlierMessage = {
      id: "committed-existing-turn",
      text: "An existing message establishes the active-branch sequence.",
    };
    const seeded = await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        messages: [userTurn(earlierMessage.id, earlierMessage.text, 1_699_999_999_999)],
      },
    );
    expect(seeded.appendedCount).toBe(1);

    const webWs = await harness.openWs({ origin: `http://127.0.0.1:${harness.port}` });
    const tuiWs = await harness.openWs();
    const committedMessages = [
      { id: "committed-web-turn", text: "The same prompt from either client." },
      { id: "committed-tui-turn", text: "The same prompt from either client." },
      { id: "committed-final-turn", text: "The third message in the same transaction." },
    ];

    try {
      await connectSessionClient(webWs, storePath, "committed-web-device", "web");
      await connectSessionClient(tuiWs, storePath, "committed-tui-device", "tui");
      for (const ws of [webWs, tuiWs]) {
        const subscription = await rpcReq(ws, "sessions.messages.subscribe", {
          key: sessionKey,
        });
        expect(subscription.ok).toBe(true);
      }

      const observedByClient: Array<
        Array<{ messageId: unknown; messageSeq: unknown; sessionKey: unknown }>
      > = [[], []];
      for (const [clientIndex, ws] of [webWs, tuiWs].entries()) {
        const observed = observedByClient[clientIndex];
        if (!observed) {
          throw new Error(`missing committed-turn observer for client ${clientIndex}`);
        }
        ws.on("message", (data: RawData) => {
          const frame = JSON.parse(rawDataToString(data)) as {
            event?: string;
            payload?: { messageId?: unknown; messageSeq?: unknown; sessionKey?: unknown };
            type?: string;
          };
          if (
            frame.type === "event" &&
            frame.event === "session.message" &&
            frame.payload?.sessionKey === sessionKey
          ) {
            observed.push({
              messageId: frame.payload.messageId,
              messageSeq: frame.payload.messageSeq,
              sessionKey: frame.payload.sessionKey,
            });
          }
        });
      }

      // Install every real socket listener before the one SQLite commit can broadcast.
      const deliveriesByClient = [webWs, tuiWs].map((ws) =>
        committedMessages.map(({ id }) =>
          onceMessage(ws, matchingEvent("session.message", { messageId: id })),
        ),
      );
      const committedTurn = {
        messages: committedMessages.map(({ id, text }, index) =>
          userTurn(id, text, 1_700_000_000_000 + index),
        ),
      };
      const persisted = await persistSessionTranscriptTurn(
        { agentId: "main", sessionId, sessionKey, storePath },
        committedTurn,
      );
      expect(persisted.appendedCount).toBe(committedMessages.length);

      for (const [clientIndex, clientDeliveries] of deliveriesByClient.entries()) {
        const frames = await Promise.all(clientDeliveries);
        expect(observedByClient[clientIndex]).toEqual(
          committedMessages.map(({ id }, index) => ({
            messageId: id,
            messageSeq: index + 2,
            sessionKey,
          })),
        );
        expect(
          frames.map((frame) => {
            const payload = requireRecord(frame.payload, "committed session event");
            return {
              messageId: payload.messageId,
              messageSeq: payload.messageSeq,
              sessionKey: payload.sessionKey,
            };
          }),
        ).toEqual(
          committedMessages.map(({ id }, index) => ({
            messageId: id,
            messageSeq: index + 2,
            sessionKey,
          })),
        );
        for (const [index, frame] of frames.entries()) {
          const expected = committedMessages[index];
          if (!expected) {
            throw new Error(`unexpected committed-turn delivery at index ${index}`);
          }
          expect(requireRecord(frame.payload, "committed session event").message).toMatchObject(
            expectedUserMessage(expected.id, expected.text, index + 2),
          );
        }
      }

      const history = await rpcReq(tuiWs, "chat.history", { sessionKey });
      expect(history.ok).toBe(true);
      expect((history.payload as { messages?: unknown[] }).messages).toMatchObject(
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
      const replayed = await persistSessionTranscriptTurn(
        { agentId: "main", sessionId, sessionKey, storePath },
        committedTurn,
      );
      expect(replayed.appendedCount).toBe(0);
      await expect(Promise.all(duplicateDeliveries)).resolves.toEqual([false, false]);
    } finally {
      webWs.close();
      tuiWs.close();
    }
  });

  test("invalidates the selected web and TUI transcript once for an identity-only committed turn", async () => {
    const sessionId = "sess-web-tui-identity-only";
    const sessionKey = "agent:main:web-tui-identity-only";
    const lifecycleRevision = "identity-only-committed-revision";
    const storePath = await createSessionStore({
      "web-tui-identity-only": { sessionId, lifecycleRevision },
      "web-tui-wrong-session": { sessionId: "sess-web-tui-wrong-session" },
    });

    const webWs = await harness.openWs({ origin: `http://127.0.0.1:${harness.port}` });
    const tuiWs = await harness.openWs();
    const wrongSessionWs = await harness.openWs();
    try {
      await connectSessionClient(webWs, storePath, "identity-only-web-device", "web");
      await connectSessionClient(tuiWs, storePath, "identity-only-tui-device", "tui");
      await connectOk(wrongSessionWs, { scopes: ["operator.read"] });
      for (const ws of [webWs, tuiWs]) {
        const subscription = await rpcReq(ws, "sessions.messages.subscribe", { key: sessionKey });
        expect(subscription.ok).toBe(true);
      }
      const wrongSubscription = await rpcReq(wrongSessionWs, "sessions.messages.subscribe", {
        key: "agent:main:web-tui-wrong-session",
      });
      expect(wrongSubscription.ok).toBe(true);

      await withOperatorSessionSubscriber(async (broadWs) => {
        const observers = [webWs, tuiWs, broadWs];
        const observedInvalidations: Array<Array<Record<string, unknown>>> = observers.map(
          () => [],
        );
        const listeners = observers.map((ws, index) => {
          const observed = observedInvalidations[index];
          if (!observed) {
            throw new Error(`missing identity-only transcript observer ${index}`);
          }
          const listener = (data: RawData) => {
            const frame = JSON.parse(rawDataToString(data)) as {
              event?: string;
              payload?: Record<string, unknown>;
              type?: string;
            };
            if (
              frame.type === "event" &&
              frame.event === "sessions.changed" &&
              frame.payload?.phase === "message" &&
              frame.payload.sessionKey === sessionKey
            ) {
              observed.push(frame.payload);
            }
          };
          ws.on("message", listener);
          return { ws, listener };
        });
        try {
          const invalidations = observers.map((ws) =>
            waitForSessionsChangedMessagePhase(ws, sessionKey),
          );
          const unexpectedFrames = [webWs, tuiWs, wrongSessionWs].map((ws) =>
            onceMessage(
              ws,
              (frame) =>
                frame.type === "event" &&
                (frame.event === "session.message" ||
                  (ws === wrongSessionWs && frame.event === "sessions.changed")) &&
                (frame.payload as { sessionKey?: string } | undefined)?.sessionKey === sessionKey,
              300,
            ).then(
              () => true,
              () => false,
            ),
          );

          const committed = await persistSessionTranscriptTurn(
            { agentId: "main", sessionId, sessionKey, storePath },
            {
              messages: ["first", "second"].map((name, index) => ({
                eventId: `identity-only-${name}`,
                message: {
                  content: [
                    { type: "text", text: `Identity-only committed message ${index + 1}.` },
                  ],
                  idempotencyKey: `identity-only-${name}:user`,
                  role: "user",
                  timestamp: 1_700_000_000_000 + index,
                },
              })),
              updateMode: "file-only",
            },
          );
          expect(committed.appendedCount).toBe(2);

          for (const frame of await Promise.all(invalidations)) {
            const payload = requireRecord(frame.payload, "identity-only transcript invalidation");
            expect(payload).toMatchObject({ phase: "message", sessionKey });
            for (const privateField of [
              "lifecycleRevision",
              "message",
              "messageId",
              "messageSeq",
              "storePath",
            ]) {
              expect(payload).not.toHaveProperty(privateField);
            }
            expect(JSON.stringify(payload)).not.toContain(storePath);
            expect(payload).toHaveProperty("session.lifecycleRevision", lifecycleRevision);
          }
          await expect(Promise.all(unexpectedFrames)).resolves.toEqual([false, false, false]);
          expect(observedInvalidations.map((frames) => frames.length)).toEqual([1, 1, 1]);
        } finally {
          for (const { ws, listener } of listeners) {
            ws.off("message", listener);
          }
        }
      });
    } finally {
      webWs.close();
      tuiWs.close();
      wrongSessionWs.close();
    }
  });

  test("broadcasts appended transcript messages with the session key", async () => {
    const storePath = await createMainSessionStore();

    const delivered = withOperatorSessionSubscriber((ws) =>
      waitForSessionMessageEvent(ws, "agent:main:main"),
    );
    const appended = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:main",
      text: "live websocket message",
      storePath,
    });
    expect(appended.ok).toBe(true);
    if (!appended.ok) {
      throw new Error(`append failed: ${appended.reason}`);
    }
    const payload = requireRecord((await delivered).payload, "transcript message event");
    expectRecordFields(payload, {
      agentId: "main",
      sessionId: "sess-main",
      sessionKey: "agent:main:main",
      messageId: appended.messageId,
    });
    expectRecordFields(payload.message, {
      role: "assistant",
      content: [{ type: "text", text: "live websocket message" }],
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
        message: expect.objectContaining({
          content: [{ type: "text", text: "live websocket message" }],
        }),
        type: "message",
      }),
    );
  });

  test.each([true, false])(
    "forwards blocked placeholders to live listeners (transcript exists: %s)",
    async (transcriptExists) => {
      const storePath = await createMainSessionStore();
      const transcriptPath = path.join(path.dirname(storePath), "sess-main.jsonl");
      if (transcriptExists) {
        await fs.writeFile(
          transcriptPath,
          JSON.stringify({ type: "session", version: 1, id: "sess-main" }) + "\n",
          "utf-8",
        );
      }

      await withOperatorSessionSubscriber(async (ws) => {
        const { messageEvent } = await emitTranscriptUpdateAndCollectMessageEvent({
          ws,
          sessionKey: "agent:main:main",
          sessionFile: transcriptPath,
          messageId: "blocked-message",
          message: {
            role: "user",
            content: [{ type: "text", text: "The agent cannot read this message." }],
            __openclaw: {
              beforeAgentRunBlocked: { blockedBy: "policy-plugin", blockedAt: 1 },
            },
          },
        });

        const payload = requireRecord(messageEvent.payload, "blocked message event");
        const message = requireRecord(payload.message, "blocked message");
        expect(message.role).toBe("user");
        expect(message.content).toEqual([
          { type: "text", text: "The agent cannot read this message." },
        ]);
        expect(
          requireRecord(message["__openclaw"], "blocked metadata").beforeAgentRunBlocked,
        ).toEqual({
          blockedBy: "policy-plugin",
          blockedAt: 1,
        });
      });
    },
  );

  test("does not broadcast hidden runtime-context custom messages as live chat messages", async () => {
    const storePath = await createSessionStore({
      "hidden-runtime": { sessionId: "sess-hidden-runtime" },
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const changedEventPromise = waitForSessionsChangedMessagePhase(
        ws,
        "agent:main:hidden-runtime",
      );
      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          waitForSessionMessageEvent(ws, "agent:main:hidden-runtime", timeoutMs),
        action: () => {
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
        },
      });

      const changedEvent = await changedEventPromise;
      expectRecordFields(changedEvent.payload, {
        sessionKey: "agent:main:hidden-runtime",
        phase: "message",
        goal: null,
      });
    });
  });

  test("does not duplicate displayable transcript updates with sessions.changed", async () => {
    const storePath = await createMainSessionStore();

    await withOperatorSessionSubscriber(async (ws) => {
      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:main");
      await expectNoMessageWithin({
        action: () => {
          emitSessionTranscriptUpdate({
            sessionFile: path.join(path.dirname(storePath), "sess-main.jsonl"),
            sessionKey: "agent:main:main",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "single frame" }],
              timestamp: Date.now(),
            },
            messageId: "msg-single-frame",
            messageSeq: 1,
          });
        },
        watch: (timeoutMs) =>
          onceMessage(
            ws,
            matchingEvent("sessions.changed", { phase: "message", sessionKey: "agent:main:main" }),
            timeoutMs,
          ),
      });
      const messageEvent = await messageEventPromise;
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        messageId: "msg-single-frame",
        messageSeq: 1,
      });
    });
  });

  test("broadcasts identity-only transcript updates to live session listeners", async () => {
    await createMainSessionStore();

    await withOperatorSessionSubscriber(async (ws) => {
      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:main");
      emitSessionTranscriptUpdate({
        target: {
          agentId: "main",
          sessionId: "sess-main",
          sessionKey: "agent:main:main",
        },
        message: {
          role: "assistant",
          content: [{ type: "text", text: "identity frame" }],
          timestamp: Date.now(),
        },
        messageId: "msg-identity-frame",
        messageSeq: 1,
      });

      const messageEvent = await messageEventPromise;
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        messageId: "msg-identity-frame",
        messageSeq: 1,
      });
    });
  });

  test("includes live usage metadata on session.message transcript events", async () => {
    const storePath = await createSessionStoreFile();
    const transcriptMessage = await seedCompletedSessionTranscript({
      storePath,
      sessionId: "sess-main",
      sessionKey: "agent:main:main",
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          providerOverride: "openai",
          modelOverride: "gpt-5.4",
          modelProvider: "openai",
          model: "gpt-5.4",
          agentHarnessId: "openclaw",
          contextTokens: 123_456,
          contextTokensSource: "runtime",
          totalTokens: 0,
          totalTokensFresh: false,
        },
      },
      message: {
        role: "assistant",
        content: [{ type: "text", text: "usage snapshot" }],
        provider: "openai",
        model: "gpt-5.4",
        usage: {
          input: 2_000,
          output: 400,
          cacheRead: 300,
          cacheWrite: 100,
          cost: { total: 0.0042 },
        },
        timestamp: Date.now(),
      },
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent } = await emitTranscriptUpdateAndCollectMessageEvent({
        ws,
        sessionKey: "agent:main:main",
        sessionFile: "agent:main:main",
        message: transcriptMessage,
        messageId: "msg-usage",
      });
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        messageId: "msg-usage",
        messageSeq: 1,
        totalTokens: 2_400,
        totalTokensFresh: true,
        contextTokens: 123_456,
        estimatedCostUsd: 0.0042,
        modelProvider: "openai",
        model: "gpt-5.4",
      });
    });
  });

  test("marks display-cap truncation structurally on live session.message events", async () => {
    const storePath = await createMainSessionStore();
    const transcriptMessage = textMessage("x".repeat(9_000));
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId: "sess-main", sessionKey: "agent:main:main", storePath },
      { messages: [{ message: transcriptMessage }], updateMode: "none" },
    );

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent } = await emitTranscriptUpdateAndCollectMessageEvent({
        ws,
        sessionKey: "agent:main:main",
        sessionFile: "agent:main:main",
        message: transcriptMessage,
        messageId: "msg-capped",
      });
      const payload = requireRecord(messageEvent.payload, "capped message payload");
      const message = requireRecord(payload.message, "capped message");
      // The preview is bounded by the display cap and says so structurally, so a
      // non-UI consumer can fetch the full row instead of sniffing the sentinel.
      expect(JSON.stringify(message.content)).toContain("...(truncated)...");
      expect(message["__openclaw"]).toMatchObject({ truncated: true, reason: "display-cap" });
    });
  });

  test("prefers carried transcript sequence for live session events", async () => {
    const storePath = await createMainSessionStore();

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent } = await emitTranscriptUpdateAndCollectMessageEvent({
        ws,
        sessionKey: "agent:main:main",
        sessionFile: path.join(path.dirname(storePath), "missing-transcript.jsonl"),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "carried sequence" }],
          timestamp: Date.now(),
        },
        messageId: "msg-carried-seq",
        messageSeq: 7,
      });
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        messageId: "msg-carried-seq",
        messageSeq: 7,
      });
      const payload = requireRecord(messageEvent.payload, "session.message payload");
      const message = requireRecord(payload.message, "session.message payload message");
      expect((message["__openclaw"] as { seq?: unknown } | undefined)?.seq).toBe(7);
    });
  });

  test("routes selected-agent global transcript updates to matching message subscribers", async () => {
    testState.agentsConfig = { ownership: "explicit", entries: { main: {}, work: {} } };
    testState.agentConfig = { sessionStore: { agentId: "work" } };
    const transcriptMessage = textMessage("work selected global prompt", "user");
    const { transcriptPath } = await createTranscriptSession(
      "global",
      "sess-work-global",
      "msg-work-global",
      transcriptMessage,
      { goal: activeGoal("goal-work-global", "Finish work global task", 5) },
      "work",
    );

    const workWs = await harness.openWs();
    const mainWs = await harness.openWs();
    const bareWs = await harness.openWs();
    try {
      await connectOk(workWs, { scopes: ["operator.read"] });
      await connectOk(mainWs, { scopes: ["operator.read"] });
      await connectOk(bareWs, { scopes: ["operator.read"] });
      expect(
        await rpcReq(workWs, "sessions.messages.subscribe", {
          key: "global",
          agentId: "work",
        }),
      ).toMatchObject({ ok: true, payload: { key: "global", subscribed: true } });
      expect(
        await rpcReq(mainWs, "sessions.messages.subscribe", {
          key: "global",
          agentId: "main",
        }),
      ).toMatchObject({ ok: false });
      expect(
        await rpcReq(bareWs, "sessions.messages.subscribe", {
          key: "global",
        }),
      ).toMatchObject({ ok: true, payload: { key: "global", subscribed: true } });

      const workMessagePromise = waitForSessionMessageEvent(workWs, "global");
      const mainMessagePromise = expectNoMessageWithin({
        watch: (timeoutMs) => waitForSessionMessageEvent(mainWs, "global", timeoutMs),
        timeoutMs: 250,
      });
      const bareMessagePromise = waitForSessionMessageEvent(bareWs, "global");
      emitSessionTranscriptUpdate({
        sessionFile: transcriptPath,
        sessionKey: "global",
        agentId: "work",
        message: transcriptMessage,
        messageId: "msg-work-global",
      });

      const [workMessage, , bareMessage] = await Promise.all([
        workMessagePromise,
        mainMessagePromise,
        bareMessagePromise,
      ]);
      expectRecordFields(workMessage.payload, {
        sessionKey: "global",
        agentId: "work",
        messageId: "msg-work-global",
        goal: {
          ...activeGoal("goal-work-global", "Finish work global task", 5),
          tokenStartFresh: true,
        },
      });
      expectRecordFields(bareMessage.payload, {
        sessionKey: "global",
        agentId: "work",
        messageId: "msg-work-global",
      });
    } finally {
      workWs.close();
      mainWs.close();
      bareWs.close();
      testState.agentsConfig = undefined;
      testState.agentConfig = undefined;
      testState.sessionStorePath = undefined;
    }
  });

  test("routes a subscribed global observer event through the real gateway socket once", async () => {
    testState.agentsConfig = { ownership: "explicit", entries: { main: {}, work: {} } };
    testState.agentConfig = { sessionStore: { agentId: "work" } };
    await createSessionStore({ global: { sessionId: "sess-work-observer" } }, "work");
    const workWs = await harness.openWs();
    const mainWs = await harness.openWs();
    const runId = "run-work-global-observer";
    const workEvents: unknown[] = [];
    const mainEvents: unknown[] = [];
    const collect = (target: unknown[]) => (data: RawData) => {
      const message = JSON.parse(rawDataToString(data)) as { event?: string; payload?: unknown };
      if (message.event === "session.observer") {
        target.push(message.payload);
      }
    };
    const collectWork = collect(workEvents);
    const collectMain = collect(mainEvents);
    workWs.on("message", collectWork);
    mainWs.on("message", collectMain);
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
      expect(workEvents).toHaveLength(1);
      expect(mainEvents).toHaveLength(0);
    } finally {
      workWs.off("message", collectWork);
      mainWs.off("message", collectMain);
      workWs.close();
      mainWs.close();
      testState.agentsConfig = undefined;
      testState.agentConfig = undefined;
      testState.sessionStorePath = undefined;
    }
  });

  test.each([
    { label: "unscoped", agentId: undefined },
    { label: "default-agent scoped", agentId: "main" },
  ])(
    "routes $label global transcript events to matching and legacy subscribers",
    async ({ agentId }) => {
      const transcriptMessage = textMessage("default global prompt");
      const { transcriptPath } = await createTranscriptSession(
        "global",
        "sess-default-global",
        "msg-default-global",
        transcriptMessage,
        {},
        agentId,
      );

      const workWs = await harness.openWs();
      const mainWs = await harness.openWs();
      const bareWs = await harness.openWs();
      try {
        await connectOk(workWs, { scopes: ["operator.read"] });
        await connectOk(mainWs, { scopes: ["operator.read"] });
        await connectOk(bareWs, { scopes: ["operator.read"] });
        await rpcReq(workWs, "sessions.messages.subscribe", {
          key: "global",
          agentId: "work",
        });
        await rpcReq(mainWs, "sessions.messages.subscribe", {
          key: "global",
          agentId: "main",
        });
        await rpcReq(bareWs, "sessions.messages.subscribe", {
          key: "global",
        });

        const mainMessagePromise = waitForSessionMessageEvent(mainWs, "global");
        const bareMessagePromise = waitForSessionMessageEvent(bareWs, "global");
        const workMessagePromise = expectNoMessageWithin({
          watch: (timeoutMs) => waitForSessionMessageEvent(workWs, "global", timeoutMs),
          timeoutMs: 250,
        });
        emitSessionTranscriptUpdate({
          sessionFile: transcriptPath,
          sessionKey: "global",
          ...(agentId ? { agentId } : {}),
          message: transcriptMessage,
          messageId: "msg-default-global",
        });

        const mainMessage = await mainMessagePromise;
        const bareMessage = await bareMessagePromise;
        await workMessagePromise;
        expectRecordFields(mainMessage.payload, {
          sessionKey: "global",
          messageId: "msg-default-global",
        });
        expectRecordFields(bareMessage.payload, {
          sessionKey: "global",
          messageId: "msg-default-global",
        });
        expect((mainMessage.payload as { agentId?: unknown }).agentId).toBe(agentId);
        expect((bareMessage.payload as { agentId?: unknown }).agentId).toBe(agentId);
      } finally {
        workWs.close();
        mainWs.close();
        bareWs.close();
      }
    },
  );

  test("includes spawnedBy metadata on session.message transcript events", async () => {
    const transcriptMessage = textMessage("spawn metadata snapshot");
    const { transcriptPath } = await createTranscriptSession(
      "child",
      "sess-child",
      "msg-spawn",
      transcriptMessage,
      {
        spawnedBy: "agent:main:main",
        ...spawnMetadata,
        parentSessionKey: "agent:main:main",
      },
    );

    const ws = await harness.openWs();
    try {
      await connectOk(ws, { scopes: ["operator.read"] });
      await rpcReq(ws, "sessions.subscribe");

      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:child");

      emitSessionTranscriptUpdate({
        sessionFile: transcriptPath,
        sessionKey: "agent:main:child",
        message: transcriptMessage,
        messageId: "msg-spawn",
      });

      const messageEvent = await messageEventPromise;
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:child",
        spawnedBy: "agent:main:main",
        ...spawnMetadata,
        parentSessionKey: "agent:main:main",
      });
    } finally {
      ws.close();
    }
  });

  test("includes route thread metadata on session.message transcript events", async () => {
    const transcriptMessage = textMessage("thread route snapshot");
    const { transcriptPath } = await createTranscriptSession(
      "main",
      "sess-thread",
      "msg-thread",
      transcriptMessage,
      {
        lastChannel: "telegram",
        lastTo: "-100123",
        lastAccountId: "acct-1",
        lastThreadId: 42,
      },
    );

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent } = await emitTranscriptUpdateAndCollectMessageEvent({
        ws,
        sessionKey: "agent:main:main",
        sessionFile: transcriptPath,
        message: transcriptMessage,
        messageId: "msg-thread",
      });
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        lastChannel: "telegram",
        lastTo: "-100123",
        lastAccountId: "acct-1",
        lastThreadId: 42,
      });
    });
  });

  test("sessions.messages.subscribe only delivers transcript events for the requested session", async () => {
    const storePath = await createSessionStore({
      main: { sessionId: "sess-main" },
      worker: { sessionId: "sess-worker" },
    });
    const ws = await harness.openWs();
    try {
      await connectOk(ws, { scopes: ["operator.read"] });
      const subscribeRes = await rpcReq(ws, "sessions.messages.subscribe", {
        key: "agent:main:main",
      });
      expect(subscribeRes.ok).toBe(true);
      expect(subscribeRes.payload?.subscribed).toBe(true);
      expect(subscribeRes.payload?.key).toBe("agent:main:main");

      const mainEvent = waitForSessionMessageEvent(ws, "agent:main:main");
      const [mainAppend] = await Promise.all([
        appendAssistantMessageToSessionTranscript({
          sessionKey: "agent:main:main",
          text: "main only",
          storePath,
        }),
        mainEvent,
      ]);
      expect(mainAppend.ok).toBe(true);

      await expectNoMessageWithin({
        watch: (timeoutMs) => waitForSessionMessageEvent(ws, "agent:main:worker", timeoutMs),
        action: async () => {
          const workerAppend = await appendAssistantMessageToSessionTranscript({
            sessionKey: "agent:main:worker",
            text: "worker hidden",
            storePath,
          });
          expect(workerAppend.ok).toBe(true);
        },
      });

      const unsubscribeRes = await rpcReq(ws, "sessions.messages.unsubscribe", {
        key: "agent:main:main",
      });
      expect(unsubscribeRes.ok).toBe(true);
      expect(unsubscribeRes.payload?.subscribed).toBe(false);

      await expectNoMessageWithin({
        watch: (timeoutMs) => waitForSessionMessageEvent(ws, "agent:main:main", timeoutMs),
        action: async () => {
          const hiddenAppend = await appendAssistantMessageToSessionTranscript({
            sessionKey: "agent:main:main",
            text: "hidden after unsubscribe",
            storePath,
          });
          expect(hiddenAppend.ok).toBe(true);
        },
      });
    } finally {
      ws.close();
    }
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
    const ws = await harness.openWs();
    const workerChats: Record<string, unknown>[] = [];
    const collectWorkerChats = (data: RawData) => {
      const message = JSON.parse(rawDataToString(data)) as {
        type?: string;
        event?: string;
        payload?: Record<string, unknown>;
      };
      if (
        message.type === "event" &&
        message.event === "chat" &&
        message.payload?.runId === "worker"
      ) {
        workerChats.push(message.payload);
      }
    };
    ws.on("message", collectWorkerChats);
    try {
      await connectOk(ws, { scopes: ["operator.read"] });
      const subscribeRes = await rpcReq(ws, "sessions.messages.subscribe", { key: sessionKey });
      expect(subscribeRes.ok).toBe(true);
      expect(subscribeRes.payload?.subscribed).toBe(true);
      expect(subscribeRes.payload?.key).toBe(sessionKey);

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
      expect(payloads.map((payload) => payload.messageId)).toEqual(outcome.result.entryIds);
      expect(payloads.map((payload) => payload.messageSeq)).toEqual([1, 2, 3]);
      expect(
        payloads.map((payload) => {
          const message = requireRecord(payload.message, "session.message payload message");
          return requireRecord(message["__openclaw"], "session.message metadata").id;
        }),
      ).toEqual(outcome.result.entryIds);
      expect(
        payloads.map((payload) => {
          const message = requireRecord(payload.message, "session.message payload message");
          return requireRecord(message["__openclaw"], "session.message metadata").seq;
        }),
      ).toEqual([1, 2, 3]);

      const waitForChat = (runId: string, timeoutMs?: number) =>
        onceMessage(ws, matchingEvent("chat", { runId }), timeoutMs);
      const [workerEvent] = await Promise.all([
        waitForChat("worker"),
        expectNoMessageWithin({
          watch: (timeoutMs) => waitForSessionMessageEvent(ws, sessionKey, timeoutMs),
          action: async () => {
            expect((await push()).ok).toBe(true);
          },
        }),
      ]);
      const workerChat = requireRecord(workerEvent.payload, "worker chat");
      await expectNoMessageWithin({
        watch: (timeoutMs) => waitForChat("worker", timeoutMs),
        action: async () => {
          expect(await push()).toEqual({ ok: true, result: { ackedSeq: 1 } });
        },
      });
      expect(workerChats).toHaveLength(1);

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
      ws.off("message", collectWorkerChats);
      ws.close();
      await source.release();
    }
  });

  test("routes transcript-only SQLite marker updates to the matching session owner", async () => {
    const storePath = await createSessionStore({
      older: { sessionId: "sess-old" },
      newer: { sessionId: "sess-new", updatedAt: Date.now() + 10 },
    });
    const message = textMessage("shared transcript update");
    await persistSessionTranscriptTurn(
      {
        agentId: "main",
        sessionId: "sess-new",
        sessionKey: "agent:main:newer",
        storePath,
      },
      {
        messages: [{ message }],
        updateMode: "none",
      },
    );

    await withOperatorSessionSubscriber(async (ws) => {
      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:newer");

      emitSessionTranscriptUpdate({
        sessionFile: formatSqliteSessionFileMarker({
          agentId: "main",
          sessionId: "sess-new",
          storePath,
        }),
        message,
        messageId: "msg-shared",
      });

      const messageEvent = await messageEventPromise;
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:newer",
        messageId: "msg-shared",
        messageSeq: 1,
      });
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
