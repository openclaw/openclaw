import { beforeEach, describe, expect, it, vi } from "vitest";
import { artifactsHandlers, collectArtifactsFromMessages } from "./artifacts.js";

const hoisted = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  readSessionMessages: vi.fn(),
  resolveSessionKeyForRun: vi.fn(),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: hoisted.loadSessionEntry,
    readSessionMessages: hoisted.readSessionMessages,
  };
});

vi.mock("../server-session-key.js", async () => {
  const actual = await vi.importActual<typeof import("../server-session-key.js")>(
    "../server-session-key.js",
  );
  return {
    ...actual,
    resolveSessionKeyForRun: hoisted.resolveSessionKeyForRun,
  };
});

function createResponder() {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  return {
    calls,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      calls.push({ ok, payload, error });
    },
  };
}

describe("artifacts RPC handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.loadSessionEntry.mockReturnValue({
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-main", sessionFile: "/tmp/sess-main.jsonl" },
    });
    hoisted.readSessionMessages.mockReturnValue([
      {
        role: "assistant",
        content: [
          { type: "text", text: "see attached" },
          {
            type: "image",
            data: "aGVsbG8=",
            mimeType: "image/png",
            alt: "result.png",
          },
        ],
        __openclaw: { seq: 2 },
      },
    ]);
  });

  it("lists stable transcript artifact summaries by sessionKey", async () => {
    const { calls, respond } = createResponder();

    await artifactsHandlers["artifacts.list"]?.({
      req: { type: "req", id: "1", method: "artifacts.list", params: {} },
      params: { sessionKey: "agent:main:main" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.ok).toBe(true);
    const payload = calls[0]?.payload as { artifacts?: Array<Record<string, unknown>> };
    expect(payload.artifacts).toHaveLength(1);
    expect(payload.artifacts?.[0]).toMatchObject({
      type: "image",
      title: "result.png",
      mimeType: "image/png",
      sizeBytes: 5,
      sessionKey: "agent:main:main",
      messageSeq: 2,
      source: "session-transcript",
      download: { mode: "bytes" },
    });
    expect(payload.artifacts?.[0]?.id).toMatch(/^artifact_/);
    expect(payload.artifacts?.[0]).not.toHaveProperty("data");
  });

  it("gets and downloads an inline artifact", async () => {
    const listed = collectArtifactsFromMessages({
      sessionKey: "agent:main:main",
      messages: hoisted.readSessionMessages(),
    });
    const artifactId = listed[0]?.id;
    expect(artifactId).toBeTruthy();

    const get = createResponder();
    await artifactsHandlers["artifacts.get"]?.({
      req: { type: "req", id: "2", method: "artifacts.get", params: {} },
      params: { sessionKey: "agent:main:main", artifactId },
      client: null,
      isWebchatConnect: () => false,
      respond: get.respond,
      context: {} as never,
    });
    expect(get.calls[0]?.ok).toBe(true);
    expect(get.calls[0]?.payload).toMatchObject({
      artifact: { id: artifactId, download: { mode: "bytes" } },
    });

    const download = createResponder();
    await artifactsHandlers["artifacts.download"]?.({
      req: { type: "req", id: "3", method: "artifacts.download", params: {} },
      params: { sessionKey: "agent:main:main", artifactId },
      client: null,
      isWebchatConnect: () => false,
      respond: download.respond,
      context: {} as never,
    });
    expect(download.calls[0]?.ok).toBe(true);
    expect(download.calls[0]?.payload).toMatchObject({
      encoding: "base64",
      data: "aGVsbG8=",
      artifact: { id: artifactId },
    });
  });

  it("resolves runId queries through the gateway run-to-session lookup", async () => {
    hoisted.resolveSessionKeyForRun.mockReturnValue("agent:main:main");
    hoisted.readSessionMessages.mockReturnValue([
      {
        role: "assistant",
        content: [{ type: "image", data: "aGVsbG8=", alt: "run-result.png" }],
        __openclaw: { seq: 2, runId: "run-1" },
      },
    ]);
    const { calls, respond } = createResponder();

    await artifactsHandlers["artifacts.list"]?.({
      req: { type: "req", id: "4", method: "artifacts.list", params: {} },
      params: { runId: "run-1" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(calls[0]?.ok).toBe(true);
    expect(hoisted.resolveSessionKeyForRun).toHaveBeenCalledWith("run-1");
    const payload = calls[0]?.payload as { artifacts?: Array<Record<string, unknown>> };
    expect(payload.artifacts?.[0]).toMatchObject({ runId: "run-1" });
  });

  it("does not return untagged session artifacts for scoped runId queries", async () => {
    hoisted.resolveSessionKeyForRun.mockReturnValue("agent:main:main");
    const { calls, respond } = createResponder();

    await artifactsHandlers["artifacts.list"]?.({
      req: { type: "req", id: "run-scope", method: "artifacts.list", params: {} },
      params: { runId: "run-1" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(calls[0]?.ok).toBe(true);
    expect(calls[0]?.payload).toEqual({ artifacts: [] });
  });

  it("discovers transcript image_url data blocks", async () => {
    hoisted.readSessionMessages.mockReturnValue([
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "data:image/png;base64,aGVsbG8=",
            alt: "uploaded.png",
          },
        ],
        __openclaw: { seq: 3 },
      },
    ]);
    const { calls, respond } = createResponder();

    await artifactsHandlers["artifacts.list"]?.({
      req: { type: "req", id: "image-url", method: "artifacts.list", params: {} },
      params: { sessionKey: "agent:main:main" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(calls[0]?.ok).toBe(true);
    const payload = calls[0]?.payload as { artifacts?: Array<Record<string, unknown>> };
    expect(payload.artifacts).toHaveLength(1);
    expect(payload.artifacts?.[0]).toMatchObject({
      type: "image",
      title: "uploaded.png",
      mimeType: "image/png",
      sizeBytes: 5,
      download: { mode: "bytes" },
    });
  });

  it("treats unsafe artifact URLs as unsupported downloads", async () => {
    const artifacts = collectArtifactsFromMessages({
      sessionKey: "agent:main:main",
      messages: [
        {
          role: "assistant",
          content: [{ type: "file", title: "secret.txt", url: "file:///etc/passwd" }],
          __openclaw: { seq: 4 },
        },
      ],
    });

    expect(artifacts[0]).toMatchObject({
      title: "secret.txt",
      download: { mode: "unsupported" },
    });
    expect(artifacts[0]).not.toHaveProperty("url");
  });

  it("returns typed errors for missing query scope and missing artifacts", async () => {
    const missingScope = createResponder();
    await artifactsHandlers["artifacts.list"]?.({
      req: { type: "req", id: "5", method: "artifacts.list", params: {} },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond: missingScope.respond,
      context: {} as never,
    });
    expect(missingScope.calls[0]?.ok).toBe(false);
    expect(missingScope.calls[0]?.error).toMatchObject({
      details: { type: "artifact_query_unsupported" },
    });

    const notFound = createResponder();
    await artifactsHandlers["artifacts.get"]?.({
      req: { type: "req", id: "6", method: "artifacts.get", params: {} },
      params: { sessionKey: "agent:main:main", artifactId: "artifact_missing" },
      client: null,
      isWebchatConnect: () => false,
      respond: notFound.respond,
      context: {} as never,
    });
    expect(notFound.calls[0]?.ok).toBe(false);
    expect(notFound.calls[0]?.error).toMatchObject({
      details: { type: "artifact_not_found", artifactId: "artifact_missing" },
    });
  });
});
