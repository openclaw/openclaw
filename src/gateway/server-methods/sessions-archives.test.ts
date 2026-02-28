import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { formatSessionArchiveTimestamp } from "../../config/sessions/artifacts.js";

// --- Mocks ---

let tmpDir = "";
const mockStore: Record<string, { sessionId?: string; sessionFile?: string }> = {};

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({ session: {} })),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: vi.fn(() => "main"),
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    resolveSessionTranscriptsDirForAgent: vi.fn(() => tmpDir),
    resolveStorePath: vi.fn(() => path.join(tmpDir, "sessions.json")),
    loadSessionStore: vi.fn(() => ({ ...mockStore })),
  };
});

// --- Helpers ---

function writeJsonlFile(dir: string, fileName: string, lines: unknown[]): string {
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return filePath;
}

type RespondArgs = [ok: boolean, payload?: unknown, error?: unknown];

function createRespond(): { calls: RespondArgs[]; fn: (...args: RespondArgs) => void } {
  const calls: RespondArgs[] = [];
  return {
    calls,
    fn: (...args: RespondArgs) => {
      calls.push(args);
    },
  };
}

// --- Tests ---

describe("sessions.archives handler", () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-archives-handler-test-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Clear files and store between tests.
    for (const f of fs.readdirSync(tmpDir)) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
    for (const key of Object.keys(mockStore)) {
      delete mockStore[key];
    }
  });

  // Import handler after mocks are set up.
  async function getHandler() {
    const { sessionsArchivesHandlers } = await import("./sessions-archives.js");
    return sessionsArchivesHandlers["sessions.archives"];
  }

  function callHandler(handler: Function, params: Record<string, unknown> = {}) {
    const respond = createRespond();
    const promise = handler({
      params,
      respond: respond.fn,
      context: {},
    });
    return { respond, promise };
  }

  test("returns archived files with .reset suffix", async () => {
    const ts = formatSessionArchiveTimestamp();
    writeJsonlFile(tmpDir, `sess-a.jsonl.reset.${ts}`, [
      { id: "sess-a", timestamp: "2026-02-26T00:00:00.000Z", type: "header" },
      { message: { role: "user", content: "hello" } },
      { message: { role: "assistant", content: "hi" } },
    ]);

    const handler = await getHandler();
    const { respond, promise } = callHandler(handler);
    await promise;

    expect(respond.calls).toHaveLength(1);
    const [ok, payload] = respond.calls[0];
    expect(ok).toBe(true);
    const result = payload as { archives: unknown[]; total: number };
    expect(result.total).toBe(1);
    expect(result.archives).toHaveLength(1);
    const entry = result.archives[0] as Record<string, unknown>;
    expect(entry.sessionId).toBe("sess-a");
    expect(entry.archiveReason).toBe("reset");
    expect(entry.messageCount).toBe(2);
  });

  test("returns archived files with .deleted and .bak suffixes", async () => {
    const ts = formatSessionArchiveTimestamp();
    writeJsonlFile(tmpDir, `sess-d.jsonl.deleted.${ts}`, [
      { id: "sess-d", timestamp: "2026-02-25T00:00:00.000Z", type: "header" },
      { message: { role: "user", content: "test" } },
    ]);
    writeJsonlFile(tmpDir, `sess-b.jsonl.bak.${ts}`, [
      { id: "sess-b", timestamp: "2026-02-24T00:00:00.000Z", type: "header" },
    ]);

    const handler = await getHandler();
    const { respond, promise } = callHandler(handler);
    await promise;

    const [ok, payload] = respond.calls[0];
    expect(ok).toBe(true);
    const result = payload as { archives: Array<Record<string, unknown>>; total: number };
    expect(result.total).toBe(2);
    const reasons = result.archives.map((a) => a.archiveReason);
    expect(reasons).toContain("deleted");
    expect(reasons).toContain("bak");
  });

  test("excludes active sessions referenced in store", async () => {
    // Active session in store.
    mockStore["my-key"] = { sessionId: "active-sess" };
    writeJsonlFile(tmpDir, "active-sess.jsonl", [
      { id: "active-sess", timestamp: "2026-02-26T10:00:00.000Z", type: "header" },
      { message: { role: "user", content: "active" } },
    ]);

    const handler = await getHandler();
    const { respond, promise } = callHandler(handler);
    await promise;

    const [ok, payload] = respond.calls[0];
    expect(ok).toBe(true);
    const result = payload as { archives: unknown[]; total: number };
    expect(result.total).toBe(0);
  });

  test("returns orphaned .jsonl files not in store", async () => {
    // No store entry for this session.
    writeJsonlFile(tmpDir, "orphan-sess.jsonl", [
      { id: "orphan-sess", timestamp: "2026-02-20T00:00:00.000Z", type: "header" },
      { message: { role: "user", content: "orphan" } },
    ]);

    const handler = await getHandler();
    const { respond, promise } = callHandler(handler);
    await promise;

    const [ok, payload] = respond.calls[0];
    expect(ok).toBe(true);
    const result = payload as { archives: Array<Record<string, unknown>>; total: number };
    expect(result.total).toBe(1);
    expect(result.archives[0].archiveReason).toBe("orphaned");
    expect(result.archives[0].sessionId).toBe("orphan-sess");
  });

  test("respects limit param", async () => {
    const ts = formatSessionArchiveTimestamp();
    for (let i = 0; i < 5; i++) {
      writeJsonlFile(tmpDir, `s${i}.jsonl.reset.${ts}`, [
        { id: `s${i}`, timestamp: "2026-02-26T00:00:00.000Z", type: "header" },
      ]);
    }

    const handler = await getHandler();
    const { respond, promise } = callHandler(handler, { limit: 2 });
    await promise;

    const [ok, payload] = respond.calls[0];
    expect(ok).toBe(true);
    const result = payload as { archives: unknown[]; total: number };
    expect(result.total).toBe(5);
    expect(result.archives).toHaveLength(2);
  });

  test("rejects invalid params", async () => {
    const handler = await getHandler();
    const { respond, promise } = callHandler(handler, { limit: -1 });
    await promise;

    const [ok] = respond.calls[0];
    expect(ok).toBe(false);
  });

  test("returns empty for nonexistent sessions directory", async () => {
    const { resolveSessionTranscriptsDirForAgent } = await import("../../config/sessions.js");
    (resolveSessionTranscriptsDirForAgent as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      "/nonexistent/path/that/does/not/exist",
    );

    const handler = await getHandler();
    const { respond, promise } = callHandler(handler);
    await promise;

    const [ok, payload] = respond.calls[0];
    expect(ok).toBe(true);
    const result = payload as { archives: unknown[]; total: number };
    expect(result.total).toBe(0);
  });
});

describe("chat.history archiveFile path traversal", () => {
  test("basename check rejects path traversal attempts", () => {
    const badNames = ["../etc/passwd", "foo/../../bar.jsonl", "/absolute/path.jsonl"];
    for (const name of badNames) {
      const baseName = path.basename(name);
      expect(baseName === name && !name.includes("..") && !name.includes("/")).toBe(false);
    }
  });

  test("basename check accepts valid archive filenames", () => {
    const goodNames = [
      "fa84d053-xxx.jsonl",
      "test.jsonl.reset.2026-02-26T01-06-04.374Z",
      "abc-123.jsonl.deleted.2026-01-01T00-00-00.000Z",
    ];
    for (const name of goodNames) {
      const baseName = path.basename(name);
      expect(baseName).toBe(name);
      expect(name.includes("..")).toBe(false);
      expect(name.includes("/")).toBe(false);
    }
  });
});
