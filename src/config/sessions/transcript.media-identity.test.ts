import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../io.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "./session-accessor.js";
import { readTranscriptEventMessage } from "./session-accessor.sqlite-read.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import * as transcriptAnchors from "./session-transcript-anchor-read.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { withSessionTranscriptWriteAssertion } from "./transcript-write-context.js";
import {
  appendAssistantMessageToSessionTranscript as appendMirrorMessage,
  appendExactAssistantMessageToSessionTranscript as appendExactMessage,
} from "./transcript.js";

// Literal v2026.9.4 representation: the current constructor must not seed legacy fixtures.
function legacyMirrorMessage(text = "Chart") {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openclaw-transcript",
    provider: "openclaw",
    model: "delivery-mirror",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: 1_700_000_000_000,
  };
}

function expectConflict(result: Promise<unknown>) {
  return expect(result).rejects.toThrow("conflicts with the admitted message");
}

describe("assistant mirror media identity", () => {
  afterAll(clearRuntimeConfigSnapshot);
  const fixture = useTempSessionsFixture("transcript-media-identity-");

  const scope = {
    agentId: "main",
    sessionId: "legacy-media-session",
    sessionKey: "agent:main:legacy-media",
    storePath: "",
  };
  beforeEach(async () => {
    scope.storePath = fixture.storePath();
    setRuntimeConfigSnapshot({ session: { store: scope.storePath } });
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  });
  const appendMirror = (params: Omit<Parameters<typeof appendMirrorMessage>[0], "sessionKey">) =>
    appendMirrorMessage({ ...scope, ...params });
  const appendExact = (params: Omit<Parameters<typeof appendExactMessage>[0], "sessionKey">) =>
    appendExactMessage({ ...scope, ...params });
  const rejectMirror = (params: Parameters<typeof appendMirror>[0]) =>
    expectConflict(appendMirror(params));
  const rejectExact = (params: Parameters<typeof appendExact>[0]) =>
    expectConflict(appendExact(params));
  const messages = async () => (await loadTranscriptEvents(scope)).map(readTranscriptEventMessage);
  const assistants = async () =>
    (await messages()).filter((message) => message?.role === "assistant");
  const chartMediaUrls = ["https://example.com/chart.png"];
  const content = (text: string) => [{ type: "text" as const, text }];
  const mirrorInput = (explicit: boolean, text = "Chart") => ({
    text,
    ...(explicit ? { content: content(text) } : {}),
    mediaUrls: chartMediaUrls,
  });
  async function admit(append: () => ReturnType<typeof appendMirror>) {
    const first = await append();
    expect(first.ok).toBe(true);
    expect(await append()).toEqual(first);
    return first;
  }

  async function seedMessage(message: Parameters<typeof appendTranscriptMessage>[1]["message"]) {
    const first = await appendTranscriptMessage(scope, { message });
    expect(first.appended).toBe(true);
    expect((await appendTranscriptMessage(scope, { message })).appended).toBe(false);
    return { first, before: readRawEvents() };
  }
  function database() {
    const target = resolveSqliteTargetFromSessionStorePath(fixture.storePath());
    return openOpenClawAgentDatabase({ agentId: "main", path: target.path });
  }

  // Read serialized payloads, not parsed projections: replay must preserve accepted bytes.
  function readRawEvents() {
    return database()
      .db.prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(scope.sessionId);
  }

  it.each(["explicit", "owned"] as const)(
    "rejects revoked duplicate authority after the anchor read: %s",
    async (authority) => {
      const params = { expectedSessionId: scope.sessionId, message: legacyMirrorMessage() };
      const first = await appendExact(params);
      expect(first.ok).toBe(true);
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("duplicate writer revoked");
        }
      };
      const append = () =>
        authority === "explicit"
          ? appendExact({ ...params, assertCurrent })
          : withSessionTranscriptWriteAssertion(scope, assertCurrent, () => appendExact(params));
      await expect(append()).resolves.toEqual(first);
      const before = readRawEvents();
      const held = createDeferred();
      const release = createDeferred();
      const read = transcriptAnchors.readActiveTranscriptEntryAnchorAsync;
      const observation = vi
        .spyOn(transcriptAnchors, "readActiveTranscriptEntryAnchorAsync")
        .mockImplementation(async (...args) => {
          const anchor = await read(...args);
          held.resolve();
          await release.promise;
          return anchor;
        });
      const duplicate = append();
      try {
        await awaitGateBeforeSettlement(
          held.promise,
          duplicate,
          "Duplicate append settled without awaiting its anchor read",
        );
        current = false;
        release.resolve();
        await expect(duplicate).rejects.toThrow("duplicate writer revoked");
        expect(readRawEvents()).toEqual(before);
      } finally {
        release.resolve();
        await duplicate.catch(() => undefined);
        observation.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "replays literal legacy media bytes before and after reopen with content=%s",
    async (explicitContent) => {
      const original = legacyMirrorMessage(explicitContent ? "Chart" : "Chart\nchart.png");
      const params = {
        expectedSessionId: scope.sessionId,
        idempotencyKey: "legacy-media-reply",
        ...mirrorInput(explicitContent),
      };
      const first = await appendExact({ ...params, message: original });
      expect(first.ok).toBe(true);
      const before = readRawEvents();
      expect(before.length).toBeGreaterThan(0);
      expect(await appendMirror(params)).toEqual(first);
      expect(readRawEvents()).toEqual(before);

      const owner = database();
      expect(await closeOpenClawAgentDatabaseByPathAsync(owner.path, scope.agentId)).toBe(true);
      expect(owner.db.isOpen).toBe(false);
      expect(await appendMirror(params)).toEqual(first);
      expect(database()).not.toBe(owner);
      expect(readRawEvents()).toEqual(before);
      expect(await assistants()).toEqual([{ ...original, idempotencyKey: params.idempotencyKey }]);

      await rejectMirror({
        ...params,
        ...mirrorInput(explicitContent, "Different"),
      });
      expect(readRawEvents()).toEqual(before);

      // A legacy row cannot relax URL identity for new rows in the same database.
      const fresh = { ...params, idempotencyKey: "new-media-reply" };
      await admit(() => appendMirror(fresh));
      await rejectMirror({ ...fresh, mediaUrls: ["https://different.example/chart.png"] });
      await rejectMirror({ ...fresh, mediaUrls: undefined });
      await rejectMirror({
        ...fresh,
        ...mirrorInput(explicitContent, "Different"),
      });
      expect(await assistants()).toEqual([
        { ...original, idempotencyKey: params.idempotencyKey },
        expect.objectContaining({
          role: "assistant",
          openclawDelivery: { mediaUrls: fresh.mediaUrls },
          content: original.content,
        }),
      ]);
    },
  );

  it("records empty media identity so new explicit content cannot acquire media on replay", async () => {
    const params = {
      expectedSessionId: scope.sessionId,
      idempotencyKey: "new-no-media-reply",
      content: content("Chart"),
    };
    await admit(() => appendMirror(params));
    const before = readRawEvents();
    expect((await messages()).filter(Boolean)).toEqual([
      expect.objectContaining({ openclawDelivery: { mediaUrls: [] } }),
    ]);
    await rejectMirror({ ...params, mediaUrls: chartMediaUrls });
    expect(readRawEvents()).toEqual(before);
  });

  it("preserves legacy display and delivery facts and rejects changes to either", async () => {
    const original = {
      ...legacyMirrorMessage(),
      idempotencyKey: "legacy-facts",
      openclawDisplayContent: content("Visible chart"),
      openclawDelivery: { audioAsVoice: true as const, replyToId: "source-message" },
      openclawDeliveryMirror: { kind: "channel-final", sourceMessageId: "source-message" },
    };
    const first = await appendExact({ message: original });
    expect(first.ok).toBe(true);
    const before = readRawEvents();
    const candidate = {
      ...original,
      openclawDelivery: { ...original.openclawDelivery, mediaUrls: chartMediaUrls },
    };
    expect(await appendExact({ message: candidate })).toEqual(first);
    for (const message of [
      { ...candidate, openclawDisplayContent: content("Different") },
      { ...candidate, openclawDelivery: { ...candidate.openclawDelivery, replyToId: "other" } },
      {
        ...candidate,
        openclawDelivery: { replyToId: "source-message", mediaUrls: chartMediaUrls },
      },
      { ...candidate, openclawDeliveryMirror: { kind: "channel-final", sourceMessageId: "other" } },
      { ...candidate, usage: { ...candidate.usage, output: 1 } },
      { ...candidate, model: "gateway-injected" },
    ]) {
      await rejectExact({ message });
    }
    expect(readRawEvents()).toEqual(before);
  });

  it.each([{ mediaUrls: [] }, { mediaUrls: null }, { mediaUrls: "invalid" }, { mediaUrls: [42] }])(
    "keeps a stored own mediaUrls field strict: $mediaUrls",
    async ({ mediaUrls }) => {
      // Generic append can seed malformed facts without a type cast or raw SQL write.
      const original = {
        ...legacyMirrorMessage(),
        idempotencyKey: "present-media-identity",
        openclawDelivery: { mediaUrls },
      };
      const { first, before } = await seedMessage(original);
      expect(first.message.openclawDelivery).toEqual({ mediaUrls });
      await rejectMirror({
        idempotencyKey: original.idempotencyKey,
        content: original.content,
        mediaUrls: ["https://example.com/chart.png"],
      });
      await rejectExact({
        idempotencyKey: original.idempotencyKey,
        message: legacyMirrorMessage(),
      });
      expect(readRawEvents()).toEqual(before);
    },
  );

  it.each([
    { role: "user" },
    { model: "gateway-injected" },
    { api: "provider-api" },
    { provider: "other" },
  ])("does not relax media identity for %j", async (identity) => {
    const original = { ...legacyMirrorMessage(), ...identity, idempotencyKey: "non-mirror" };
    const { before } = await seedMessage(original);
    await expectConflict(
      appendTranscriptMessage(scope, {
        message: {
          ...original,
          openclawDelivery: { mediaUrls: chartMediaUrls },
        },
      }),
    );
    expect(readRawEvents()).toEqual(before);
  });
});
