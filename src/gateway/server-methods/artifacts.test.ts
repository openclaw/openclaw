// Artifact method tests cover collection from transcript messages, run
// session lookup, list/get/download responses, and validation errors.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { artifactsHandlers } from "./artifacts.js";
import {
  assistantFileMessage,
  expectArtifactList,
  expectErrorDetails,
  expectFields,
  expectFirstArtifact,
  expectOkPayload,
  requireNonEmptyString,
  resultImageMessage,
  runtimeContext,
} from "./artifacts.test-support.js";

const hoisted = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  resolveManagedArtifactDownload: vi.fn(),
  resolveManagedUrlDownload: vi.fn(),
  visitSessionMessagesAsync: vi.fn(),
  resolveSessionKeyForRun: vi.fn(),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: hoisted.loadSessionEntry,
    loadGatewaySessionEntryReadOnly: hoisted.loadSessionEntry,
  };
});

vi.mock("../session-transcript-readers.js", async () => {
  const actual = await vi.importActual<typeof import("../session-transcript-readers.js")>(
    "../session-transcript-readers.js",
  );
  const { withArtifactFixtureReader } = await import("./artifacts.test-support.js");
  return withArtifactFixtureReader(actual, hoisted.visitSessionMessagesAsync);
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

vi.mock("../managed-image-attachments.js", async () => {
  const actual = await vi.importActual<typeof import("../managed-image-attachments.js")>(
    "../managed-image-attachments.js",
  );
  return {
    ...actual,
    resolveManagedOutgoingMediaArtifactDownload: hoisted.resolveManagedArtifactDownload,
    resolveManagedOutgoingMediaUrlDownload: hoisted.resolveManagedUrlDownload,
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

type ArtifactMethod = "artifacts.list" | "artifacts.get" | "artifacts.download";

async function invokeArtifactHandler(
  method: ArtifactMethod,
  params: Record<string, unknown>,
  options: { id?: string; context?: unknown } = {},
) {
  const responder = createResponder();
  const defaultContext = {
    getRuntimeConfig: () => ({ agents: { entries: { main: { default: true } } } }),
  };
  await artifactsHandlers[method]?.({
    req: { type: "req", id: options.id ?? method, method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: responder.respond,
    context: (options.context ?? defaultContext) as never,
  });
  return responder;
}

async function listArtifacts(
  params: Record<string, unknown>,
  options: { id?: string; context?: unknown } = {},
) {
  return await invokeArtifactHandler("artifacts.list", params, options);
}

async function getArtifact(
  params: Record<string, unknown>,
  options: { id?: string; context?: unknown } = {},
) {
  return await invokeArtifactHandler("artifacts.get", params, options);
}

async function downloadArtifact(
  params: Record<string, unknown>,
  options: { id?: string; context?: unknown } = {},
) {
  return await invokeArtifactHandler("artifacts.download", params, options);
}

describe("artifacts RPC handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.resolveSessionKeyForRun.mockReset();
    hoisted.resolveManagedArtifactDownload.mockResolvedValue(null);
    hoisted.resolveManagedUrlDownload.mockResolvedValue(null);
    hoisted.loadSessionEntry.mockReturnValue({
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-main", sessionFile: "/tmp/sess-main.jsonl" },
    });
    mockedMessages([resultImageMessage()]);
  });

  function mockedMessages(messages: unknown[]) {
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      messages.forEach((message, index) => visit(message, index + 1));
      return messages.length;
    });
  }

  function mockArtifactBlock(seq: number, block: Record<string, unknown>, role = "assistant") {
    mockedMessages([{ role, content: [block], __openclaw: { seq } }]);
  }

  it("lists stable transcript artifact summaries by sessionKey", async () => {
    const { calls } = await listArtifacts({ sessionKey: "agent:main:main" }, { id: "1" });

    expect(calls).toHaveLength(1);
    const payload = expectArtifactList(calls);
    expect(payload.artifacts).toHaveLength(1);
    const artifact = payload.artifacts?.[0];
    expectFields(artifact, {
      type: "image",
      title: "result.png",
      mimeType: "image/png",
      sizeBytes: 5,
      sessionKey: "agent:main:main",
      messageSeq: 2,
      source: "session-transcript",
    });
    expectFields(artifact?.download, { mode: "bytes" });
    expect(artifact?.id).toMatch(/^artifact_/);
    expect(artifact).not.toHaveProperty("data");
    expect(hoisted.visitSessionMessagesAsync).toHaveBeenCalledWith(
      {
        agentId: "main",
        sessionEntry: {
          sessionFile: "/tmp/sess-main.jsonl",
          sessionId: "sess-main",
        },
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath: "/tmp/sessions.json",
      },
      expect.any(Function),
    );
  });

  it("canonicalizes scoped sessionKey aliases with runtime config", async () => {
    const { calls } = await listArtifacts(
      { sessionKey: "main", agentId: "work" },
      {
        id: "session-alias-main-key",
        context: runtimeContext({
          session: { mainKey: "primary" },
          agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        }),
      },
    );

    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("agent:work:primary");
    expectFields(expectFirstArtifact(calls), { sessionKey: "agent:work:primary" });
  });

  it("loads a bare artifact session through the persisted fixed-store owner", async () => {
    const { calls } = await listArtifacts(
      { sessionKey: "global" },
      {
        id: "session-persisted-owner",
        context: runtimeContext({
          session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
          agents: {
            ownership: "explicit",
            list: [{ id: "ops" }, { id: "research" }],
            defaults: { sessionStore: { agentId: "ops" } },
          },
        }),
      },
    );

    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("global", { agentId: "ops" });
    expectFields(expectFirstArtifact(calls), { sessionKey: "global" });
  });

  it("preserves agent scope when loading global-scope run artifacts", async () => {
    hoisted.resolveSessionKeyForRun.mockReturnValue("global");
    mockedMessages([assistantFileMessage({ title: "out.txt", runId: "run-global" })]);

    const { calls } = await listArtifacts(
      { runId: "run-global", agentId: "work" },
      {
        id: "global-run-agent-scope",
        context: runtimeContext({
          session: { scope: "global" },
          agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        }),
      },
    );

    expect(hoisted.resolveSessionKeyForRun).toHaveBeenCalledWith("run-global", {
      agentId: "work",
    });
    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("global", { agentId: "work" });
    expectFields(expectFirstArtifact(calls), { sessionKey: "global", runId: "run-global" });
  });

  it("uses the run row owner before default selection", async () => {
    hoisted.resolveSessionKeyForRun.mockReturnValue("agent:research:main");
    mockedMessages([assistantFileMessage({ title: "out.txt", runId: "run-owned" })]);

    const { calls } = await listArtifacts(
      { runId: "run-owned" },
      {
        context: runtimeContext({
          agents: {
            ownership: "explicit",
            list: [{ id: "ops" }, { id: "research" }],
          },
        }),
      },
    );

    expect(hoisted.resolveSessionKeyForRun).toHaveBeenCalledWith("run-owned", {});
    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("agent:research:main");
    expect(calls[0]?.ok).toBe(true);
  });

  it("translates run lookup selection-required into INVALID_REQUEST", async () => {
    hoisted.resolveSessionKeyForRun.mockImplementation(() => {
      throw new AgentSelectionRequiredError(["ops", "research"], {
        surface: "artifact run",
        hint: "Pass agentId to select a configured agent.",
      });
    });

    const { calls } = await listArtifacts(
      { runId: "run-ambiguous" },
      {
        context: runtimeContext({
          agents: {
            ownership: "explicit",
            list: [{ id: "ops" }, { id: "research" }],
          },
        }),
      },
    );

    expect(calls[0]).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("agent") },
    });
  });

  it.each([
    { type: "file", data: "", sizeBytes: 0, title: "direct.bin" },
    {
      type: "file",
      source: { data: "", media_type: "application/octet-stream", sizeBytes: 0 },
      title: "source.bin",
    },
    {
      type: "file",
      data: " data:application/octet-stream;base64, ",
      sizeBytes: 0,
      title: "data-url.bin",
    },
    { data: "", sizeBytes: 0, title: "untyped.bin" },
  ])("lists, gets, and downloads the zero-byte $title artifact", async (block) => {
    mockedMessages([{ role: "assistant", content: [block], __openclaw: { seq: 2 } }]);
    const artifact = expectFirstArtifact(
      (await listArtifacts({ sessionKey: "agent:main:main" })).calls,
    );
    const artifactId = requireNonEmptyString(artifact?.id, "expected zero-byte artifact id");
    const expected = { id: artifactId, sizeBytes: 0, download: { mode: "bytes" } };
    expect(artifact).toMatchObject(expected);
    expect(artifact).not.toHaveProperty("data");
    const get = await getArtifact({ sessionKey: "agent:main:main", artifactId });
    const getPayload = expectOkPayload(get.calls) as { artifact?: Record<string, unknown> };
    expect(getPayload.artifact).toMatchObject(expected);
    expect(getPayload.artifact).not.toHaveProperty("data");
    const download = await downloadArtifact({ sessionKey: "agent:main:main", artifactId });
    const payload = expectOkPayload(download.calls) as { artifact?: Record<string, unknown> };
    expectFields(payload, { encoding: "base64", data: "" });
    expect(payload.artifact).toMatchObject(expected);
  });
  it("does not discover untyped non-string data as an artifact", async () => {
    mockArtifactBlock(2, { data: {} });
    const listed = await listArtifacts({ sessionKey: "agent:main:main" });
    expect(expectArtifactList(listed.calls)).toEqual({ artifacts: [] });
  });

  it("preserves managed artifact identity and returns a ticketed download URL", async () => {
    const artifactId = "artifact_managed_image_11111111-1111-4111-8111-111111111111";
    mockArtifactBlock(2, {
      type: "image",
      artifactId,
      url: "/api/chat/media/outgoing/agent%3Amain%3Amain/11111111-1111-4111-8111-111111111111/full",
      alt: "chart.png",
      mimeType: "image/png",
      sizeBytes: 14,
    });
    hoisted.resolveManagedArtifactDownload.mockResolvedValue({
      artifactId,
      sessionKey: "agent:main:main",
      type: "image",
      title: "chart.png",
      mimeType: "image/png",
      sizeBytes: 14,
      url: "/api/chat/media/outgoing/agent%3Amain%3Amain/id/full?mediaTicket=ticket",
      expiresAt: "2026-07-28T05:00:00.000Z",
    });

    const listed = await listArtifacts({ sessionKey: "agent:main:main" });
    expectFields(expectFirstArtifact(listed.calls), { id: artifactId, sizeBytes: 14 });

    const downloaded = await downloadArtifact({ sessionKey: "agent:main:main", artifactId });
    expectFields(expectOkPayload(downloaded.calls), {
      url: "/api/chat/media/outgoing/agent%3Amain%3Amain/id/full?mediaTicket=ticket",
      expiresAt: "2026-07-28T05:00:00.000Z",
    });
    expect(hoisted.resolveManagedArtifactDownload).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      agentId: "main",
      defaultAgentId: "main",
      artifactId,
    });
  });

  it("downloads inline audio artifacts as bytes", async () => {
    const { type, mimeType, data } = { type: "audio", mimeType: "audio/mpeg", data: "YXVkaW8=" };
    mockedMessages([
      {
        role: "assistant",
        content: [{ type, data, mimeType, fileName: `result.${type}` }],
        __openclaw: { seq: 2 },
      },
    ]);
    const listed = await listArtifacts({ sessionKey: "agent:main:main" });
    const artifact = expectFirstArtifact(listed.calls);
    const artifactId = requireNonEmptyString(artifact?.id, "expected media artifact id");

    const downloaded = await downloadArtifact({
      sessionKey: "agent:main:main",
      artifactId,
    });

    expectFields(artifact, { type, mimeType });
    expectFields(artifact?.download, { mode: "bytes" });
    expectFields(expectOkPayload(downloaded.calls), {
      encoding: "base64",
      data,
    });
  });

  it("returns ticketed URLs for managed video artifacts", async () => {
    const { type, mimeType, fileName } = {
      type: "video",
      mimeType: "video/mp4",
      fileName: "clip.mp4",
    };
    const attachmentId = "22222222-2222-4222-8222-222222222222";
    const artifactId = `artifact_managed_media_${attachmentId}`;
    const url = `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`;
    mockedMessages([
      {
        role: "assistant",
        openclawDisplayContent: [{ type, artifactId, url, openUrl: url, fileName, mimeType }],
        __openclaw: { seq: 2 },
      },
    ]);
    hoisted.resolveManagedArtifactDownload.mockResolvedValue({
      artifactId,
      sessionKey: "agent:main:main",
      type,
      title: fileName,
      mimeType,
      sizeBytes: 10,
      url: `${url}?mediaTicket=ticket`,
      expiresAt: "2026-07-28T05:00:00.000Z",
    });

    const listed = await listArtifacts({ sessionKey: "agent:main:main" });
    const downloaded = await downloadArtifact({ sessionKey: "agent:main:main", artifactId });

    expectFields(expectFirstArtifact(listed.calls), { id: artifactId, type, mimeType });
    expectFields(expectOkPayload(downloaded.calls), {
      url: `${url}?mediaTicket=ticket`,
      expiresAt: "2026-07-28T05:00:00.000Z",
    });
  });

  it("does not return untagged session artifacts for scoped runId queries", async () => {
    hoisted.resolveSessionKeyForRun.mockReturnValue("agent:main:main");
    const { calls } = await listArtifacts({ runId: "run-1" }, { id: "run-scope" });

    expect(expectArtifactList(calls)).toEqual({ artifacts: [] });
  });

  it("discovers transcript image_url data blocks", async () => {
    mockArtifactBlock(
      3,
      {
        type: "input_image",
        image_url: "data:image/png;base64,aGVsbG8=",
        alt: "uploaded.png",
      },
      "user",
    );
    const { calls } = await listArtifacts({ sessionKey: "agent:main:main" }, { id: "image-url" });

    const payload = expectArtifactList(calls);
    expect(payload.artifacts).toHaveLength(1);
    const artifact = payload.artifacts?.[0];
    expectFields(artifact, {
      type: "image",
      title: "uploaded.png",
      mimeType: "image/png",
      sizeBytes: 5,
    });
    expectFields(artifact?.download, { mode: "bytes" });
  });

  it("treats transcript non-base64 data URLs as unsupported downloads", async () => {
    mockArtifactBlock(
      4,
      {
        type: "input_image",
        image_url: "data:text/plain,hello",
        alt: "uploaded.txt",
      },
      "user",
    );

    const { calls } = await listArtifacts({ sessionKey: "agent:main:main" });
    const artifacts = expectArtifactList(calls).artifacts;
    expect(artifacts).toHaveLength(1);
    expectFields(artifacts?.[0], {
      type: "image",
      title: "uploaded.txt",
    });
    expectFields(artifacts?.[0]?.download, { mode: "unsupported" });
    expect(artifacts?.[0]?.download).not.toHaveProperty("encoding", "base64");
  });

  it("treats non-base64 data URLs in the content field as unsupported downloads", async () => {
    mockArtifactBlock(5, {
      type: "file",
      content: "data:text/plain,hello",
      title: "plain.txt",
    });

    const { calls } = await listArtifacts({ sessionKey: "agent:main:main" });
    const artifacts = expectArtifactList(calls).artifacts;
    expect(artifacts).toHaveLength(1);
    expectFields(artifacts?.[0], {
      title: "plain.txt",
    });
    expectFields(artifacts?.[0]?.download, { mode: "unsupported" });
    expect(artifacts?.[0]).not.toHaveProperty("data");
  });

  it.each([
    { type: "file", data: "not-base64!", title: "bad.txt" },
    { type: "file", data: "AA=A", title: "bad.txt" },
    { type: "file", data: "A===", title: "bad.txt" },
    { type: "file", data: "A", title: "bad.txt" },
    { type: "file", data: "AA\vAA", title: "bad.txt" },
    { type: "file", data: "AA\u2028AA", title: "bad.txt" },
    { type: "image", image_url: "data:image/png;base64,not-base64!", alt: "bad.txt" },
  ])("treats malformed artifact data as unsupported downloads: %j", async (block) => {
    mockedMessages([
      {
        role: "assistant",
        content: [block],
        __openclaw: { seq: 6 },
      },
    ]);

    const { calls } = await listArtifacts({ sessionKey: "agent:main:main" });
    const artifacts = expectArtifactList(calls).artifacts;
    expect(artifacts).toHaveLength(1);
    expectFields(artifacts?.[0], {
      title: "bad.txt",
    });
    expectFields(artifacts?.[0]?.download, { mode: "unsupported" });
    expect(artifacts?.[0]).not.toHaveProperty("data");
  });

  it.each([
    { data: "JVBERi0", expected: "JVBERi0=", sizeBytes: 5 },
    { data: "-_8", expected: "+/8=", sizeBytes: 2 },
    { data: " \t-_\r\n8=\n", expected: "+/8=", sizeBytes: 2 },
    { data: "Zh", expected: "Zh==", sizeBytes: 1 },
  ])("normalizes downloadable artifact base64: %j", async ({ data, expected, sizeBytes }) => {
    mockedMessages([
      {
        role: "assistant",
        content: [
          {
            type: "file",
            data,
            title: "report.pdf",
          },
        ],
        __openclaw: { seq: 7 },
      },
    ]);

    const listed = await listArtifacts({ sessionKey: "agent:main:main" });
    const artifact = expectArtifactList(listed.calls).artifacts?.[0];
    const artifactId = requireNonEmptyString(artifact?.id, "expected listed artifact id");
    expectFields(artifact, {
      title: "report.pdf",
      sizeBytes,
    });
    expectFields(artifact?.download, { mode: "bytes" });

    const download = await downloadArtifact({
      sessionKey: "agent:main:main",
      artifactId,
    });
    const downloadPayload = expectOkPayload(download.calls) as Record<string, unknown>;
    expectFields(downloadPayload, {
      encoding: "base64",
      data: expected,
    });
  });

  it("keeps unpadded base64 data URLs downloadable", async () => {
    mockArtifactBlock(8, {
      type: "image",
      image_url: "data:image/gif;base64,R0lGOD",
      alt: "tiny.gif",
    });

    const listed = await listArtifacts({ sessionKey: "agent:main:main" });
    const artifact = expectArtifactList(listed.calls).artifacts?.[0];
    const artifactId = requireNonEmptyString(artifact?.id, "expected listed artifact id");
    expectFields(artifact, {
      title: "tiny.gif",
      mimeType: "image/gif",
      sizeBytes: 4,
    });
    expectFields(artifact?.download, { mode: "bytes" });

    const download = await downloadArtifact({
      sessionKey: "agent:main:main",
      artifactId,
    });
    const downloadPayload = expectOkPayload(download.calls) as Record<string, unknown>;
    expectFields(downloadPayload, {
      encoding: "base64",
      data: "R0lGOD==",
    });
  });

  it("treats unsafe artifact URLs as unsupported downloads", async () => {
    mockedMessages([
      {
        role: "assistant",
        content: [{ type: "file", title: "secret.txt", url: "file:///etc/passwd" }],
        __openclaw: { seq: 4 },
      },
    ]);

    const { calls } = await listArtifacts({ sessionKey: "agent:main:main" });
    const artifacts = expectArtifactList(calls).artifacts;
    expectFields(artifacts?.[0], {
      title: "secret.txt",
    });
    expectFields(artifacts?.[0]?.download, { mode: "unsupported" });
    expect(artifacts?.[0]).not.toHaveProperty("url");
  });

  it("returns typed errors for missing query scope and missing artifacts", async () => {
    const missingScope = await listArtifacts({}, { id: "5" });
    expectFields(expectErrorDetails(missingScope.calls), { type: "artifact_query_unsupported" });

    const notFound = await getArtifact(
      { sessionKey: "agent:main:main", artifactId: "artifact_missing" },
      { id: "6" },
    );
    expectFields(expectErrorDetails(notFound.calls), {
      type: "artifact_not_found",
      artifactId: "artifact_missing",
    });
  });
});
