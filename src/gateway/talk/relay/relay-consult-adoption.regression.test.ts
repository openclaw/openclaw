import { expect, it } from "vitest";
import { isIndexedSessionEntry } from "../../../agents/sessions/session-manager-codec.js";
import { SessionManager } from "../../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../../agents/test-helpers/agent-message-fixtures.js";
import { formatSqliteSessionFileMarker } from "../../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../../../talk/provider-types.js";
import { controlBridge, controlContext } from "../client-gateway-control.test-support.js";
import { useRelayFixtures } from "./fixture.test-support.js";
import { createIdleRelayProvider } from "./index.test-support.js";
import { flushTalkRealtimeRelayVoiceWrites } from "./operations.js";

const connId = "relay-adoption-test-client";
const sessionKey = "agent:main:main";
const speech = { assistant: "Checking now.", user: "Please keep working." };

const createRelay = useRelayFixtures();
const assistantMessage = (text: string) =>
  makeAgentAssistantMessage({ content: [{ type: "text", text }], timestamp: 2 });

async function createConsult(excludeFromContext = true) {
  let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
  const { relay } = await createRelay({
    cfg: { agents: { entries: { main: {} } } },
    context: controlContext(),
    connId,
    controlSource: "delegation",
    provider: createIdleRelayProvider((options) => {
      bridgeRequest = options;
      return controlBridge();
    }),
    instructions: "Answer briefly.",
  });
  const onTranscript = bridgeRequest?.onTranscript;
  const onEvent = bridgeRequest?.onEvent;
  if (!onTranscript || !onEvent) {
    throw new Error("expected registered relay transcript and response callbacks");
  }
  bridgeRequest?.onReady?.();
  onEvent({ direction: "server", type: "response.created", responseId: "consult-response" });
  const scope = {
    agentId: "main",
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
  const expectRejected = async (message: typeof consult, error: string) => {
    const before = await messages();
    expect(() => openManager().appendMessage(message)).toThrow(error);
    expect(await messages()).toEqual(before);
  };
  return { scope, consult, recordSpeech, messages, openManager, expectRejected };
}

it.each([
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

it.each([
  { boundary: "completed" },
  { boundary: "excluded-completed" },
  { boundary: "newer-key" },
  { boundary: "other channel", provenance: { kind: "realtime_voice", sourceChannel: "discord" } },
  { boundary: "other kind", provenance: { kind: "internal_system", sourceChannel: "talk" } },
  { boundary: "missing channel", provenance: { kind: "realtime_voice" } },
])("does not reopen a consult after $boundary", async ({ boundary, provenance }) => {
  const { scope, consult, recordSpeech, expectRejected } = await createConsult();
  await appendTranscriptMessage(scope, {
    eventId: "closing-message",
    message:
      boundary === "newer-key"
        ? { ...consult, idempotencyKey: "newer-consult:user" }
        : {
            ...assistantMessage("The original task is finished."),
            ...(boundary === "excluded-completed" ? { excludeFromContext: true } : {}),
            ...(provenance ? { provenance } : {}),
          },
  });
  if (!provenance) {
    await recordSpeech(["user", "assistant"]);
  }
  await expectRejected(consult, "Session transcript keyed user is outside the current turn");
});

it("rejects a changed payload using the consult key after live speech", async () => {
  const { consult, recordSpeech, expectRejected } = await createConsult();
  await recordSpeech(["assistant"]);
  await expectRejected(
    { ...consult, content: "Publish a different task." },
    'Transcript idempotency key "talk-consult:user" conflicts with the admitted message.',
  );
});
