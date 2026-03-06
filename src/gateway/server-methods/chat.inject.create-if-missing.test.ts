import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";

const mockState = vi.hoisted(() => ({
  dir: "",
  transcriptPath: "",
  sessionId: "sess-1",
}));

vi.mock("../session-utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...original,
    loadSessionEntry: (_rawKey: string) => ({
      cfg: {},
      storePath: path.join(mockState.dir, "sessions.json"),
      entry: {
        sessionId: mockState.sessionId,
        // Important: session metadata resolves a transcriptPath, but the file may not exist.
        sessionFile: mockState.transcriptPath,
      },
      canonicalKey: "main",
    }),
  };
});

const { chatHandlers } = await import("./chat.js");

function createChatContext(): Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq"> {
  return {
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    agentRunSeq: new Map(),
  };
}

describe("gateway chat.inject", () => {
  afterEach(() => {
    if (mockState.dir) {
      fs.rmSync(mockState.dir, { recursive: true, force: true });
    }
    mockState.dir = "";
    mockState.transcriptPath = "";
  });

  it("creates transcript file if missing", async () => {
    mockState.dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chat-inject-missing-transcript-"));
    mockState.transcriptPath = path.join(mockState.dir, "sess.jsonl");

    // Ensure it does NOT exist beforehand.
    expect(fs.existsSync(mockState.transcriptPath)).toBe(false);

    const respond = vi.fn();
    const context = createChatContext();

    await chatHandlers["chat.inject"]({
      params: { sessionKey: "main", message: "hello" },
      respond,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: context as GatewayRequestContext,
    });

    expect(respond).toHaveBeenCalled();
    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ ok: true, messageId: expect.any(String) });

    expect(fs.existsSync(mockState.transcriptPath)).toBe(true);
    const lines = fs.readFileSync(mockState.transcriptPath, "utf-8").split(/\r?\n/).filter(Boolean);
    // session header + appended message
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});
