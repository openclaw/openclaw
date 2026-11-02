import { afterEach, expect, it, vi } from "vitest";
import type {
  ArtifactsDownloadResult,
  ArtifactsListResult,
} from "../../../packages/gateway-protocol/src/schema/artifacts.js";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createImageProcessor } from "../../media/image-processor.js";
import * as frameBudget from "../../shared/chat-attachment-frame-budget.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { ANIMATED_GIF_BYTES } from "../http-image.test-support.js";
import * as thumbnails from "../managed-image-thumbnail-cache.js";
import { artifactsHandlers } from "./artifacts.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";

afterEach(() => vi.restoreAllMocks());

it("returns bounded RPC image previews rather than inline originals when HTTP grants are unavailable", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:rpc-previews",
      sessionId: "rpc-previews",
    };
    const entry = {
      sessionId: scope.sessionId,
      updatedAt: 1,
      visibility: "shared" as const,
      createdActor: { type: "human" as const, source: "profile" as const, id: "owner" },
    };
    await replaceSessionEntry(scope, entry);
    const source = createSolidPngBuffer(2400, 1200, { r: 24, g: 64, b: 128, a: 96 });
    const fixtures = [
      { type: "image", title: "photo.png", mimeType: "image/png", data: source.toString("base64") },
      {
        type: "image",
        title: "invalid.png",
        mimeType: "image/png",
        data: Buffer.from("invalid image").toString("base64"),
      },
      {
        type: "image",
        title: "animated.gif",
        mimeType: "image/gif",
        data: ANIMATED_GIF_BYTES.toString("base64"),
      },
      { type: "image", title: "remote.png", url: "https://example.invalid/never-fetch.png" },
      { type: "file", title: "not-an-image.txt", mimeType: "text/plain", data: "aGVsbG8=" },
    ];
    await appendTranscriptMessage(scope, { message: { role: "assistant", content: fixtures } });
    const context = await createHistoryReadContext();
    const client = identifiedClient("viewer"); // Deliberately lacks an HTTP grant connection.
    const responses: Array<Parameters<RespondFn>> = [];
    const invoke = async (
      method: "artifacts.list" | "artifacts.download",
      params: Record<string, unknown>,
      selectedClient: GatewayClient = client,
      hasCurrentClientAuthority?: () => boolean,
    ) => {
      const respond = vi.fn<RespondFn>((...args) => {
        responses.push(args);
      });
      await artifactsHandlers[method]!({
        params: { sessionKey: scope.sessionKey, ...params },
        context,
        client: selectedClient,
        req: { type: "req", id: "rpc-previews", method },
        isWebchatConnect: () => false,
        hasCurrentClientAuthority,
        respond,
      });
      return respond;
    };
    const listed = await invoke("artifacts.list", {});
    expect(listed.mock.calls[0]?.[0]).toBe(true);
    const listedPayload = listed.mock.calls[0]?.[1] as ArtifactsListResult | undefined;
    if (!listedPayload) {
      throw new Error("Expected artifact list payload");
    }
    const artifacts = listedPayload.artifacts;
    const artifactId = artifacts.find((artifact) => artifact.title === "photo.png")!.id;
    const download = async (params: Record<string, unknown>) => {
      const response = await invoke("artifacts.download", { artifactId, ...params });
      expect(response.mock.calls[0]?.[0]).toBe(true);
      return response.mock.calls[0]?.[1] as ArtifactsDownloadResult;
    };
    const processor = createImageProcessor();
    let defaultData: string | undefined;
    for (const [width, ceiling] of [
      [480, 96],
      [960, 256],
      [1920, 512],
    ] as const) {
      const result = await download({ transport: "http", previewWidth: width });
      expect(result).toMatchObject({
        encoding: "base64",
        artifact: { mimeType: "image/webp", download: { mode: "bytes" } },
      });
      expect(result.url).toBeUndefined();
      const bytes = Buffer.from(result.data!, "base64");
      expect(result.artifact.sizeBytes).toBe(bytes.length);
      expect(bytes.length).toBeLessThanOrEqual(ceiling * 1024);
      expect(bytes).not.toEqual(source);
      expect(await processor.probe(bytes)).toMatchObject({
        format: "webp",
        width,
        height: width / 2,
      });
      expect(await processor.transparency(bytes)).toMatchObject({ hasTransparentPixels: true });
      if (width === 960) {
        defaultData = result.data;
      }
    }
    expect((await download({ previewWidth: 481 })).data).toBe(defaultData);
    const original = await download({ transport: "http" });
    expect(original.artifact.mimeType).toBe("image/png");
    expect(Buffer.from(original.data!, "base64")).toEqual(source);
    for (const previewWidth of [0, -1, 480.5, "480"]) {
      const invalid = await invoke("artifacts.download", { artifactId, previewWidth });
      expect(invalid.mock.calls[0]?.[0]).toBe(false);
    }

    // A source too large for an original inline frame must still be resized first.
    using budget = vi
      .spyOn(frameBudget, "resolveChatAttachmentFrameBudgetBytes")
      .mockReturnValue(512);
    const oversizedOriginal = await invoke("artifacts.download", { artifactId });
    expect(oversizedOriginal.mock.calls[0]?.[0]).toBe(false);
    const preview = await download({ previewWidth: 960 });
    expect(preview.data).toBe(defaultData);
    const imagePage = await invoke("artifacts.list", { type: "image", limit: 4 });
    const imagePayload = imagePage.mock.calls[0]?.[1] as ArtifactsListResult | undefined;
    if (!imagePayload) {
      throw new Error("Expected image artifact list payload");
    }
    const imageId = imagePayload.artifacts.find((item) => item.title === "photo.png")!.id;
    expect((await download({ artifactId: imageId, previewWidth: 960 })).data).toBe(defaultData);
    budget.mockRestore();

    const filtered = await invoke("artifacts.download", {
      artifactId,
      previewWidth: 960,
      runId: "another-run",
    });
    expect(filtered.mock.calls[0]?.[0]).toBe(false);
    const connection = new AbortController();
    const capableClient = {
      ...client,
      connId: "rpc-preview-http",
      connectionSignal: connection.signal,
    };
    try {
      for (const selectedId of [artifactId, imageId]) {
        const response = await invoke(
          "artifacts.download",
          { artifactId: selectedId, transport: "http", previewWidth: 480 },
          capableClient,
        );
        expect(response.mock.calls[0]?.[0]).toBe(true);
        expect(response.mock.calls[0]?.[1]).toMatchObject({
          url: expect.stringContaining("/api/artifacts/download/"),
        });
        expect(response.mock.calls[0]?.[1]).not.toHaveProperty("data");
        expect(response.mock.calls[0]?.[1]).not.toHaveProperty("artifact.image");
      }
    } finally {
      connection.abort();
    }

    using fetch = vi.spyOn(globalThis, "fetch");
    for (const artifact of artifacts.filter((item) => item.id !== artifactId)) {
      const unavailable = await invoke("artifacts.download", {
        artifactId: artifact.id,
        previewWidth: 960,
      });
      expect(unavailable.mock.calls[0]?.[0]).toBe(false);
      expect(unavailable.mock.calls[0]?.[1]).toBeUndefined();
    }
    expect(fetch).not.toHaveBeenCalled();

    const resolveThumbnail = thumbnails.resolveManagedImageThumbnail;
    let current = true;
    using revokedCaller = vi
      .spyOn(thumbnails, "resolveManagedImageThumbnail")
      .mockImplementationOnce(async (...args) => {
        const bytes = await resolveThumbnail(...args);
        current = false;
        return bytes;
      });
    const priorResponses = responses.length;
    await expect(
      invoke("artifacts.download", { artifactId, previewWidth: 960 }, client, () => current),
    ).rejects.toThrow("Gateway requester authority changed");
    expect(responses).toHaveLength(priorResponses);
    revokedCaller.mockRestore();
    vi.spyOn(thumbnails, "resolveManagedImageThumbnail").mockImplementationOnce(async (...args) => {
      const bytes = await resolveThumbnail(...args);
      await replaceSessionEntry(scope, { ...entry, visibility: "draft", updatedAt: 2 });
      return bytes;
    });
    const revoked = await invoke("artifacts.download", { artifactId, previewWidth: 960 });
    expect(revoked.mock.calls[0]?.[0]).toBe(false);
    expect(revoked.mock.calls[0]?.[1]).toBeUndefined();
    expect(revoked.mock.calls[0]?.[2]).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    const denied = await invoke("artifacts.download", { artifactId, previewWidth: 960 });
    expect(denied.mock.calls[0]?.[0]).toBe(false);
    expect(denied.mock.calls[0]?.[1]).toBeUndefined();
  });
});
