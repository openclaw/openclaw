import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import * as attachmentFrameBudget from "../../shared/chat-attachment-frame-budget.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
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
  realSessionFacts: false,
  resolveManagedArtifactDownload: vi.fn(),
  resolveManagedUrlDownload: vi.fn(),
  visitSessionMessagesAsync: vi.fn(),
  resolveSessionForRun: vi.fn(),
}));

vi.mock("../session-sharing-preparation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-sharing-preparation.js")>();
  const { artifactFixtureSessionFacts } = await import("./artifacts.test-support.js");
  return {
    ...actual,
    prepareSessionMutationFacts: async (
      params: Parameters<typeof actual.prepareSessionMutationFacts>[0],
    ) =>
      hoisted.realSessionFacts
        ? actual.prepareSessionMutationFacts(params)
        : artifactFixtureSessionFacts(params),
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
    resolveSessionForRun: hoisted.resolveSessionForRun,
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
  options: { id?: string; context?: unknown; signal?: AbortSignal } = {},
) {
  const responder = createResponder();
  const defaultContext = {
    getRuntimeConfig: () => ({ agents: { entries: { main: {} } } }),
  };
  await artifactsHandlers[method]?.({
    req: { type: "req", id: options.id ?? method, method, params: {} },
    params,
    client: null,
    signal: options.signal,
    isWebchatConnect: () => false,
    respond: responder.respond,
    context: (options.context ?? defaultContext) as never,
  });
  return responder;
}

async function listArtifacts(
  params: Record<string, unknown>,
  options: { id?: string; context?: unknown; signal?: AbortSignal } = {},
) {
  return await invokeArtifactHandler("artifacts.list", params, options);
}

async function getArtifact(
  params: Record<string, unknown>,
  options: { id?: string; context?: unknown; signal?: AbortSignal } = {},
) {
  return await invokeArtifactHandler("artifacts.get", params, options);
}

async function downloadArtifact(
  params: Record<string, unknown>,
  options: { id?: string; context?: unknown; signal?: AbortSignal } = {},
) {
  return await invokeArtifactHandler("artifacts.download", params, options);
}

function mockedMessages(messages: unknown[]) {
  hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
    messages.forEach((message, index) => visit(message, index + 1));
    return messages.length;
  });
}

describe("artifacts RPC handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.realSessionFacts = false;
    hoisted.resolveSessionForRun.mockReset();
    hoisted.resolveManagedArtifactDownload.mockResolvedValue(null);
    hoisted.resolveManagedUrlDownload.mockResolvedValue(null);
    mockedMessages([resultImageMessage()]);
  });

  function mockArtifactBlock(seq: number, block: Record<string, unknown>, role = "assistant") {
    mockedMessages([{ role, content: [block], __openclaw: { seq } }]);
  }

  it("translates run lookup selection-required into INVALID_REQUEST", async () => {
    hoisted.resolveSessionForRun.mockImplementation(() => {
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
            entries: { ops: {}, research: {} },
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

  it.each([
    { type: "file", data: "not-base64!", title: "bad.txt" },
    { type: "file", data: "AA=A", title: "bad.txt" },
    { type: "file", data: "A", title: "bad.txt" },
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
    { data: " \t-_\r\n8=\n", expected: "+/8=", sizeBytes: 2 },
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

describe("managed artifact lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.realSessionFacts = false;
    hoisted.resolveManagedArtifactDownload.mockResolvedValue(null);
    hoisted.resolveManagedUrlDownload.mockResolvedValue(null);
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(
        {
          role: "assistant",
          content: [
            {
              type: "image",
              artifactId: "artifact_managed_image_11111111-1111-4111-8111-111111111111",
              url: "/api/chat/media/outgoing/agent%3Amain%3Amain/22222222-2222-4222-8222-222222222222/full",
            },
          ],
          __openclaw: { seq: 2 },
        },
        2,
      );
      return 1;
    });
  });

  it("rechecks managed download after a shared session becomes draft", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      hoisted.realSessionFacts = true;
      const owner = ensureProfileForEmail("artifact-owner@example.test");
      const viewer = ensureProfileForEmail("artifact-viewer@example.test");
      const sessionKey = "agent:main:artifact-visibility";
      const scope = { agentId: "main", sessionKey };
      const entry = {
        sessionId: "session-artifact-visibility",
        updatedAt: 1,
        createdActor: { type: "human" as const, source: "profile" as const, id: owner.id },
      };
      await upsertSessionEntryCore(scope, { ...entry, visibility: "shared" });
      const client = sharingPolicyClient({ user: viewer.id, scopes: ["operator.read"] });
      const artifactId = "artifact_managed_image_11111111-1111-4111-8111-111111111111";
      async function invoke() {
        const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
        await artifactsHandlers["artifacts.download"]?.({
          req: { type: "req", id: "artifacts.download", method: "artifacts.download", params: {} },
          params: { sessionKey, artifactId },
          client,
          isWebchatConnect: () => false,
          respond: (ok, payload, error) => calls.push({ ok, payload, error }),
          context: runtimeContext({}) as never,
        });
        return { calls };
      }
      const url = "/api/chat/media/outgoing/fixture/id/full?mediaTicket=fixture-ticket";
      hoisted.resolveManagedArtifactDownload.mockResolvedValue({
        artifactId,
        sessionKey,
        type: "image",
        title: "result.png",
        url,
        expiresAt: "2026-07-28T05:00:00.000Z",
      });
      const baseline = await invoke();
      expect(baseline.calls).toHaveLength(1);
      expectFields(expectOkPayload(baseline.calls), { url });
      await upsertSessionEntryCore(scope, { ...entry, updatedAt: 2, visibility: "draft" });
      vi.clearAllMocks();
      const denied = await invoke();
      expect(denied.calls).toEqual([
        {
          ok: false,
          payload: undefined,
          error: {
            code: "INVALID_REQUEST",
            message: "no session found for artifact query",
            details: { type: "artifact_scope_not_found" },
          },
        },
      ]);
      expect(hoisted.visitSessionMessagesAsync).not.toHaveBeenCalled();
      expect(hoisted.resolveManagedArtifactDownload).not.toHaveBeenCalled();
      expect(hoisted.resolveManagedUrlDownload).not.toHaveBeenCalled();
    });
  });

  it("does not retarget a stale managed artifact id through a different block URL", async () => {
    const artifactId = "artifact_managed_image_11111111-1111-4111-8111-111111111111";
    const calls: Array<{ ok: boolean; error?: unknown }> = [];

    await artifactsHandlers["artifacts.download"]?.({
      req: { type: "req", id: "download", method: "artifacts.download", params: {} },
      params: { sessionKey: "agent:main:main", artifactId },
      client: null,
      isWebchatConnect: () => false,
      respond: (ok, _payload, error) => calls.push({ ok, error }),
      context: { getRuntimeConfig: () => ({}) } as never,
    });

    expect(calls[0]?.ok).toBe(false);
    expectFields(expectErrorDetails(calls), { type: "artifact_not_found", artifactId });
    expect(hoisted.resolveManagedUrlDownload).not.toHaveBeenCalled();
    expect(hoisted.visitSessionMessagesAsync).not.toHaveBeenCalled();
  });

  it("lists managed attachment envelopes as file artifacts", async () => {
    hoisted.visitSessionMessagesAsync.mockImplementationOnce(async (_scope, visit) => {
      visit(
        {
          role: "assistant",
          content: [
            {
              type: "attachment",
              attachment: {
                artifactId: "artifact_managed_media_11111111-1111-4111-8111-111111111111",
                kind: "document",
                label: "report.csv",
                mimeType: "text/csv",
                sizeBytes: 12,
                url: "/api/chat/media/outgoing/agent%3Amain%3Amain/11111111-1111-4111-8111-111111111111/full",
              },
            },
          ],
          __openclaw: { seq: 2 },
        },
        2,
      );
      return 1;
    });
    const calls: Array<{ ok: boolean; payload?: unknown }> = [];

    await artifactsHandlers["artifacts.list"]?.({
      req: { type: "req", id: "list", method: "artifacts.list", params: {} },
      params: { sessionKey: "agent:main:main" },
      client: null,
      isWebchatConnect: () => false,
      respond: (ok, payload) => calls.push({ ok, payload }),
      context: { getRuntimeConfig: () => ({}) } as never,
    });

    expect(calls[0]).toMatchObject({
      ok: true,
      payload: {
        artifacts: [
          {
            id: "artifact_managed_media_11111111-1111-4111-8111-111111111111",
            type: "file",
            title: "report.csv",
            mimeType: "text/csv",
            sizeBytes: 12,
          },
        ],
      },
    });
  });
  it("keeps scoped managed downloads bound to their exact artifact id", async () => {
    const artifactId = "artifact_managed_media_11111111-1111-4111-8111-111111111111";
    const otherURL =
      "/api/chat/media/outgoing/agent%3Amain%3Amain/22222222-2222-4222-8222-222222222222/full";
    const query = {
      sessionKey: "agent:main:main",
      agentId: "main",
      artifactId,
      runId: "run-output",
      messageRole: "assistant",
    };
    for (const payload of [{ url: otherURL }, { data: "YWx0ZXJuYXRl" }, {}]) {
      mockedMessages([
        {
          role: "assistant",
          content: [{ type: "file", artifactId, title: "stale-name.txt", ...payload }],
          __openclaw: { seq: 3, runId: "run-output" },
        },
      ]);
      hoisted.resolveManagedArtifactDownload.mockResolvedValue(null);
      const missing = await downloadArtifact(query);
      expectFields(expectErrorDetails(missing.calls), { type: "artifact_not_found", artifactId });
      expect(hoisted.resolveManagedUrlDownload).not.toHaveBeenCalled();

      const url =
        "/api/chat/media/outgoing/agent%3Amain%3Amain/11111111-1111-4111-8111-111111111111/full?mediaTicket=fixture";
      hoisted.resolveManagedArtifactDownload.mockResolvedValue({
        artifactId,
        sessionKey: query.sessionKey,
        type: "file",
        title: "report.csv",
        mimeType: "text/csv",
        sizeBytes: 8,
        url,
        expiresAt: "2026-09-14T12:00:00.000Z",
      });
      const downloaded = await downloadArtifact(query);
      expectFields(expectOkPayload(downloaded.calls), {
        url,
        artifact: {
          id: artifactId,
          sessionKey: query.sessionKey,
          type: "file",
          title: "report.csv",
          mimeType: "text/csv",
          sizeBytes: 8,
          runId: "run-output",
          messageSeq: 3,
          source: "session-transcript",
          download: { mode: "url" },
        },
      });
      expect(hoisted.resolveManagedArtifactDownload).toHaveBeenLastCalledWith({
        sessionKey: query.sessionKey,
        agentId: "main",
        defaultAgentId: "main",
        artifactId,
      });
      expect(hoisted.resolveManagedUrlDownload).not.toHaveBeenCalled();
    }
  });

  it("requires filtered transcript membership before issuing a managed download ticket", async () => {
    const artifactId = "artifact_managed_media_11111111-1111-4111-8111-111111111111";
    mockedMessages([
      {
        role: "user",
        content: [{ type: "file", artifactId, data: "aW5wdXQ=" }],
        __openclaw: { seq: 1, runId: "run-output" },
      },
    ]);
    const { calls } = await downloadArtifact({
      sessionKey: "agent:main:main",
      artifactId,
      runId: "run-output",
      messageRole: "assistant",
    });
    expectFields(expectErrorDetails(calls), { type: "artifact_not_found", artifactId });
    expect(hoisted.resolveManagedArtifactDownload).not.toHaveBeenCalled();
    expect(hoisted.resolveManagedUrlDownload).not.toHaveBeenCalled();
  });
});

describe("artifact download lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.realSessionFacts = false;
    hoisted.resolveManagedUrlDownload.mockResolvedValue(null);
    hoisted.resolveManagedArtifactDownload.mockResolvedValue(null);
    mockedMessages([resultImageMessage()]);
  });
  it("bounds inline base64 downloads and directs oversized artifacts to HTTP", async () => {
    const budget = vi
      .spyOn(attachmentFrameBudget, "resolveChatAttachmentFrameBudgetBytes")
      .mockReturnValue(3);
    try {
      mockedMessages([
        assistantFileMessage({ title: "boundary.txt", data: "YQ==" }),
        assistantFileMessage({ title: "too-large.txt", data: "aGVsbG8=" }),
        resultImageMessage(),
      ]);
      const sessionKey = "agent:main:main";
      const artifacts = expectArtifactList((await listArtifacts({ sessionKey })).calls).artifacts!;
      const allowed = await downloadArtifact({ sessionKey, artifactId: artifacts[0]!.id });
      expectFields(expectOkPayload(allowed.calls), { encoding: "base64", data: "YQ==" });

      for (const artifact of artifacts.slice(1)) {
        const rejected = await downloadArtifact({ sessionKey, artifactId: artifact.id });
        expect(rejected.calls).toEqual([
          {
            ok: false,
            payload: undefined,
            error: expect.objectContaining({
              code: "INVALID_REQUEST",
              message: expect.stringContaining('transport: "http"'),
              details: {
                type: "artifact_download_unsupported",
                artifactId: artifact.id,
              },
            }),
          },
        ]);
      }
    } finally {
      budget.mockRestore();
    }
  });

  it("does not read sibling payloads when downloading an artifact", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "image",
            data: "Zmlyc3Q=",
            mimeType: "image/png",
            alt: "first.png",
          },
          {
            type: "image",
            data: "c2Vjb25k",
            mimeType: "image/png",
            alt: "second.png",
          },
        ],
        __openclaw: { seq: 2 },
      },
    ];
    mockedMessages(messages);

    const summaries = await listArtifacts({ sessionKey: "agent:main:main" });
    const summaryArtifacts = expectArtifactList(summaries.calls).artifacts;
    const secondArtifactId = requireNonEmptyString(
      summaryArtifacts?.[1]?.id,
      "expected second artifact id",
    );
    expect(summaryArtifacts?.[0]).not.toHaveProperty("data");
    expect(summaryArtifacts?.[1]).not.toHaveProperty("data");
    Object.defineProperty(messages[0]!.content[0]!, "data", {
      get: () => {
        throw new Error("download read an unrelated artifact payload");
      },
    });

    const download = await downloadArtifact({
      sessionKey: "agent:main:main",
      artifactId: secondArtifactId,
      // Internal callers without a live connection retain the inline fallback.
      transport: "http",
    });
    const downloadPayload = expectOkPayload(download.calls) as {
      artifact?: Record<string, unknown>;
      data?: string;
    };

    expect(downloadPayload.artifact).toEqual(summaryArtifacts?.[1]);
    expectFields(downloadPayload, { data: "c2Vjb25k" });
  });

  it("shares one scan for queued downloads while preserving inline, URL, and managed responses", async () => {
    const managedId = "artifact_managed_media_11111111-1111-4111-8111-111111111111";
    mockedMessages([
      {
        role: "assistant",
        content: [
          { type: "file", data: "Zmlyc3Q=" },
          { type: "file", source: { data: "c2Vjb25k", media_type: "text/plain" } },
          { type: "file", url: "https://example.test/result.txt" },
          { type: "file", artifactId: managedId, title: "managed.txt" },
        ],
        __openclaw: { seq: 2, runId: "run-output" },
      },
    ]);
    hoisted.resolveManagedArtifactDownload.mockResolvedValue({
      artifactId: managedId,
      sessionKey: "agent:main:main",
      type: "file",
      title: "managed.txt",
      url: "/api/chat/media/outgoing/synthetic/full?mediaTicket=fixture",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    const query = {
      sessionKey: "agent:main:main",
      runId: "run-output",
      messageRole: "assistant",
    };
    const summaries = expectArtifactList((await listArtifacts(query)).calls).artifacts!;
    const expected = [
      { artifact: summaries[0], encoding: "base64", data: "Zmlyc3Q=" },
      { artifact: summaries[1], encoding: "base64", data: "c2Vjb25k" },
      { artifact: summaries[2], url: "https://example.test/result.txt" },
      {
        artifact: { ...summaries[3], download: { mode: "url" } },
        url: "/api/chat/media/outgoing/synthetic/full?mediaTicket=fixture",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    ];
    hoisted.visitSessionMessagesAsync.mockClear();
    const results = await Promise.all(
      summaries.map((artifact) => downloadArtifact({ ...query, artifactId: artifact.id })),
    );
    expect(results.map((result) => expectOkPayload(result.calls))).toEqual(expected);
    expect(hoisted.visitSessionMessagesAsync).toHaveBeenCalledTimes(1);
    await downloadArtifact({ ...query, artifactId: summaries[0]!.id });
    expect(hoisted.visitSessionMessagesAsync).toHaveBeenCalledTimes(2);
  });

  it.each(["empty", "failed"])("releases a %s shared download scan", async (outcome) => {
    hoisted.visitSessionMessagesAsync.mockReset();
    if (outcome === "failed") {
      hoisted.visitSessionMessagesAsync.mockRejectedValue(new Error("transcript read failed"));
    } else {
      hoisted.visitSessionMessagesAsync.mockResolvedValue(0);
    }
    const query = { sessionKey: "agent:main:main", artifactId: "artifact_missing" };
    const results = await Promise.allSettled([downloadArtifact(query), downloadArtifact(query)]);
    expect(results.map((result) => result.status)).toEqual(
      outcome === "failed" ? ["rejected", "rejected"] : ["fulfilled", "fulfilled"],
    );
    expect(hoisted.visitSessionMessagesAsync).toHaveBeenCalledTimes(1);
    hoisted.visitSessionMessagesAsync.mockResolvedValue(0);
    expectFields(expectErrorDetails((await downloadArtifact(query)).calls), {
      type: "artifact_not_found",
    });
    expect(hoisted.visitSessionMessagesAsync).toHaveBeenCalledTimes(2);
  });

  it("keeps caller cancellation separate and never joins a scan after dispatch", async () => {
    const artifactId = expectFirstArtifact(
      (await listArtifacts({ sessionKey: "agent:main:main" })).calls,
    )?.id;
    const query = { sessionKey: "agent:main:main", artifactId };
    const entered = createDeferred();
    const release = createDeferred();
    hoisted.visitSessionMessagesAsync.mockClear();
    hoisted.visitSessionMessagesAsync.mockImplementationOnce(async (_scope, visit) => {
      visit(resultImageMessage(), 2);
      entered.resolve();
      await release.promise;
      return 1;
    });
    const controller = new AbortController();
    const results = Promise.allSettled([
      invokeArtifactHandler("artifacts.download", query, { signal: controller.signal }),
      downloadArtifact(query),
    ]);
    await entered.promise;
    try {
      controller.abort(new Error("caller cancelled"));
      const replacement = resultImageMessage();
      replacement.content[1]!.data = "bmV3";
      mockedMessages([replacement]);
      expectFields(expectOkPayload((await downloadArtifact(query)).calls), { data: "bmV3" });
      expect(hoisted.visitSessionMessagesAsync).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
    }
    const [cancelled, surviving] = await results;
    expect(cancelled).toMatchObject({ status: "rejected", reason: new Error("caller cancelled") });
    expect(surviving.status).toBe("fulfilled");
    if (surviving.status === "fulfilled") {
      expectFields(expectOkPayload(surviving.value.calls), { data: "aGVsbG8=" });
    }
  });

  it("does not share reads with a current-turn transcript fence", async () => {
    const query = { sessionKey: "agent:main:main", artifactId: "artifact_missing" };
    await runWithSessionTranscriptReadFence(
      {
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: query.sessionKey,
        storePath: "/tmp/sessions.json",
        generation: "synthetic",
        entryId: "entry",
        rawSeq: 1,
        effectiveParentId: null,
        activeMessagePosition: 0,
        logicalTurnId: "turn",
        role: "user",
      },
      () => Promise.all([downloadArtifact(query), downloadArtifact(query)]),
    );
    expect(hoisted.visitSessionMessagesAsync).toHaveBeenCalledTimes(2);
  });

  it.each([
    { runId: "other-run" },
    { messageRole: "assistant" },
    { sessionKey: "agent:main:other" },
  ])("keeps concurrent download query scopes separate: %j", async (filter) => {
    mockedMessages([{ ...assistantFileMessage({ title: "input.txt" }), role: "user" }]);
    const sessionKey = "agent:main:main";
    const artifactId = expectFirstArtifact((await listArtifacts({ sessionKey })).calls)?.id;
    hoisted.visitSessionMessagesAsync.mockClear();
    const [allowed, missing] = await Promise.all([
      downloadArtifact({ sessionKey, artifactId }),
      downloadArtifact({ sessionKey, artifactId, ...filter }),
    ]);
    expectFields(expectOkPayload(allowed.calls), { data: "aGVsbG8=" });
    expectFields(expectErrorDetails(missing.calls), { type: "artifact_not_found" });
    expect(hoisted.visitSessionMessagesAsync).toHaveBeenCalledTimes(2);
  });
});
