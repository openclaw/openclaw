import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RespondFn } from "./types.js";

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

const loadSessionEntryMock = vi.fn();
const readSessionMessagesMock = vi.fn();
const getTaskSessionLookupByIdForStatusMock = vi.fn();
const resolveSessionKeyForRunMock = vi.fn();

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
    readSessionMessages: (...args: unknown[]) => readSessionMessagesMock(...args),
  };
});

vi.mock("../../tasks/task-status-access.js", () => ({
  getTaskSessionLookupByIdForStatus: (...args: unknown[]) =>
    getTaskSessionLookupByIdForStatusMock(...args),
}));

vi.mock("../server-session-key.js", () => ({
  resolveSessionKeyForRun: (...args: unknown[]) => resolveSessionKeyForRunMock(...args),
}));

import { collectArtifactsFromMessages, artifactsHandlers } from "./artifacts.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function callHandler(
  handler: (opts: import("./types.js").GatewayRequestHandlerOptions) => unknown,
  params: Record<string, unknown>,
): { ok: boolean; result: unknown; error: unknown } {
  let ok = false;
  let result: unknown;
  let error: unknown;
  const respond: RespondFn = (o, r, e) => {
    ok = o;
    result = r;
    error = e;
  };
  handler({
    params,
    respond,
    context: {} as never,
    req: { type: "req" as const, id: "1", method: "artifacts.list" },
    client: null,
    isWebchatConnect: () => false,
  });
  return { ok, result, error };
}

function makeImageBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "image",
    title: "screenshot.png",
    source: {
      type: "base64",
      media_type: "image/png",
      data: "aGVsbG8=",
    },
    ...overrides,
  };
}

function makeAudioBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "audio",
    title: "clip.mp3",
    data: "data:audio/mp3;base64,aGVsbG8=",
    ...overrides,
  };
}

function makeFileBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "file",
    title: "report.pdf",
    url: "https://example.com/report.pdf",
    ...overrides,
  };
}

function makeMessage(content: unknown[], meta: Record<string, unknown> = {}) {
  return { role: "assistant", content, __openclaw: { seq: 1, ...meta } };
}

function defaultSessionSetup() {
  loadSessionEntryMock.mockReturnValue({
    cfg: {},
    canonicalKey: "agent:main:main",
    storePath: "/tmp/sessions.json",
    entry: { sessionId: "sess-abc" },
  });
}

/* ------------------------------------------------------------------ */
/* collectArtifactsFromMessages unit tests                             */
/* ------------------------------------------------------------------ */

describe("collectArtifactsFromMessages", () => {
  it("returns empty array for no messages", () => {
    expect(collectArtifactsFromMessages({ messages: [], sessionKey: "agent:main:main" })).toEqual(
      [],
    );
  });

  it("skips non-object messages", () => {
    const result = collectArtifactsFromMessages({
      messages: [null, undefined, "string", 42],
      sessionKey: "agent:main:main",
    });
    expect(result).toEqual([]);
  });

  it("skips messages with no content", () => {
    expect(
      collectArtifactsFromMessages({
        messages: [{ role: "user" }],
        sessionKey: "agent:main:main",
      }),
    ).toEqual([]);
  });

  it("skips non-artifact content blocks", () => {
    expect(
      collectArtifactsFromMessages({
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        sessionKey: "agent:main:main",
      }),
    ).toEqual([]);
  });

  it("collects image blocks with base64 source data", () => {
    const result = collectArtifactsFromMessages({
      messages: [makeMessage([makeImageBlock()])],
      sessionKey: "agent:main:main",
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "image",
      title: "screenshot.png",
      mimeType: "image/png",
      download: { mode: "bytes" },
      sessionKey: "agent:main:main",
    });
    expect(result[0].data).toBe("aGVsbG8=");
  });

  it("collects audio blocks from data URL", () => {
    const result = collectArtifactsFromMessages({
      messages: [makeMessage([makeAudioBlock()])],
      sessionKey: "agent:main:main",
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "audio",
      title: "clip.mp3",
      mimeType: "audio/mp3",
      download: { mode: "bytes" },
    });
  });

  it("collects file blocks with remote URL", () => {
    const result = collectArtifactsFromMessages({
      messages: [makeMessage([makeFileBlock()])],
      sessionKey: "agent:main:main",
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "file",
      title: "report.pdf",
      download: { mode: "url" },
    });
    expect(result[0].url).toBe("https://example.com/report.pdf");
  });

  it("produces unsupported download mode when no data or url found", () => {
    const result = collectArtifactsFromMessages({
      messages: [makeMessage([{ type: "file", title: "empty.txt" }])],
      sessionKey: "agent:main:main",
    });
    expect(result).toHaveLength(1);
    expect(result[0].download).toEqual({ mode: "unsupported" });
  });

  it("generates stable artifact IDs from same inputs", () => {
    const messages = [makeMessage([makeImageBlock()])];
    const a = collectArtifactsFromMessages({ messages, sessionKey: "agent:main:main" });
    const b = collectArtifactsFromMessages({ messages, sessionKey: "agent:main:main" });
    expect(a[0].id).toBe(b[0].id);
    expect(a[0].id).toMatch(/^artifact_/);
  });

  it("generates different IDs for different sessions", () => {
    const messages = [makeMessage([makeImageBlock()])];
    const a = collectArtifactsFromMessages({ messages, sessionKey: "agent:main:main" });
    const b = collectArtifactsFromMessages({ messages, sessionKey: "agent:main:other" });
    expect(a[0].id).not.toBe(b[0].id);
  });

  it("filters by runId when provided", () => {
    const msg1 = {
      role: "assistant",
      content: [makeImageBlock()],
      __openclaw: { seq: 1, runId: "run-1" },
    };
    const msg2 = {
      role: "assistant",
      content: [makeFileBlock()],
      __openclaw: { seq: 2, runId: "run-2" },
    };
    const result = collectArtifactsFromMessages({
      messages: [msg1, msg2],
      sessionKey: "agent:main:main",
      runId: "run-1",
    });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("image");
  });

  it("filters by taskId when provided", () => {
    const msg1 = {
      role: "assistant",
      content: [makeImageBlock()],
      __openclaw: { seq: 1, messageTaskId: "task-a" },
    };
    const msg2 = {
      role: "assistant",
      content: [makeFileBlock()],
      __openclaw: { seq: 2, messageTaskId: "task-b" },
    };
    const result = collectArtifactsFromMessages({
      messages: [msg1, msg2],
      sessionKey: "agent:main:main",
      taskId: "task-a",
    });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("image");
  });

  it("falls back to auto-generated title when none is provided", () => {
    const block = { type: "image", source: { data: "aGVsbG8=", media_type: "image/png" } };
    const result = collectArtifactsFromMessages({
      messages: [makeMessage([block])],
      sessionKey: "agent:main:main",
    });
    expect(result[0].title).toMatch(/image 1/i);
  });

  it("collects image_url blocks as image type with url mode", () => {
    const result = collectArtifactsFromMessages({
      messages: [
        makeMessage([
          { type: "image_url", title: "remote.jpg", image_url: "https://example.com/img.jpg" },
        ]),
      ],
      sessionKey: "agent:main:main",
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "image", download: { mode: "url" } });
  });

  it("rejects data: URLs as remote download URLs", () => {
    const result = collectArtifactsFromMessages({
      messages: [
        makeMessage([
          { type: "file", title: "sneaky.txt", url: "data:text/plain;base64,aGVsbG8=" },
        ]),
      ],
      sessionKey: "agent:main:main",
    });
    expect(result[0].download.mode).not.toBe("url");
  });

  it("rejects protocol-relative // URLs as remote download URLs", () => {
    const result = collectArtifactsFromMessages({
      messages: [makeMessage([{ type: "file", title: "x.txt", url: "//evil.com/x.txt" }])],
      sessionKey: "agent:main:main",
    });
    expect(result[0].download.mode).not.toBe("url");
  });

  it("accepts /api/ relative URLs as remote download URLs", () => {
    const result = collectArtifactsFromMessages({
      messages: [makeMessage([{ type: "file", title: "x.txt", url: "/api/files/x.txt" }])],
      sessionKey: "agent:main:main",
    });
    expect(result[0].download.mode).toBe("url");
  });

  it("collects multiple blocks from a single message", () => {
    const result = collectArtifactsFromMessages({
      messages: [makeMessage([makeImageBlock(), makeFileBlock()])],
      sessionKey: "agent:main:main",
    });
    expect(result).toHaveLength(2);
  });

  it("propagates sizeBytes from explicit source.sizeBytes", () => {
    const block = {
      type: "file",
      title: "big.bin",
      source: { data: "aGVsbG8=", media_type: "application/octet-stream", sizeBytes: 9999 },
    };
    const result = collectArtifactsFromMessages({
      messages: [makeMessage([block])],
      sessionKey: "agent:main:main",
    });
    expect(result[0].sizeBytes).toBe(9999);
  });
});

/* ------------------------------------------------------------------ */
/* artifacts.list RPC handler                                          */
/* ------------------------------------------------------------------ */

describe("artifacts.list", () => {
  const list = artifactsHandlers["artifacts.list"];

  beforeEach(() => {
    loadSessionEntryMock.mockReset();
    readSessionMessagesMock.mockReset();
    getTaskSessionLookupByIdForStatusMock.mockReset();
    resolveSessionKeyForRunMock.mockReset();
  });

  it("returns error when no query params provided", () => {
    const { ok, error } = callHandler(list, {});
    expect(ok).toBe(false);
    expect((error as Record<string, unknown>).message).toMatch(/sessionKey|runId|taskId/i);
  });

  it("returns empty artifacts when sessionKey exists but session has no messages", () => {
    loadSessionEntryMock.mockReturnValue({ entry: null, storePath: null });
    const { ok, result } = callHandler(list, { sessionKey: "agent:main:missing" });
    expect(ok).toBe(true);
    expect((result as Record<string, unknown>).artifacts as unknown[]).toHaveLength(0);
  });

  it("returns artifacts and total for a valid sessionKey", () => {
    defaultSessionSetup();
    readSessionMessagesMock.mockReturnValue([makeMessage([makeImageBlock()])]);
    const { ok, result } = callHandler(list, { sessionKey: "agent:main:main" });
    expect(ok).toBe(true);
    const r = result as Record<string, unknown>;
    expect((r.artifacts as unknown[]).length).toBe(1);
    expect(r.total).toBe(1);
    expect(r.nextCursor).toBeUndefined();
  });

  it("applies types filter and returns only matching artifacts", () => {
    defaultSessionSetup();
    readSessionMessagesMock.mockReturnValue([makeMessage([makeImageBlock(), makeFileBlock()])]);
    const { result } = callHandler(list, { sessionKey: "agent:main:main", types: ["image"] });
    const r = result as Record<string, unknown>;
    expect((r.artifacts as unknown[]).length).toBe(1);
    expect(r.total).toBe(1);
  });

  it("types: [] matches nothing", () => {
    defaultSessionSetup();
    readSessionMessagesMock.mockReturnValue([makeMessage([makeImageBlock(), makeFileBlock()])]);
    const { result } = callHandler(list, { sessionKey: "agent:main:main", types: [] });
    const r = result as Record<string, unknown>;
    expect((r.artifacts as unknown[]).length).toBe(0);
    expect(r.total).toBe(0);
  });

  it("absent types field returns all artifacts without filtering", () => {
    defaultSessionSetup();
    readSessionMessagesMock.mockReturnValue([makeMessage([makeImageBlock(), makeFileBlock()])]);
    const { result } = callHandler(list, { sessionKey: "agent:main:main" });
    const r = result as Record<string, unknown>;
    expect((r.artifacts as unknown[]).length).toBe(2);
    expect(r.total).toBe(2);
  });

  it("paginates with limit and returns nextCursor when there are more", () => {
    defaultSessionSetup();
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: "assistant",
      content: [makeImageBlock({ title: `img${i + 1}.png` })],
      __openclaw: { seq: i + 1 },
    }));
    readSessionMessagesMock.mockReturnValue(messages);
    const { result } = callHandler(list, { sessionKey: "agent:main:main", limit: 3 });
    const r = result as Record<string, unknown>;
    expect((r.artifacts as unknown[]).length).toBe(3);
    expect(r.total).toBe(5);
    expect(r.nextCursor).toBeDefined();
  });

  it("second page uses cursor to continue without overlap", () => {
    defaultSessionSetup();
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: "assistant",
      content: [makeImageBlock({ title: `img${i + 1}.png` })],
      __openclaw: { seq: i + 1 },
    }));
    readSessionMessagesMock.mockReturnValue(messages);

    const { result: r1 } = callHandler(list, { sessionKey: "agent:main:main", limit: 3 });
    const page1 = r1 as Record<string, unknown>;
    const cursor = page1.nextCursor as string;

    readSessionMessagesMock.mockReturnValue(messages);
    const { result: r2 } = callHandler(list, { sessionKey: "agent:main:main", limit: 3, cursor });
    const page2 = r2 as Record<string, unknown>;
    expect((page2.artifacts as unknown[]).length).toBe(2);
    expect(page2.nextCursor).toBeUndefined();

    const ids1 = (page1.artifacts as Array<{ id: string }>).map((a) => a.id);
    const ids2 = (page2.artifacts as Array<{ id: string }>).map((a) => a.id);
    const ids2Set = new Set(ids2);
    expect(ids1.some((id) => ids2Set.has(id))).toBe(false);
  });

  it("defaults to limit 50", () => {
    defaultSessionSetup();
    readSessionMessagesMock.mockReturnValue(
      Array.from({ length: 100 }, (_, i) => ({
        role: "assistant",
        content: [makeImageBlock({ title: `img${i + 1}.png` })],
        __openclaw: { seq: i + 1 },
      })),
    );
    const { result } = callHandler(list, { sessionKey: "agent:main:main" });
    expect((result as Record<string, unknown>).artifacts as unknown[]).toHaveLength(50);
  });

  it("caps limit at 200 regardless of requested value", () => {
    defaultSessionSetup();
    readSessionMessagesMock.mockReturnValue(
      Array.from({ length: 300 }, (_, i) => ({
        role: "assistant",
        content: [makeImageBlock({ title: `img${i + 1}.png` })],
        __openclaw: { seq: i + 1 },
      })),
    );
    const { result } = callHandler(list, { sessionKey: "agent:main:main", limit: 9999 });
    expect((result as Record<string, unknown>).artifacts as unknown[]).toHaveLength(200);
  });

  it("resolves sessionKey from runId via resolveSessionKeyForRun", () => {
    resolveSessionKeyForRunMock.mockReturnValue("agent:main:main");
    defaultSessionSetup();
    readSessionMessagesMock.mockReturnValue([makeMessage([makeImageBlock()])]);
    const { ok } = callHandler(list, { runId: "run-xyz" });
    expect(resolveSessionKeyForRunMock).toHaveBeenCalledWith("run-xyz");
    expect(ok).toBe(true);
  });

  it("resolves sessionKey from taskId via getTaskSessionLookupByIdForStatus", () => {
    getTaskSessionLookupByIdForStatusMock.mockReturnValue({
      requesterSessionKey: "agent:main:main",
    });
    defaultSessionSetup();
    readSessionMessagesMock.mockReturnValue([makeMessage([makeImageBlock()])]);
    const { ok } = callHandler(list, { taskId: "task-abc" });
    expect(getTaskSessionLookupByIdForStatusMock).toHaveBeenCalledWith("task-abc");
    expect(ok).toBe(true);
  });

  it("returns error when runId cannot be resolved to a session", () => {
    resolveSessionKeyForRunMock.mockReturnValue(undefined);
    const { ok } = callHandler(list, { runId: "run-unknown" });
    expect(ok).toBe(false);
  });

  // P2 provenance regression guard (#74926): transcript writers do not persist runId in
  // __openclaw metadata, so artifacts must not be silently dropped when querying by runId.
  it("returns artifacts when querying by runId and messages lack __openclaw.runId", () => {
    resolveSessionKeyForRunMock.mockReturnValue("agent:main:main");
    defaultSessionSetup();
    // Messages intentionally have NO __openclaw.runId — matching real transcript output
    readSessionMessagesMock.mockReturnValue([
      { role: "assistant", content: [makeImageBlock()], __openclaw: { seq: 1 } },
    ]);
    const { ok, result } = callHandler(list, { runId: "run-real" });
    expect(ok).toBe(true);
    expect((result as Record<string, unknown>).artifacts as unknown[]).toHaveLength(1);
  });

  it("returns artifacts when querying by taskId and messages lack __openclaw.taskId", () => {
    getTaskSessionLookupByIdForStatusMock.mockReturnValue({
      requesterSessionKey: "agent:main:main",
    });
    defaultSessionSetup();
    readSessionMessagesMock.mockReturnValue([
      { role: "assistant", content: [makeFileBlock()], __openclaw: { seq: 1 } },
    ]);
    const { ok, result } = callHandler(list, { taskId: "task-real" });
    expect(ok).toBe(true);
    expect((result as Record<string, unknown>).artifacts as unknown[]).toHaveLength(1);
  });

  it("returns INVALID_REQUEST error for a malformed cursor value", () => {
    defaultSessionSetup();
    readSessionMessagesMock.mockReturnValue([makeMessage([makeImageBlock()])]);
    const { ok, error } = callHandler(list, {
      sessionKey: "agent:main:main",
      cursor: "!!! not a cursor !!!",
    });
    expect(ok).toBe(false);
    expect((error as Record<string, unknown>).message).toMatch(/cursor/i);
  });
});

/* ------------------------------------------------------------------ */
/* artifacts.get RPC handler                                           */
/* ------------------------------------------------------------------ */

describe("artifacts.get", () => {
  const get = artifactsHandlers["artifacts.get"];
  const list = artifactsHandlers["artifacts.list"];

  beforeEach(() => {
    loadSessionEntryMock.mockReset();
    readSessionMessagesMock.mockReset();
  });

  function getArtifactId(): string {
    const { result } = callHandler(list, { sessionKey: "agent:main:main" });
    return ((result as Record<string, unknown>).artifacts as Array<{ id: string }>)[0].id;
  }

  it("returns error when no query params provided", () => {
    const { ok } = callHandler(get, { artifactId: "artifact_abc" });
    expect(ok).toBe(false);
  });

  it("returns error when artifactId is not found", () => {
    defaultSessionSetup();
    readSessionMessagesMock.mockReturnValue([makeMessage([makeImageBlock()])]);
    const { ok, error } = callHandler(get, {
      sessionKey: "agent:main:main",
      artifactId: "artifact_nonexistent",
    });
    expect(ok).toBe(false);
    expect((error as Record<string, unknown>).message).toMatch(/not found/i);
  });

  it("returns artifact summary without raw data when found", () => {
    defaultSessionSetup();
    readSessionMessagesMock.mockReturnValue([makeMessage([makeImageBlock()])]);
    const artifactId = getArtifactId();

    readSessionMessagesMock.mockReturnValue([makeMessage([makeImageBlock()])]);
    const { ok, result } = callHandler(get, { sessionKey: "agent:main:main", artifactId });
    expect(ok).toBe(true);
    const artifact = (result as Record<string, unknown>).artifact as Record<string, unknown>;
    expect(artifact.id).toBe(artifactId);
    expect(artifact.data).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* artifacts.download RPC handler                                      */
/* ------------------------------------------------------------------ */

describe("artifacts.download", () => {
  const download = artifactsHandlers["artifacts.download"];
  const list = artifactsHandlers["artifacts.list"];

  beforeEach(() => {
    loadSessionEntryMock.mockReset();
    readSessionMessagesMock.mockReset();
  });

  function getArtifactId(): string {
    const { result } = callHandler(list, { sessionKey: "agent:main:main" });
    return ((result as Record<string, unknown>).artifacts as Array<{ id: string }>)[0].id;
  }

  it("returns base64 data for bytes-mode artifact", () => {
    defaultSessionSetup();
    readSessionMessagesMock.mockReturnValue([makeMessage([makeImageBlock()])]);
    const artifactId = getArtifactId();
    readSessionMessagesMock.mockReturnValue([makeMessage([makeImageBlock()])]);
    const { ok, result } = callHandler(download, { sessionKey: "agent:main:main", artifactId });
    expect(ok).toBe(true);
    const r = result as Record<string, unknown>;
    expect(r.encoding).toBe("base64");
    expect(r.data).toBe("aGVsbG8=");
    expect((r.artifact as Record<string, unknown>).data).toBeUndefined();
  });

  it("returns url for url-mode artifact", () => {
    defaultSessionSetup();
    readSessionMessagesMock.mockReturnValue([makeMessage([makeFileBlock()])]);
    const artifactId = getArtifactId();
    readSessionMessagesMock.mockReturnValue([makeMessage([makeFileBlock()])]);
    const { ok, result } = callHandler(download, { sessionKey: "agent:main:main", artifactId });
    expect(ok).toBe(true);
    const r = result as Record<string, unknown>;
    expect(r.url).toBe("https://example.com/report.pdf");
    expect(r.encoding).toBeUndefined();
  });

  it("returns error for unsupported-mode artifact", () => {
    defaultSessionSetup();
    readSessionMessagesMock.mockReturnValue([makeMessage([{ type: "file", title: "empty.txt" }])]);
    const artifactId = getArtifactId();
    readSessionMessagesMock.mockReturnValue([makeMessage([{ type: "file", title: "empty.txt" }])]);
    const { ok, error } = callHandler(download, { sessionKey: "agent:main:main", artifactId });
    expect(ok).toBe(false);
    expect((error as Record<string, unknown>).message).toMatch(/unsupported/i);
  });

  it("returns error when artifactId is not found", () => {
    defaultSessionSetup();
    readSessionMessagesMock.mockReturnValue([makeMessage([makeImageBlock()])]);
    const { ok } = callHandler(download, {
      sessionKey: "agent:main:main",
      artifactId: "artifact_missing",
    });
    expect(ok).toBe(false);
  });
});
