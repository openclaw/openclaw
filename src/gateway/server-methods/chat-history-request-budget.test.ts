import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessages,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { serializeGatewayFrame } from "../serialized-json.js";
import {
  historyPayload,
  historyRpc,
  seedHistorySession,
} from "./chat-history-fixture.test-support.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";

function withHistory(
  id: string,
  run: (scope: Awaited<ReturnType<typeof seedHistorySession>>) => Promise<void>,
) {
  return withOpenClawTestState({ scenario: "minimal" }, async () => {
    await captureRuntimeConfigAsyncReader()();
    await run(await seedHistorySession(id));
  });
}

async function requestFor(
  scope: { sessionKey: string },
  method: "chat.history" | "chat.startup" = "chat.history",
) {
  return createHistoryRequest(method, scope.sessionKey, await createHistoryReadContext());
}

function createHistoryRequest(
  method: "chat.history" | "chat.startup" | "chat.message.get",
  sessionKey: string,
  context: Awaited<ReturnType<typeof createHistoryReadContext>>,
) {
  const rpc = historyRpc(context, sessionKey);
  return async (params: Record<string, unknown>) => {
    const payload = historyPayload(
      await rpc(
        method,
        { ...(method === "chat.message.get" ? {} : { limit: 80 }), ...params },
        { acceptsSerializedJson: true },
      ),
    );
    const result = JSON.parse(serializeGatewayFrame({ type: "res", payload }).toString()).payload;
    return expectDefined(asOptionalRecord(result), "history response");
  };
}

const textContent = (text: string) => [{ type: "text", text }];
function row(eventId: string, role: string, content: unknown, extra: Record<string, unknown> = {}) {
  return { eventId, message: { role, content, ...extra } };
}
const toolRow = (
  eventId: string,
  toolCallId: string,
  content: string | ReturnType<typeof textContent>,
) => row(eventId, "toolResult", content, { toolName: "read", toolCallId });
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const rows = (value: unknown) =>
  expectDefined(Array.isArray(value) ? value : undefined, "messages");
const offsetOf = (value: unknown) =>
  expectDefined(typeof value === "number" ? value : undefined, "advancing offset");
const signedText = (id: string, text: string, phase: string) => ({
  type: "text",
  text,
  textSignature: JSON.stringify({ v: 1, id, phase }),
});
const oversizedReference = (extra: Record<string, unknown> = {}) =>
  expect.objectContaining({
    __openclaw: expect.objectContaining({ truncated: true, reason: "oversized", ...extra }),
  });

it("keeps the requested text cap when catching up from a cursor", async () => {
  await withHistory("text-cap", async (scope) => {
    await appendTranscriptMessage(scope, row("initial", "user", "Initial prompt"));
    const history = await requestFor(scope);
    const tail = await history({ maxChars: 12_000 });
    const text = "Long visible reply. ".repeat(500);
    await appendTranscriptMessage(scope, row("reply", "assistant", textContent(text)));
    expect(await history({ cursor: tail.deltaCursor, maxChars: 12_000 })).toMatchObject({
      kind: "delta",
      messages: [{ message: { content: textContent(text) } }],
    });
  });
});

it("opts into smaller tool previews without changing text, paging, or full output", async () => {
  await withHistory("tool-previews", async (scope) => {
    const text = "Captured output line\n".repeat(500);
    const prose = "Visible conversation text. ".repeat(160);
    await appendTranscriptMessages(scope, {
      messages: [
        ...Array.from({ length: 48 }, (_, index) =>
          toolRow(`preview-${index}`, `call-${index}`, textContent(text)),
        ),
        ...["user", "assistant"].map((role) => row(role, role, textContent(prose))),
      ],
    });
    const context = await createHistoryReadContext();
    const history = createHistoryRequest("chat.history", scope.sessionKey, context);
    const legacy = await history({});
    const compact = await history({ toolResultMaxChars: 2_000 });
    expect(bytes(compact)).toBeLessThan(bytes(legacy) / 3);
    expect(compact.hasMore).toBe(false);
    expect(compact.messages).toEqual([
      ...Array.from({ length: 48 }, (_, index) =>
        expect.objectContaining({
          toolCallId: `call-${index}`,
          content: textContent(text.slice(0, 2_000)),
          __openclaw: expect.objectContaining({ truncated: true, reason: "display-cap" }),
        }),
      ),
      ...["user", "assistant"].map((role) =>
        expect.objectContaining({ role, content: textContent(prose) }),
      ),
    ]);
    const getMessage = createHistoryRequest("chat.message.get", scope.sessionKey, context);
    expect(await getMessage({ messageId: "preview-0" })).toMatchObject({
      ok: true,
      message: { content: textContent(text) },
    });
    const tail = await history({ limit: 20, toolResultMaxChars: 2_000 });
    const older = await history({ offset: tail.nextOffset, toolResultMaxChars: 2_000 });
    expect([...rows(older.messages), ...rows(tail.messages)]).toEqual(compact.messages);
    await appendTranscriptMessage(scope, toolRow("next-tool", "next-call", textContent(text)));
    const delta = await history({ cursor: compact.deltaCursor, toolResultMaxChars: 2_000 });
    expect(delta).toMatchObject({
      kind: "delta",
      messages: [{ message: { content: textContent(text.slice(0, 2_000)) } }],
    });
    const anchored = await history({ messageId: "next-tool", toolResultMaxChars: 2_000 });
    expect(anchored.messages).toContainEqual(
      expect.objectContaining({
        toolCallId: "next-call",
        content: textContent(text.slice(0, 2_000)),
      }),
    );
  });
});

it.each(["chat.history", "chat.startup"] as const)(
  "%s returns a small tail with a lossless back-scroll cursor",
  async (method) => {
    await withHistory("budgeted-history", async (scope) => {
      const messages = Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content:
          index % 4 === 1
            ? [
                { type: "toolcall", id: `call-${index}`, name: "Read", arguments: {} },
                {
                  type: "tool_result",
                  tool_use_id: `call-${index}`,
                  content: `record-${index}: ${"x".repeat(3_000)}`,
                },
              ]
            : textContent(`record-${index}: ${"x".repeat(3_000)}`),
      }));
      for (const message of messages) {
        await appendTranscriptMessage(scope, { message });
      }
      const request = await requestFor(scope, method);

      const tail = await request({ maxBytes: 8 * 1024 });
      expect(bytes(tail.messages)).toBeLessThanOrEqual(8 * 1024);
      expect(tail.hasMore).toBe(true);
      expect(tail.nextOffset).toBeGreaterThan(0);
      expect(JSON.stringify(tail.messages)).toContain("record-11:");
      const unchanged = await request({ cursor: tail.deltaCursor });
      expect(unchanged).toMatchObject({
        kind: "delta",
        messages: [],
        deltaCursor: tail.deltaCursor,
      });
      expect(bytes(unchanged)).toBeLessThan(2 * 1024);
      const older = await request({ offset: tail.nextOffset });
      expect(older.hasMore).toBe(false);
      const restored = [...rows(older.messages), ...rows(tail.messages)];
      expect(restored).toHaveLength(messages.length);
      for (const [index, message] of restored.entries()) {
        expect(JSON.stringify(message)).toContain(`record-${index}:`);
      }

      const longText = "Readable message beyond the soft page budget: " + "z".repeat(70_000);
      await appendTranscriptMessage(scope, {
        message: { role: "assistant", content: textContent(longText) },
      });
      expect(await request({ cursor: tail.deltaCursor, maxBytes: 8 * 1024 })).toEqual({
        kind: "reset",
      });
      const single = await request({ maxBytes: 64 * 1024, maxChars: 100_000 });
      expect(single.messages).toContainEqual(oversizedReference());
      expect(bytes(single.messages)).toBeLessThanOrEqual(64 * 1024);
      expect(single.hasMore).toBe(false);
    });
  },
);

it("honors larger older-history budgets without growing the default or losing messages", async () => {
  await withHistory("large-budgeted-history", async (scope) => {
    const texts = Array.from(
      { length: 320 },
      (_, index) => `record-${index}: ${"x".repeat(7_000)}`,
    );
    await appendTranscriptMessages(scope, {
      messages: texts.map((text, index) => ({
        message: { role: index % 2 === 0 ? "user" : "assistant", content: textContent(text) },
      })),
    });
    const request = await requestFor(scope);
    const tail = await request({ maxBytes: 256 * 1024 });
    expect(bytes(tail.messages)).toBeLessThanOrEqual(256 * 1024);
    const pageCounts: number[] = [];
    for (const maxBytes of [undefined, 1024 * 1024]) {
      const restored: unknown[] = rows(tail.messages).slice();
      let offset = offsetOf(tail.nextOffset);
      let pages = 0;
      for (;;) {
        const page = await request({ limit: 1000, offset, ...(maxBytes ? { maxBytes } : {}) });
        const messages = rows(page.messages);
        const size = bytes(messages);
        expect(messages.length).toBeGreaterThan(0);
        expect(size).toBeLessThanOrEqual(maxBytes ?? 512 * 1024);
        if (maxBytes && pages === 0) {
          expect(size).toBeGreaterThan(512 * 1024);
        }
        restored.unshift(...messages);
        expect(restored.length).toBeLessThanOrEqual(texts.length);
        pages += 1;
        if (page.hasMore !== true) {
          break;
        }
        const nextOffset = offsetOf(page.nextOffset);
        expect(nextOffset).toBeGreaterThan(offset);
        offset = nextOffset;
      }

      pageCounts.push(pages);
      expect(restored).toHaveLength(texts.length);
      for (const [index, message] of restored.entries()) {
        expect(JSON.stringify(message)).toContain(texts[index]);
      }
    }
    expect(pageCounts[1]).toBeLessThan(expectDefined(pageCounts[0], "default page count"));
  });
});

it("replaces an indivisible source row with a fetchable reference across anchored and back-scroll pages", async () => {
  await withHistory("history-sibling-budget", async (scope) => {
    await appendTranscriptMessage(scope, row("before", "user", "Before the sibling group"));
    const texts = Array.from(
      { length: 10 },
      (_, index) => `sibling-${index}: ${"x".repeat(60_000)}`,
    );
    await appendTranscriptMessage(scope, {
      eventId: "sibling-group",
      message: {
        role: "assistant",
        content: [
          ...texts.map((text, index) => signedText(`sibling-${index}`, text, "commentary")),
          signedText("final", "Short final answer", "final_answer"),
        ],
      },
    });
    await appendTranscriptMessage(scope, row("after", "user", "After the sibling group"));
    const context = await createHistoryReadContext();
    const request = createHistoryRequest("chat.history", scope.sessionKey, context);
    const getMessage = createHistoryRequest("chat.message.get", scope.sessionKey, context);
    const original = await loadTranscriptEvents(scope);

    const anchored = await request({ messageId: "sibling-group", maxChars: 100_000 });
    expect(bytes(anchored)).toBeLessThan(1_000_000);
    expect(anchored.messages).toContainEqual(oversizedReference({ id: "sibling-group" }));
    expect(anchored.nextOffset).toBeUndefined();

    const recovered = await getMessage({ messageId: "sibling-group", maxChars: 8_000_000 });
    expect(recovered.ok).toBe(true);
    for (const text of texts) {
      expect(JSON.stringify(recovered.message)).toContain(text);
    }
    const truncated = await getMessage({ messageId: "sibling-group", maxChars: 1000 });
    expect(truncated).toMatchObject({
      ok: true,
      message: { __openclaw: { truncated: true, reason: "display-cap" } },
    });
    expect(JSON.stringify(truncated.message)).toContain("Short final answer");
    const expected = ["Before the sibling group", "sibling-group", "After the sibling group"];
    const seen = new Set<string>();
    let offset: number | undefined;
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const page = await request({
        maxChars: 100_000,
        ...(offset === undefined ? {} : { offset }),
      });
      const serialized = JSON.stringify(page.messages);
      expect(bytes(page)).toBeLessThan(1_000_000);
      for (const text of expected) {
        if (serialized.includes(text)) {
          seen.add(text);
        }
      }
      if (page.hasMore !== true) {
        expect(seen.size).toBe(expected.length);
        expect(await loadTranscriptEvents(scope)).toEqual(original);
        return;
      }
      const nextOffset = offsetOf(page.nextOffset);
      expect(nextOffset).toBeGreaterThan(offset ?? 0);
      offset = nextOffset;
    }
    throw new Error("History did not finish within its three source rows");
  });
});

it("keeps a 5 MB tool result out of history while its reference returns every byte", async () => {
  await withHistory("large-tool", async (scope) => {
    const text = "tool-output:" + "x".repeat(5_000_000);
    await appendTranscriptMessage(scope, toolRow("large-result", "large-call", textContent(text)));
    const original = await loadTranscriptEvents(scope);
    const context = await createHistoryReadContext();
    const history = createHistoryRequest("chat.history", scope.sessionKey, context);
    for (const selector of [{}, { messageId: "large-result" }]) {
      const page = await history({ ...selector, maxChars: 500_000 });
      expect(bytes(page)).toBeLessThan(1_000_000);
      expect(page.messages).toMatchObject([
        { toolCallId: "large-call", __openclaw: { id: "large-result", truncated: true } },
      ]);
    }
    const getMessage = createHistoryRequest("chat.message.get", scope.sessionKey, context);
    expect(await getMessage({ messageId: "large-result", maxChars: 8_000_000 })).toMatchObject({
      ok: true,
      message: { content: textContent(text) },
    });
    expect(await loadTranscriptEvents(scope)).toEqual(original);
  });
});

it("keeps recovery lookahead beyond the default response target on older pages", async () => {
  await withHistory("history-recovery-budget", async (scope) => {
    const progress = Array.from({ length: 7 }, (_, index) =>
      toolRow(`progress-${index}`, `tool-${index}`, "x".repeat(90_000)),
    );
    await appendTranscriptMessages(scope, {
      messages: [
        row("question", "user", "Question"),
        row("failed", "assistant", [], {
          stopReason: "error",
          errorMessage: "The selected model is unavailable.",
          __openclaw: { runId: "recovered-run" },
        }),
        ...progress,
        row("answer", "assistant", "Recovered answer", {
          stopReason: "stop",
          __openclaw: { runId: "recovered-run" },
        }),
      ],
    });
    const request = await requestFor(scope);

    const older = await request({ offset: progress.length + 1, limit: 1 });
    expect(older).toMatchObject({
      messages: [{ role: "user", __openclaw: { id: "question" } }],
      hasMore: false,
    });
  });
});
