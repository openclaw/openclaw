import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
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
} from "./artifacts.test-support.js";

const hoisted = vi.hoisted(() => ({
  visitSessionMessagesAsync: vi.fn(),
  resolveManagedArtifactDownload: vi.fn(),
}));
vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  loadGatewaySessionEntryReadOnly: () => ({
    storePath: "/tmp/sessions.json",
    entry: { sessionId: "sess-main", sessionFile: "/tmp/sess-main.jsonl" },
  }),
}));
vi.mock("../session-transcript-readers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-transcript-readers.js")>();
  const { withArtifactFixtureReader } = await import("./artifacts.test-support.js");
  return withArtifactFixtureReader(actual, hoisted.visitSessionMessagesAsync);
});
vi.mock("../managed-image-attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../managed-image-attachments.js")>()),
  resolveManagedOutgoingMediaArtifactDownload: hoisted.resolveManagedArtifactDownload,
  resolveManagedOutgoingMediaUrlDownload: async () => null,
}));

function mockedMessages(messages: unknown[]) {
  hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
    messages.forEach((message, index) => visit(message, index + 1));
    return messages.length;
  });
}

async function invokeArtifactHandler(
  method: "artifacts.list" | "artifacts.download",
  params: Record<string, unknown>,
  options: { signal?: AbortSignal } = {},
) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  await artifactsHandlers[method]!({
    req: { type: "req", id: method, method },
    params,
    client: null,
    signal: options.signal,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      calls.push({ ok, payload, error });
    },
    context: {
      getRuntimeConfig: () => ({ agents: { entries: { main: { default: true } } } }),
    } as never,
  });
  return { calls };
}
const listArtifacts = (params: Record<string, unknown>) =>
  invokeArtifactHandler("artifacts.list", params);
const downloadArtifact = (params: Record<string, unknown>) =>
  invokeArtifactHandler("artifacts.download", params);

describe("artifact download lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.resolveManagedArtifactDownload.mockResolvedValue(null);
    mockedMessages([resultImageMessage()]);
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
