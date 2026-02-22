import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createMockSessionEntry, createTranscriptFixtureSync } from "./chat.test-helpers.js";
import type { GatewayRequestContext } from "./types.js";

// Guardrail: Ensure gateway "injected" assistant transcript messages are appended via SessionManager,
// so they are attached to the current leaf with a `parentId` and do not sever compaction history.
describe("gateway chat.inject transcript writes", () => {
  it("appends a Pi session entry that includes parentId", async () => {
    const sessionId = "sess-1";
    const { transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-",
      sessionId,
    });

    vi.doMock("../session-utils.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../session-utils.js")>();
      return {
        ...original,
        loadSessionEntry: () =>
          createMockSessionEntry({
            transcriptPath,
            sessionId,
            canonicalKey: "k1",
          }),
      };
    });

    const { chatHandlers } = await import("./chat.js");

    const respond = vi.fn();
    type InjectCtx = Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession">;
    const context: InjectCtx = {
      broadcast: vi.fn() as unknown as InjectCtx["broadcast"],
      nodeSendToSession: vi.fn() as unknown as InjectCtx["nodeSendToSession"],
    };
    await chatHandlers["chat.inject"]({
      params: { sessionKey: "k1", message: "hello" },
      respond,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: context as unknown as GatewayRequestContext,
    });

    expect(respond).toHaveBeenCalled();
    const [, payload, error] = respond.mock.calls.at(-1) ?? [];
    expect(error).toBeUndefined();
    expect(payload).toMatchObject({ ok: true });

    const lines = fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const last = JSON.parse(lines.at(-1) as string) as Record<string, unknown>;
    expect(last.type).toBe("message");

    // The regression we saw: raw jsonl appends omitted this field entirely.
    expect(Object.prototype.hasOwnProperty.call(last, "parentId")).toBe(true);
    expect(last).toHaveProperty("id");
    expect(last).toHaveProperty("message");
  });
});
