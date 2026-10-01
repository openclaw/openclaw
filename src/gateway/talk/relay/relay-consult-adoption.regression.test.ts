import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isIndexedSessionEntry } from "../../../agents/sessions/session-manager-codec.js";
import { SessionManager } from "../../../agents/sessions/session-manager.js";
import { createZeroUsageFixture } from "../../../agents/test-helpers/usage-fixtures.js";
import { formatSqliteSessionFileMarker } from "../../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { ensureClientVoiceAgentSessionEntry } from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../../../talk/provider-types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { controlBridge, controlContext } from "../client-gateway-control.test-support.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { createTalkRealtimeRelaySession, flushTalkRealtimeRelayVoiceWrites } from "./index.js";
import { closeRelaySession } from "./operations.js";
import { relaySessions, type RelaySession } from "./state.js";

const connId = "relay-adoption-test-client";
const agentId = "main";
const sessionKey = "agent:main:main";
const speech = { assistant: "Checking now.", user: "Please keep working." };

function assistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "messages" as const,
    provider: "anthropic" as const,
    model: "sonnet-4.6" as const,
    usage: createZeroUsageFixture(),
    stopReason: "stop" as const,
    timestamp: 2,
  };
}

describe("Talk relay keyed consult adoption", () => {
  let state: OpenClawTestState;
  let ownedRelay: RelaySession | undefined;

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "relay-adoption", applyEnv: true });
    await ensureClientVoiceAgentSessionEntry({ agentId, sessionKey });
  });

  afterEach(async () => {
    if (ownedRelay) {
      await closeRelaySession(ownedRelay, "completed");
      ownedRelay = undefined;
    }
    clientVoiceSessionTesting.reset();
    closeOpenClawAgentDatabasesForTest();
    await state.cleanup();
  });

  async function createConsult(excludeFromContext = true) {
    const cfg = { agents: { entries: { main: { default: true } } } };
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const session = createTalkRealtimeRelaySession({
      cfg,
      context: controlContext(),
      connId,
      sessionTarget: prepareTalkSessionTarget(cfg, sessionKey),
      controlSource: "delegation",
      provider: {
        id: "relay-adoption-provider",
        label: "Relay adoption provider",
        isConfigured: () => true,
        createBridge: (options) => {
          bridgeRequest = options;
          return controlBridge();
        },
      },
      providerConfig: {},
      instructions: "Answer briefly.",
      tools: [],
    });
    const relay = relaySessions.get(session.relaySessionId);
    const onTranscript = bridgeRequest?.onTranscript;
    const onEvent = bridgeRequest?.onEvent;
    if (!relay || !onTranscript || !onEvent) {
      throw new Error("expected registered relay transcript and response callbacks");
    }
    ownedRelay = relay;
    bridgeRequest?.onReady?.();
    onEvent({ direction: "server", type: "response.created", responseId: "consult-response" });
    const scope = {
      agentId,
      sessionId: "main",
      sessionKey,
      storePath: relay.sessionTarget.storePath,
    };
    await upsertSessionEntryCore(scope, {
      sessionFile: formatSqliteSessionFileMarker(scope),
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    const consult = {
      role: "user" as const,
      content: "What is on the calendar tomorrow?",
      idempotencyKey: "talk-consult:user",
      ...(excludeFromContext ? { excludeFromContext: true } : {}),
      timestamp: 1,
    };
    await appendTranscriptMessage(scope, {
      eventId: "keyed-consult-turn",
      message: consult,
      now: 1,
    });
    const recordSpeech = async (roles: readonly ("assistant" | "user")[]) => {
      for (const role of roles) {
        onTranscript(role, speech[role], true);
      }
      await flushTalkRealtimeRelayVoiceWrites({ relaySessionId: relay.id, connId });
    };
    const messages = async () =>
      (await loadTranscriptEvents(scope))
        .filter(isIndexedSessionEntry)
        .filter((entry) => entry.type === "message");
    const openManager = () =>
      SessionManager.openBounded(scope, { maxBytes: 100_000, maxEvents: 100 });
    return { scope, consult, recordSpeech, messages, openManager };
  }

  it.each([
    { roles: ["assistant"], excludeFromContext: true },
    { roles: ["user"], excludeFromContext: true },
    { roles: ["user", "assistant"], excludeFromContext: true },
    { roles: ["assistant", "user"], excludeFromContext: false },
  ] as const)(
    "adopts the exact consult after live $roles speech (excluded: $excludeFromContext)",
    async ({ roles, excludeFromContext }) => {
      const { consult, recordSpeech, messages, openManager } =
        await createConsult(excludeFromContext);
      await recordSpeech(roles);
      const beforeAdoption = await messages();
      expect(beforeAdoption).toMatchObject([
        { id: "keyed-consult-turn", message: consult },
        ...roles.map((role) => ({
          message: {
            role,
            content: [{ type: "text", text: speech[role] }],
            provenance: { kind: "realtime_voice", sourceChannel: "talk" },
          },
        })),
      ]);

      const manager = openManager();
      expect(manager.appendMessageWithTranscriptAnchor(consult)).toMatchObject({
        entryId: "keyed-consult-turn",
        message: consult,
        anchor: { entryId: "keyed-consult-turn", idempotencyKey: consult.idempotencyKey },
        appended: false,
      });
      expect(manager.getAppendParentId()).toBe(beforeAdoption.at(-1)?.id);
      const answerId = manager.appendMessage(assistantMessage("You have one meeting tomorrow."));
      expect(await messages()).toMatchObject([
        ...beforeAdoption,
        { id: answerId, parentId: beforeAdoption.at(-1)?.id },
      ]);
    },
  );

  it.each(["completed", "excluded-completed", "newer-key"] as const)(
    "does not reopen a %s turn through later Talk speech",
    async (boundary) => {
      const { scope, consult, recordSpeech, messages, openManager } = await createConsult();
      await appendTranscriptMessage(scope, {
        eventId: "closing-message",
        message:
          boundary === "newer-key"
            ? { ...consult, idempotencyKey: "newer-consult:user" }
            : {
                ...assistantMessage("The original task is finished."),
                ...(boundary === "excluded-completed" ? { excludeFromContext: true } : {}),
              },
      });
      await recordSpeech(["user", "assistant"]);
      const beforeAdoption = await messages();

      expect(() => openManager().appendMessage(consult)).toThrow(
        "Session transcript keyed user is outside the current turn",
      );
      expect(await messages()).toEqual(beforeAdoption);
    },
  );

  it.each([
    { kind: "realtime_voice", sourceChannel: "discord" },
    { kind: "internal_system", sourceChannel: "talk" },
    { kind: "realtime_voice" },
  ])("keeps other provenance terminating: %j", async (provenance) => {
    const { scope, consult, openManager } = await createConsult();
    await appendTranscriptMessage(scope, {
      eventId: "other-transcript",
      message: { ...assistantMessage("Another answer."), provenance },
    });

    expect(() => openManager().appendMessage(consult)).toThrow(
      "Session transcript keyed user is outside the current turn",
    );
  });

  it("rejects a changed payload using the consult key after live speech", async () => {
    const { consult, recordSpeech, messages, openManager } = await createConsult();
    await recordSpeech(["assistant"]);
    const beforeAdoption = await messages();

    expect(() =>
      openManager().appendMessage({ ...consult, content: "Publish a different task." }),
    ).toThrow(
      'Transcript idempotency key "talk-consult:user" conflicts with the admitted message.',
    );
    expect(await messages()).toEqual(beforeAdoption);
  });
});
