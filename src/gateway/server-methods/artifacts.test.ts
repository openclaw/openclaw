import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
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
  expectOkPayload,
  invokeArtifact,
  requireNonEmptyString,
  resultImageMessage,
  runtimeContext,
} from "./artifacts.test-support.js";
import { createSessionFileDownloadClient } from "./sessions-files.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

afterEach(() => clearRuntimeConfigSnapshot());

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

vi.mock("../session-transcript-readers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-transcript-readers.js")>();
  const { withArtifactFixtureReader } = await import("./artifacts.test-support.js");
  return withArtifactFixtureReader(actual, hoisted.visitSessionMessagesAsync);
});

vi.mock("../server-session-key.js", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("../server-session-key.js")>()),
    resolveSessionForRun: hoisted.resolveSessionForRun,
  };
});

vi.mock("../managed-image-attachments.js", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("../managed-image-attachments.js")>()),
    resolveManagedOutgoingMediaArtifactDownload: hoisted.resolveManagedArtifactDownload,
    resolveManagedOutgoingMediaUrlDownload: hoisted.resolveManagedUrlDownload,
  };
});

const artifactConfig = { agents: { entries: { main: {} } } };
const defaultSessionKey = "agent:main:main";

type ArtifactMethod = "artifacts.list" | "artifacts.get" | "artifacts.download";
type ArtifactHandlerOptions = {
  id?: string;
  context?: unknown;
  signal?: AbortSignal;
  client?: GatewayClient;
};

async function invokeArtifactHandler(
  method: ArtifactMethod,
  params: Record<string, unknown>,
  options: ArtifactHandlerOptions = {},
) {
  const respond = await invokeArtifact(method, params, {
    ...options,
    dispatch: artifactsHandlers[method]!,
    client: options.client ?? null,
    context: (options.context ?? {
      getRuntimeConfig: () => artifactConfig,
    }) as GatewayRequestContext,
  });
  return { calls: respond.mock.calls.map(([ok, payload, error]) => ({ ok, payload, error })) };
}

const listArtifacts = async (
  params: Record<string, unknown> = { sessionKey: defaultSessionKey },
  options?: ArtifactHandlerOptions,
) => expectArtifactList((await invokeArtifactHandler("artifacts.list", params, options)).calls);
const getArtifact = (params: Record<string, unknown>, options?: ArtifactHandlerOptions) =>
  invokeArtifactHandler("artifacts.get", params, options);
const downloadArtifact = (params: Record<string, unknown>, options?: ArtifactHandlerOptions) =>
  invokeArtifactHandler(
    "artifacts.download",
    { sessionKey: defaultSessionKey, ...params },
    options,
  );

function mockedMessages(messages: unknown[]) {
  hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
    messages.forEach((message, index) => visit(message, index + 1));
    return messages.length;
  });
}

function mockArtifactBlocks<Block>(content: Block[], seq = 2, role = "assistant", runId?: string) {
  const message = { role, content, __openclaw: { seq, ...(runId ? { runId } : {}) } };
  mockedMessages([message]);
  return message;
}

function mockArtifactBlock(
  seq: number,
  block: Record<string, unknown>,
  role = "assistant",
  runId?: string,
) {
  return mockArtifactBlocks([block], seq, role, runId);
}

beforeEach(() => {
  vi.clearAllMocks();
  setRuntimeConfigSnapshot(artifactConfig);
  hoisted.realSessionFacts = false;
  hoisted.resolveSessionForRun.mockReset();
  hoisted.resolveManagedArtifactDownload.mockResolvedValue(null);
  hoisted.resolveManagedUrlDownload.mockResolvedValue(null);
  mockedMessages([resultImageMessage()]);
});

it("translates run lookup selection-required into INVALID_REQUEST", async () => {
  hoisted.resolveSessionForRun.mockImplementation(() => {
    throw new AgentSelectionRequiredError(["ops", "research"], {
      surface: "artifact run",
      hint: "Pass agentId to select a configured agent.",
    });
  });

  const { calls } = await invokeArtifactHandler(
    "artifacts.list",
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
  mockArtifactBlock(2, block);
  const artifact = (await listArtifacts()).artifacts?.[0];
  const artifactId = requireNonEmptyString(artifact?.id, "expected zero-byte artifact id");
  const expected = { id: artifactId, sizeBytes: 0, download: { mode: "bytes" } };
  expect(artifact).toMatchObject(expected);
  expect(artifact).not.toHaveProperty("data");
  const get = await getArtifact({ sessionKey: "agent:main:main", artifactId });
  const getPayload = expectOkPayload(get.calls) as { artifact?: Record<string, unknown> };
  expect(getPayload.artifact).toMatchObject(expected);
  expect(getPayload.artifact).not.toHaveProperty("data");
  const download = await downloadArtifact({ artifactId });
  const payload = expectOkPayload(download.calls) as { artifact?: Record<string, unknown> };
  expectFields(payload, { encoding: "base64", data: "" });
  expect(payload.artifact).toMatchObject(expected);
});
it("does not discover untyped non-string data as an artifact", async () => {
  mockArtifactBlock(2, { data: {} });
  expect(await listArtifacts()).toEqual({ artifacts: [] });
});

it("treats transcript non-base64 data URLs as unsupported downloads", async () => {
  mockArtifactBlock(
    4,
    { type: "input_image", image_url: "data:text/plain,hello", alt: "uploaded.txt" },
    "user",
  );

  const artifacts = (await listArtifacts()).artifacts;
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
  mockArtifactBlock(6, block);

  const artifacts = (await listArtifacts()).artifacts;
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
  mockArtifactBlock(7, { type: "file", data, title: "report.pdf" });

  const artifact = (await listArtifacts()).artifacts?.[0];
  const artifactId = requireNonEmptyString(artifact?.id, "expected listed artifact id");
  expectFields(artifact, { title: "report.pdf", sizeBytes, download: { mode: "bytes" } });

  const download = await downloadArtifact({ artifactId });
  const downloadPayload = expectOkPayload(download.calls) as Record<string, unknown>;
  expectFields(downloadPayload, { encoding: "base64", data: expected });
});

it("treats unsafe artifact URLs as unsupported downloads", async () => {
  mockArtifactBlock(4, { type: "file", title: "secret.txt", url: "file:///etc/passwd" });

  const artifacts = (await listArtifacts()).artifacts;
  expectFields(artifacts?.[0], {
    title: "secret.txt",
  });
  expectFields(artifacts?.[0]?.download, { mode: "unsupported" });
  expect(artifacts?.[0]).not.toHaveProperty("url");
});

it("returns typed errors for missing query scope and missing artifacts", async () => {
  const missingScope = await invokeArtifactHandler("artifacts.list", {}, { id: "5" });
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
function mockManagedImage() {
  mockArtifactBlock(2, {
    type: "image",
    artifactId: "artifact_managed_image_11111111-1111-4111-8111-111111111111",
    url: "/api/chat/media/outgoing/agent%3Amain%3Amain/22222222-2222-4222-8222-222222222222/full",
  });
}

it("rechecks managed download after a shared session becomes draft", async () => {
  mockManagedImage();
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    setRuntimeConfigSnapshot({});
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
    using connection = createSessionFileDownloadClient();
    const client = {
      ...sharingPolicyClient({ user: viewer.id, scopes: ["operator.read"] }),
      connId: connection.client.connId,
      connectionSignal: connection.client.connectionSignal,
    };
    const artifactId = "artifact_managed_image_11111111-1111-4111-8111-111111111111";
    const invoke = () =>
      downloadArtifact({ sessionKey, artifactId }, { client, context: runtimeContext({}) });
    const url = "/api/chat/media/outgoing/fixture/id/full";
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
    expectFields(expectOkPayload(baseline.calls), {
      url: expect.stringContaining(`${url}?mediaTicket=`),
    });
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
  mockManagedImage();
  const artifactId = "artifact_managed_image_11111111-1111-4111-8111-111111111111";
  const { calls } = await downloadArtifact(
    { sessionKey: defaultSessionKey, artifactId },
    { context: runtimeContext({}) },
  );

  expect(calls[0]?.ok).toBe(false);
  expectFields(expectErrorDetails(calls), { type: "artifact_not_found", artifactId });
  expect(hoisted.resolveManagedUrlDownload).not.toHaveBeenCalled();
  expect(hoisted.visitSessionMessagesAsync).not.toHaveBeenCalled();
});

it("lists managed attachment envelopes as file artifacts", async () => {
  mockManagedImage();
  const block = {
    type: "attachment",
    attachment: {
      artifactId: "artifact_managed_media_11111111-1111-4111-8111-111111111111",
      kind: "document",
      label: "report.csv",
      mimeType: "text/csv",
      sizeBytes: 12,
      url: "/api/chat/media/outgoing/agent%3Amain%3Amain/11111111-1111-4111-8111-111111111111/full",
    },
  };
  hoisted.visitSessionMessagesAsync.mockImplementationOnce(async (_scope, visit) => {
    visit({ role: "assistant", content: [block], __openclaw: { seq: 2 } }, 2);
    return 1;
  });
  const listed = await listArtifacts(
    { sessionKey: defaultSessionKey },
    { context: runtimeContext({}) },
  );

  expect(listed).toMatchObject({
    artifacts: [
      {
        id: "artifact_managed_media_11111111-1111-4111-8111-111111111111",
        type: "file",
        title: "report.csv",
        mimeType: "text/csv",
        sizeBytes: 12,
      },
    ],
  });
});
it.each([undefined, 480])(
  "keeps scoped managed downloads bound to their exact artifact id (preview %s)",
  async (previewWidth) => {
    mockManagedImage();
    using connection = createSessionFileDownloadClient();
    const artifactId = "artifact_managed_media_11111111-1111-4111-8111-111111111111";
    const otherURL =
      "/api/chat/media/outgoing/agent%3Amain%3Amain/22222222-2222-4222-8222-222222222222/full";
    const query = {
      sessionKey: "agent:main:main",
      agentId: "main",
      artifactId,
      runId: "run-output",
      messageRole: "assistant",
      ...(previewWidth === undefined ? {} : { previewWidth }),
    };
    for (const payload of [{ url: otherURL }, { data: "YWx0ZXJuYXRl" }, {}]) {
      mockArtifactBlock(
        3,
        { type: "file", artifactId, title: "stale-name.txt", ...payload },
        "assistant",
        "run-output",
      );
      hoisted.resolveManagedArtifactDownload.mockResolvedValue(null);
      const missing = await downloadArtifact(query, { client: connection.client });
      expectFields(expectErrorDetails(missing.calls), { type: "artifact_not_found", artifactId });
      expect(hoisted.resolveManagedUrlDownload).not.toHaveBeenCalled();

      const url =
        "/api/chat/media/outgoing/agent%3Amain%3Amain/11111111-1111-4111-8111-111111111111/full";
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
      const downloaded = await downloadArtifact(query, { client: connection.client });
      expectFields(expectOkPayload(downloaded.calls), {
        url: expect.stringContaining(`${url}?mediaTicket=`),
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
  },
);

it("requires filtered transcript membership before issuing a managed download ticket", async () => {
  mockManagedImage();
  const artifactId = "artifact_managed_media_11111111-1111-4111-8111-111111111111";
  mockArtifactBlock(1, { type: "file", artifactId, data: "aW5wdXQ=" }, "user", "run-output");
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
    const artifacts = (await listArtifacts({ sessionKey })).artifacts!;
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
  const message = mockArtifactBlocks([
    { type: "image", data: "Zmlyc3Q=", mimeType: "image/png", alt: "first.png" },
    { type: "image", data: "c2Vjb25k", mimeType: "image/png", alt: "second.png" },
  ]);

  const summaryArtifacts = (await listArtifacts()).artifacts;
  const secondArtifactId = requireNonEmptyString(
    summaryArtifacts?.[1]?.id,
    "expected second artifact id",
  );
  expect(summaryArtifacts?.[0]).not.toHaveProperty("data");
  expect(summaryArtifacts?.[1]).not.toHaveProperty("data");
  Object.defineProperty(message.content[0]!, "data", {
    get: () => {
      throw new Error("download read an unrelated artifact payload");
    },
  });

  const download = await downloadArtifact({
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
  using connection = createSessionFileDownloadClient();
  const managedId = "artifact_managed_media_11111111-1111-4111-8111-111111111111";
  mockArtifactBlocks(
    [
      { type: "file", data: "Zmlyc3Q=" },
      { type: "file", source: { data: "c2Vjb25k", media_type: "text/plain" } },
      { type: "file", url: "https://example.test/result.txt" },
      { type: "file", artifactId: managedId, title: "managed.txt" },
    ],
    2,
    "assistant",
    "run-output",
  );
  hoisted.resolveManagedArtifactDownload.mockResolvedValue({
    artifactId: managedId,
    sessionKey: "agent:main:main",
    type: "file",
    title: "managed.txt",
    url: "/api/chat/media/outgoing/synthetic/full",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  const query = {
    sessionKey: "agent:main:main",
    runId: "run-output",
    messageRole: "assistant",
  };
  const summaries = (await listArtifacts(query)).artifacts!;
  const expected = [
    { artifact: summaries[0], encoding: "base64", data: "Zmlyc3Q=" },
    { artifact: summaries[1], encoding: "base64", data: "c2Vjb25k" },
    { artifact: summaries[2], url: "https://example.test/result.txt" },
    {
      artifact: { ...summaries[3], download: { mode: "url" } },
      url: expect.stringContaining("/api/chat/media/outgoing/synthetic/full?mediaTicket="),
      expiresAt: expect.any(String),
    },
  ];
  hoisted.visitSessionMessagesAsync.mockClear();
  const results = await Promise.all(
    summaries.map((artifact) =>
      downloadArtifact({ ...query, artifactId: artifact.id }, { client: connection.client }),
    ),
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
  const artifactId = (await listArtifacts()).artifacts?.[0]?.id;
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

it.each([{ runId: "other-run" }, { messageRole: "assistant" }, { sessionKey: "agent:main:other" }])(
  "keeps concurrent download query scopes separate: %j",
  async (filter) => {
    mockedMessages([{ ...assistantFileMessage({ title: "input.txt" }), role: "user" }]);
    const sessionKey = "agent:main:main";
    const artifactId = (await listArtifacts({ sessionKey })).artifacts?.[0]?.id;
    hoisted.visitSessionMessagesAsync.mockClear();
    const [allowed, missing] = await Promise.all([
      downloadArtifact({ sessionKey, artifactId }),
      downloadArtifact({ sessionKey, artifactId, ...filter }),
    ]);
    expectFields(expectOkPayload(allowed.calls), { data: "aGVsbG8=" });
    expectFields(expectErrorDetails(missing.calls), { type: "artifact_not_found" });
    expect(hoisted.visitSessionMessagesAsync).toHaveBeenCalledTimes(2);
  },
);
