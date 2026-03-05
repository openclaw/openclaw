import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";

const mockState = vi.hoisted(() => ({
  transcriptPath: "",
  dir: "",
  sessionId: "sess-1",
}));

vi.mock("../session-utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...original,
    loadSessionEntry: (rawKey: string) => ({
      cfg: {
        session: {
          mainKey: rawKey || "main",
        },
      },
      storePath: path.join(path.dirname(mockState.transcriptPath), "sessions.json"),
      entry: {
        sessionId: mockState.sessionId,
        sessionFile: mockState.transcriptPath,
      },
      canonicalKey: rawKey || "main",
    }),
  };
});

const { chatHandlers } = await import("./chat.js");

afterEach(() => {
  if (mockState.dir) {
    fs.rmSync(mockState.dir, { recursive: true, force: true });
    mockState.dir = "";
    mockState.transcriptPath = "";
  }
});

function createChatContext(): Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession"> {
  return {
    broadcast: vi.fn() as unknown as GatewayRequestContext["broadcast"],
    nodeSendToSession: vi.fn() as unknown as GatewayRequestContext["nodeSendToSession"],
  };
}

// Regression guard for https://github.com/openclaw/openclaw/issues/36170
// chat.inject should create the transcript file if it's missing.
describe("gateway chat.inject", () => {
  it("creates transcript file when missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chat-inject-missing-"));
    const transcriptPath = path.join(dir, "sess.jsonl");
    mockState.dir = dir;
    mockState.transcriptPath = transcriptPath;

    expect(fs.existsSync(transcriptPath)).toBe(false);

    const respond = vi.fn();
    const context = createChatContext();

    await chatHandlers["chat.inject"]({
      params: { sessionKey: "main", message: "hello" },
      respond,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      // chat.inject only needs these to broadcast; pass the minimal shape.
      context: context as unknown as GatewayRequestContext,
    });

    const [ok, payload, error] = respond.mock.calls.at(-1) ?? [];
    expect(error).toBeUndefined();
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ ok: true, messageId: expect.any(String) });

    expect(fs.existsSync(transcriptPath)).toBe(true);
    const lines = fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const header = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(header.type).toBe("session");
  });
});
