import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
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
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
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

describe("assistant mirror media identity", () => {
  const fixture = useTempSessionsFixture("transcript-media-identity-");

  async function createScope() {
    const scope = {
      agentId: "main",
      sessionId: "legacy-media-session",
      sessionKey: "agent:main:legacy-media",
      storePath: fixture.storePath(),
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    return scope;
  }

  function database() {
    const target = resolveSqliteTargetFromSessionStorePath(fixture.storePath());
    return openOpenClawAgentDatabase({ agentId: "main", path: target.path });
  }

  // Read serialized payloads, not parsed projections: replay must preserve accepted bytes.
  function readRawEvents(sessionId: string) {
    return database()
      .db.prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(sessionId);
  }

  it.each(["explicit", "owned"] as const)(
    "rejects revoked duplicate authority after the anchor read: %s",
    async (authority) => {
      const scope = await createScope();
      const params = {
        ...scope,
        expectedSessionId: scope.sessionId,
        message: legacyMirrorMessage(),
      };
      const first = await appendExactAssistantMessageToSessionTranscript(params);
      expect(first.ok).toBe(true);
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("duplicate writer revoked");
        }
      };
      const append = () =>
        authority === "explicit"
          ? appendExactAssistantMessageToSessionTranscript({ ...params, assertCurrent })
          : withSessionTranscriptWriteAssertion(scope, assertCurrent, () =>
              appendExactAssistantMessageToSessionTranscript(params),
            );
      await expect(append()).resolves.toEqual(first);
      const before = readRawEvents(scope.sessionId);
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
        expect(readRawEvents(scope.sessionId)).toEqual(before);
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
      const scope = await createScope();
      const original = legacyMirrorMessage(explicitContent ? "Chart" : "Chart\nchart.png");
      const params = {
        ...scope,
        expectedSessionId: scope.sessionId,
        idempotencyKey: "legacy-media-reply",
        text: "Chart",
        ...(explicitContent ? { content: [{ type: "text" as const, text: "Chart" }] } : {}),
        mediaUrls: ["https://example.com/chart.png"],
      };
      const first = await appendExactAssistantMessageToSessionTranscript({
        ...params,
        message: original,
      });
      expect(first.ok).toBe(true);
      const before = readRawEvents(scope.sessionId);
      expect(before.length).toBeGreaterThan(0);
      expect(await appendAssistantMessageToSessionTranscript(params)).toEqual(first);
      expect(readRawEvents(scope.sessionId)).toEqual(before);

      const owner = database();
      expect(await closeOpenClawAgentDatabaseByPathAsync(owner.path, scope.agentId)).toBe(true);
      expect(owner.db.isOpen).toBe(false);
      expect(await appendAssistantMessageToSessionTranscript(params)).toEqual(first);
      expect(database()).not.toBe(owner);
      expect(readRawEvents(scope.sessionId)).toEqual(before);
      const assistants = (await loadTranscriptEvents(scope))
        .map(readTranscriptEventMessage)
        .filter((message) => message?.role === "assistant");
      expect(assistants).toEqual([{ ...original, idempotencyKey: params.idempotencyKey }]);

      await expect(
        appendAssistantMessageToSessionTranscript({
          ...params,
          text: "Different",
          ...(explicitContent ? { content: [{ type: "text" as const, text: "Different" }] } : {}),
        }),
      ).rejects.toThrow("conflicts with the admitted message");
      expect(readRawEvents(scope.sessionId)).toEqual(before);

      // A legacy row cannot relax URL identity for new rows in the same database.
      const fresh = { ...params, idempotencyKey: "new-media-reply" };
      const admitted = await appendAssistantMessageToSessionTranscript(fresh);
      expect(admitted.ok).toBe(true);
      expect(await appendAssistantMessageToSessionTranscript(fresh)).toEqual(admitted);
      await expect(
        appendAssistantMessageToSessionTranscript({
          ...fresh,
          mediaUrls: ["https://different.example/chart.png"],
        }),
      ).rejects.toThrow("conflicts with the admitted message");
      await expect(
        appendAssistantMessageToSessionTranscript({ ...fresh, mediaUrls: undefined }),
      ).rejects.toThrow("conflicts with the admitted message");
      await expect(
        appendAssistantMessageToSessionTranscript({
          ...fresh,
          text: "Different",
          ...(explicitContent ? { content: [{ type: "text" as const, text: "Different" }] } : {}),
        }),
      ).rejects.toThrow("conflicts with the admitted message");
      const events = await loadTranscriptEvents(scope);
      expect(
        events.filter((event) => readTranscriptEventMessage(event)?.role === "assistant"),
      ).toEqual([
        expect.objectContaining({
          message: { ...original, idempotencyKey: params.idempotencyKey },
        }),
        expect.objectContaining({
          message: expect.objectContaining({
            role: "assistant",
            openclawDelivery: { mediaUrls: fresh.mediaUrls },
            content: [{ type: "text", text: explicitContent ? "Chart" : "Chart\nchart.png" }],
          }),
        }),
      ]);
    },
  );

  it("records empty media identity so new explicit content cannot acquire media on replay", async () => {
    const scope = await createScope();
    const params = {
      ...scope,
      expectedSessionId: scope.sessionId,
      idempotencyKey: "new-no-media-reply",
      content: [{ type: "text" as const, text: "Chart" }],
    };
    const first = await appendAssistantMessageToSessionTranscript(params);
    expect(first.ok).toBe(true);
    expect(await appendAssistantMessageToSessionTranscript(params)).toEqual(first);
    const before = readRawEvents(scope.sessionId);
    expect(
      (await loadTranscriptEvents(scope)).map(readTranscriptEventMessage).filter(Boolean),
    ).toEqual([expect.objectContaining({ openclawDelivery: { mediaUrls: [] } })]);
    await expect(
      appendAssistantMessageToSessionTranscript({
        ...params,
        mediaUrls: ["https://example.com/chart.png"],
      }),
    ).rejects.toThrow("conflicts with the admitted message");
    expect(readRawEvents(scope.sessionId)).toEqual(before);
  });

  it("preserves legacy display and delivery facts and rejects changes to either", async () => {
    const scope = await createScope();
    const original = {
      ...legacyMirrorMessage(),
      idempotencyKey: "legacy-facts",
      openclawDisplayContent: [{ type: "text", text: "Visible chart" }],
      openclawDelivery: { audioAsVoice: true as const, replyToId: "source-message" },
      openclawDeliveryMirror: { kind: "channel-final", sourceMessageId: "source-message" },
    };
    const first = await appendExactAssistantMessageToSessionTranscript({
      ...scope,
      message: original,
    });
    expect(first.ok).toBe(true);
    const before = readRawEvents(scope.sessionId);
    const candidate = {
      ...original,
      openclawDelivery: {
        ...original.openclawDelivery,
        mediaUrls: ["https://example.com/chart.png"],
      },
    };
    expect(
      await appendExactAssistantMessageToSessionTranscript({ ...scope, message: candidate }),
    ).toEqual(first);
    for (const message of [
      { ...candidate, openclawDisplayContent: [{ type: "text", text: "Different" }] },
      { ...candidate, openclawDelivery: { ...candidate.openclawDelivery, replyToId: "other" } },
      {
        ...candidate,
        openclawDelivery: {
          replyToId: "source-message",
          mediaUrls: candidate.openclawDelivery.mediaUrls,
        },
      },
      { ...candidate, openclawDeliveryMirror: { kind: "channel-final", sourceMessageId: "other" } },
      { ...candidate, usage: { ...candidate.usage, output: 1 } },
      { ...candidate, model: "gateway-injected" },
    ]) {
      await expect(
        appendExactAssistantMessageToSessionTranscript({ ...scope, message }),
      ).rejects.toThrow("conflicts with the admitted message");
    }
    expect(readRawEvents(scope.sessionId)).toEqual(before);
  });

  it.each([{ mediaUrls: [] }, { mediaUrls: null }, { mediaUrls: "invalid" }, { mediaUrls: [42] }])(
    "keeps a stored own mediaUrls field strict: $mediaUrls",
    async ({ mediaUrls }) => {
      const scope = await createScope();
      // Generic append can seed malformed facts without a type cast or raw SQL write.
      const original = {
        ...legacyMirrorMessage(),
        idempotencyKey: "present-media-identity",
        openclawDelivery: { mediaUrls },
      };
      const first = await appendTranscriptMessage(scope, { message: original });
      expect(first.appended).toBe(true);
      expect(first.message.openclawDelivery).toEqual({ mediaUrls });
      expect((await appendTranscriptMessage(scope, { message: original })).appended).toBe(false);
      const before = readRawEvents(scope.sessionId);
      await expect(
        appendAssistantMessageToSessionTranscript({
          ...scope,
          idempotencyKey: original.idempotencyKey,
          content: original.content,
          mediaUrls: ["https://example.com/chart.png"],
        }),
      ).rejects.toThrow("conflicts with the admitted message");
      await expect(
        appendExactAssistantMessageToSessionTranscript({
          ...scope,
          idempotencyKey: original.idempotencyKey,
          message: legacyMirrorMessage(),
        }),
      ).rejects.toThrow("conflicts with the admitted message");
      expect(readRawEvents(scope.sessionId)).toEqual(before);
    },
  );

  it.each([
    { role: "user", api: "openclaw-transcript", provider: "openclaw", model: "delivery-mirror" },
    {
      role: "assistant",
      api: "openclaw-transcript",
      provider: "openclaw",
      model: "gateway-injected",
    },
    { role: "assistant", api: "provider-api", provider: "openclaw", model: "delivery-mirror" },
    { role: "assistant", api: "openclaw-transcript", provider: "other", model: "delivery-mirror" },
  ])("does not relax media identity for $role/$api/$provider/$model", async (identity) => {
    const scope = await createScope();
    const original = { ...legacyMirrorMessage(), ...identity, idempotencyKey: "non-mirror" };
    const first = await appendTranscriptMessage(scope, { message: original });
    expect(first.appended).toBe(true);
    expect((await appendTranscriptMessage(scope, { message: original })).appended).toBe(false);
    const before = readRawEvents(scope.sessionId);
    await expect(
      appendTranscriptMessage(scope, {
        message: {
          ...original,
          openclawDelivery: { mediaUrls: ["https://example.com/chart.png"] },
        },
      }),
    ).rejects.toThrow("conflicts with the admitted message");
    expect(readRawEvents(scope.sessionId)).toEqual(before);
  });
});
