import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
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
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
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

const { artifactsHandlers } = await import("./artifacts.js");

async function invokeArtifactHandler(
  method: "artifacts.list" | "artifacts.get" | "artifacts.download",
  params: Record<string, unknown>,
) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  await artifactsHandlers[method]?.({
    req: { type: "req", id: method, method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      calls.push({ ok, payload, error });
    },
    context: runtimeContext({ agents: { entries: { main: { default: true } } } }) as never,
  });
  return { calls };
}
const listArtifacts = (params: Record<string, unknown>) =>
  invokeArtifactHandler("artifacts.list", params);
const getArtifact = (params: Record<string, unknown>) =>
  invokeArtifactHandler("artifacts.get", params);
const downloadArtifact = (params: Record<string, unknown>) =>
  invokeArtifactHandler("artifacts.download", params);
function mockedMessages(messages: unknown[]) {
  hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
    messages.forEach((message, index) => visit(message, index + 1));
    return messages.length;
  });
}

describe("managed artifact lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.loadSessionEntry.mockReturnValue({
      storePath: "/tmp/sessions.sqlite",
      entry: { sessionId: "sess-main" },
    });
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

  it.each([
    { name: "list", method: "artifacts.list", managed: false },
    { name: "get", method: "artifacts.get", managed: false },
    { name: "inline download", method: "artifacts.download", managed: false },
    { name: "managed download", method: "artifacts.download", managed: true },
  ] as const)(
    "rechecks $name after a shared session becomes draft",
    async ({ method, managed }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
          visit(resultImageMessage(), 2);
          return 1;
        });
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
        async function invoke(
          rpcMethod: "artifacts.list" | "artifacts.get" | "artifacts.download",
          params: Record<string, unknown>,
        ) {
          const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
          await artifactsHandlers[rpcMethod]?.({
            req: { type: "req", id: rpcMethod, method: rpcMethod, params: {} },
            params,
            client,
            isWebchatConnect: () => false,
            respond: (ok, payload, error) => calls.push({ ok, payload, error }),
            context: runtimeContext({}) as never,
          });
          return { calls };
        }
        const listed = await invoke("artifacts.list", { sessionKey });
        const inlineArtifactId = requireNonEmptyString(
          expectFirstArtifact(listed.calls)?.id,
          "expected visible artifact",
        );
        const artifactId = managed
          ? "artifact_managed_image_11111111-1111-4111-8111-111111111111"
          : inlineArtifactId;
        const url = "/api/chat/media/outgoing/fixture/id/full?mediaTicket=fixture-ticket";
        hoisted.resolveManagedArtifactDownload.mockResolvedValue({
          artifactId,
          sessionKey,
          type: "image",
          title: "result.png",
          url,
          expiresAt: "2026-07-28T05:00:00.000Z",
        });
        const params = method === "artifacts.list" ? { sessionKey } : { sessionKey, artifactId };
        const baseline = await invoke(method, params);
        expect(baseline.calls).toHaveLength(1);
        const payload = expectOkPayload(baseline.calls);
        if (method === "artifacts.download") {
          expectFields(payload, managed ? { url } : { encoding: "base64", data: "aGVsbG8=" });
        }

        await upsertSessionEntryCore(scope, { ...entry, updatedAt: 2, visibility: "draft" });
        vi.clearAllMocks();
        const denied = await invoke(method, params);

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
    },
  );

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
  it("filters assistant-delivered artifacts without treating input or tool observations as output", async () => {
    const file = (title: string, seq: number) =>
      assistantFileMessage({ title, seq, runId: "run-output" });
    const mirror = file("delivered.csv", 4);
    mockedMessages([
      { ...file("uploaded.csv", 1), role: "user" },
      { ...file("tool-observation.csv", 2), role: "toolResult" },
      file("answer.csv", 3),
      { ...mirror, content: [], openclawDisplayContent: mirror.content },
      assistantFileMessage({ title: "other-run.csv", seq: 5, runId: "other-run" }),
    ]);
    const query = { sessionKey: "agent:main:main", agentId: "main", runId: "run-output" };
    const all = expectArtifactList((await listArtifacts(query)).calls).artifacts;
    expect(all?.map((artifact) => artifact.title)).toEqual([
      "uploaded.csv",
      "tool-observation.csv",
      "answer.csv",
      "delivered.csv",
    ]);
    const filtered = expectArtifactList(
      (await listArtifacts({ ...query, messageRole: "assistant" })).calls,
    ).artifacts;
    expect(filtered?.map((artifact) => artifact.title)).toEqual(["answer.csv", "delivered.csv"]);
    for (const artifact of all ?? []) {
      const params = { ...query, messageRole: "assistant", artifactId: artifact.id };
      for (const method of [getArtifact, downloadArtifact]) {
        const { calls } = await method(params);
        if (artifact.title === "uploaded.csv" || artifact.title === "tool-observation.csv") {
          expectFields(expectErrorDetails(calls), { type: "artifact_not_found" });
        } else {
          expect(calls[0]?.ok).toBe(true);
        }
      }
    }
  });

  it("preserves untitled artifact identities when adding an assistant role filter", async () => {
    mockedMessages(
      ["user", "toolResult", "assistant"].map((role, index) => ({
        role,
        content: [{ type: "file", data: "Ynl0ZXM=" }],
        __openclaw: { seq: index + 1, runId: "run-output" },
      })),
    );
    const query = { sessionKey: "agent:main:main", runId: "run-output" };
    const all = expectArtifactList((await listArtifacts(query)).calls).artifacts;
    expect(all?.map((artifact) => artifact.title)).toEqual(["file 1", "file 2", "file 3"]);
    const filteredQuery = { ...query, messageRole: "assistant" };
    const filtered = expectArtifactList((await listArtifacts(filteredQuery)).calls).artifacts;
    expect(filtered).toEqual([all?.[2]]);
    const artifactId = requireNonEmptyString(all?.[2]?.id, "missing assistant artifact id");
    expect((await getArtifact({ ...filteredQuery, artifactId })).calls[0]?.ok).toBe(true);
    const downloaded = expectOkPayload(
      (await downloadArtifact({ ...filteredQuery, artifactId })).calls,
    );
    expectFields(downloaded, { data: "Ynl0ZXM=", artifact: all?.[2] });
  });

  it.each(["artifacts.list", "artifacts.get", "artifacts.download"] as const)(
    "rejects unsupported role filters on %s before reading the transcript",
    async (method) => {
      const { calls } = await invokeArtifactHandler(method, {
        sessionKey: "agent:main:main",
        messageRole: "toolResult",
        ...(method === "artifacts.list" ? {} : { artifactId: "artifact-example" }),
      });
      expect(calls[0]?.ok).toBe(false);
      expect(hoisted.visitSessionMessagesAsync).not.toHaveBeenCalled();
    },
  );

  it.each([
    { runId: "run-output" },
    { messageRole: "assistant" },
    { runId: "run-output", messageRole: "assistant" },
  ])("keeps scoped managed downloads bound to their exact artifact id: %j", async (filter) => {
    const artifactId = "artifact_managed_media_11111111-1111-4111-8111-111111111111";
    const otherURL =
      "/api/chat/media/outgoing/agent%3Amain%3Amain/22222222-2222-4222-8222-222222222222/full";
    const query = { sessionKey: "agent:main:main", agentId: "main", artifactId, ...filter };
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
