import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import {
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
  return { ...actual, visitSessionMessagesAsync: hoisted.visitSessionMessagesAsync };
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

describe("managed artifact lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.loadSessionEntry.mockReturnValue({
      storePath: "/tmp/sessions.sqlite",
      entry: { sessionId: "sess-main" },
    });
    hoisted.resolveManagedArtifactDownload.mockResolvedValue(null);
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
});
