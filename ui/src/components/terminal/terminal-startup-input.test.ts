import { describe, expect, it, vi } from "vitest";
import { createTerminalStartupInput } from "./terminal-startup-input.ts";

describe("createTerminalStartupInput", () => {
  it("reassembles UTF-8 code points split across WebSocket chunks before session bind", () => {
    const input = vi.fn();
    const resize = vi.fn();
    let sessionId: string | undefined;
    const startup = createTerminalStartupInput({ input, resize }, () => sessionId);

    // "中" is E4 B8 AD — feed one byte per chunk the way a WS frame split can.
    const bytes = new TextEncoder().encode("中😀");
    for (const byte of bytes) {
      startup.onData(Uint8Array.of(byte));
    }

    const pending = startup.buffer.drain().join("");
    console.info(
      "[terminal-utf8-proof] one-byte chunks before bind: %j hasFFFD=%s",
      pending,
      String(pending.includes("\uFFFD")),
    );
    expect(pending).toBe("中😀");
    expect(pending).not.toContain("\uFFFD");
  });

  it("does not emit U+FFFD for a mid-sequence chunk without stream mode regression", () => {
    const input = vi.fn();
    const resize = vi.fn();
    const startup = createTerminalStartupInput({ input, resize }, () => undefined);

    // First two bytes of "中" alone must stay buffered in the stream decoder,
    // not become replacement characters in the pending input buffer.
    startup.onData(Uint8Array.of(0xe4, 0xb8));
    expect(startup.buffer.drain()).toEqual([]);

    startup.onData(Uint8Array.of(0xad));
    expect(startup.buffer.drain().join("")).toBe("中");
  });

  it("keeps decoder state across session bind so a straddling scalar completes", () => {
    const input = vi.fn();
    const resize = vi.fn();
    let sessionId: string | undefined;
    const startup = createTerminalStartupInput({ input, resize }, () => sessionId);

    // Partial "中" before bind — must NOT be finalized by adopt/flush.
    startup.onData(Uint8Array.of(0xe4, 0xb8));
    expect(startup.buffer.drain()).toEqual([]);

    // Session appears (adopt drains only complete buffer text; decoder stays open).
    sessionId = "sess-1";
    for (const data of startup.buffer.drain()) {
      void input("sess-1", data);
    }

    // Completing byte arrives after bind.
    startup.onData(Uint8Array.of(0xad));

    expect(input).toHaveBeenCalledWith("sess-1", "中");
    const joined = input.mock.calls.map((call) => call[1] as string).join("");
    console.info(
      "[terminal-utf8-proof] straddle adopt session: delivered=%j hasFFFD=%s",
      joined,
      String(joined.includes("\uFFFD")),
    );
    expect(joined).toBe("中");
    expect(joined).not.toContain("\uFFFD");
  });

  it("proves non-stream decode mojibakes the same split that stream mode keeps intact", () => {
    const broken = new TextDecoder();
    const first = broken.decode(Uint8Array.of(0xe4, 0xb8));
    const second = broken.decode(Uint8Array.of(0xad));
    // Without { stream: true }, the incomplete lead becomes U+FFFD and the
    // trailing byte cannot reassemble into 中.
    expect(`${first}${second}`).toContain("\uFFFD");
    expect(`${first}${second}`).not.toBe("中");

    const streaming = createTerminalStartupInput(
      { input: vi.fn(), resize: vi.fn() },
      () => undefined,
    );
    streaming.onData(Uint8Array.of(0xe4, 0xb8));
    streaming.onData(Uint8Array.of(0xad));
    expect(streaming.buffer.drain().join("")).toBe("中");
  });

  it("flushes incomplete trailer only on explicit dispose flush", () => {
    const input = vi.fn();
    const resize = vi.fn();
    let sessionId: string | undefined = "sess-1";
    const startup = createTerminalStartupInput({ input, resize }, () => sessionId);

    startup.onData(new TextEncoder().encode("ok"));
    startup.onData(Uint8Array.of(0xe4));
    startup.flush();

    const joined = input.mock.calls.map((call) => call[1] as string).join("");
    expect(joined.startsWith("ok")).toBe(true);
  });
});
