import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  bindHttpResponseAuthority,
  captureHttpRequestAuthority,
} from "./http-request-authority.js";
import {
  createFixture,
  prepareManagedSessionStore,
  usePreparedManagedImageState,
} from "./managed-image-attachments.test-support.js";
import { makeMockHttpResponse } from "./test-http-response.js";

type PlaybackTranscodeResolution = Awaited<
  ReturnType<(typeof import("../media/playback-transcode.js"))["resolvePlaybackTranscode"]>
>;
const {
  getRuntimeConfigMock,
  authorizeGatewayHttpRequestOrReplyMock,
  resolveSharedSecretHttpOperatorScopesMock,
  resolveOpenAiCompatibleHttpSenderIsOwnerMock,
  readSessionMessagesMock,
  resolvePlaybackTranscodeMock,
} = vi.hoisted(() => ({
  getRuntimeConfigMock: vi.fn<() => OpenClawConfig>(() => ({})),
  authorizeGatewayHttpRequestOrReplyMock: vi.fn(),
  resolveSharedSecretHttpOperatorScopesMock: vi.fn(),
  resolveOpenAiCompatibleHttpSenderIsOwnerMock: vi.fn(),
  readSessionMessagesMock: vi.fn(),
  resolvePlaybackTranscodeMock: vi.fn(async (): Promise<PlaybackTranscodeResolution> => ({
    kind: "passthrough",
  })),
}));

vi.mock("../config/config.js", () => ({ getRuntimeConfig: getRuntimeConfigMock }));
vi.mock("./http-utils.js", () => ({
  authorizeGatewayHttpRequestOrReply: authorizeGatewayHttpRequestOrReplyMock,
  resolveSharedSecretHttpOperatorScopes: resolveSharedSecretHttpOperatorScopesMock,
  resolveOpenAiCompatibleHttpSenderIsOwner: resolveOpenAiCompatibleHttpSenderIsOwnerMock,
}));
vi.mock("./session-utils.js", () => ({ loadGatewaySessionEntryReadOnly: vi.fn() }));
vi.mock("./session-transcript-readers.js", () => ({
  readSessionMessagesMatchingIdAsync: readSessionMessagesMock,
  readSessionMessagesWithSourceAsync: vi.fn(),
}));
vi.mock("../media/playback-transcode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media/playback-transcode.js")>()),
  resolvePlaybackTranscode: resolvePlaybackTranscodeMock,
}));

const {
  handleManagedOutgoingMediaHttpRequest: handleManagedOutgoingImageHttpRequest,
  cleanupManagedOutgoingMediaRecords,
} = await import("./managed-image-attachments.js");

describe("managed media response authority", () => {
  let stateDir: string;
  usePreparedManagedImageState({
    prefix: "managed-authority-",
    bindState: (prepared) => {
      stateDir = prepared;
    },
    prepareSessionStore: async (prepared) => {
      await prepareManagedSessionStore(prepared);
    },
    cleanupRecords: cleanupManagedOutgoingMediaRecords,
    resetMocks: (prepared) => {
      vi.clearAllMocks();
      getRuntimeConfigMock.mockReturnValue({
        session: { store: path.join(prepared, "sessions.sqlite") },
      });
      resolvePlaybackTranscodeMock.mockReset().mockResolvedValue({ kind: "passthrough" });
    },
  });

  it.each(["full", "thumbnail", "HEAD", "not-modified", "playback", "preparing"] as const)(
    "refuses revoked media authority after %s preparation",
    async (mode) => {
      const isPlayback = mode === "playback" || mode === "preparing";
      const { attachmentId, sessionKey, originalPath } = await createFixture(stateDir, {
        ...(isPlayback ? { filename: "voice.caf", contentType: "audio/x-caf" } : {}),
        body: isPlayback
          ? Buffer.from("private-media")
          : createSolidPngBuffer(8, 8, { r: 24, g: 64, b: 128 }),
      });
      const canonicalPath = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
      readSessionMessagesMock.mockResolvedValue([
        {
          role: "assistant",
          content: [{ type: isPlayback ? "audio" : "image", url: canonicalPath }],
          __openclaw: { id: "msg-1" },
        },
      ]);
      authorizeGatewayHttpRequestOrReplyMock.mockImplementation(async (params) =>
        bindHttpResponseAuthority(
          { authMethod: "token", trustDeclaredOperatorScopes: false },
          params.res,
          captureHttpRequestAuthority(params),
        ),
      );
      resolveSharedSecretHttpOperatorScopesMock.mockReturnValue(["operator.read"]);
      resolveOpenAiCompatibleHttpSenderIsOwnerMock.mockReturnValue(true);

      const preparing = createDeferred();
      const resume = createDeferred();
      const holdPreparation = async () => {
        preparing.resolve();
        await resume.promise;
      };
      if (isPlayback) {
        resolvePlaybackTranscodeMock.mockImplementationOnce(async () => {
          await holdPreparation();
          return { kind: mode === "preparing" ? "preparing" : "passthrough" };
        });
      }
      const originalOpen = fs.open;
      let closeOpenedHandle: MockInstance<() => Promise<void>> | undefined;
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (String(args[0]) === originalPath) {
          const close = handle.close.bind(handle);
          closeOpenedHandle = vi.spyOn(handle, "close").mockImplementation(async () => {
            if (!isPlayback && mode !== "full") {
              await holdPreparation();
            }
            await close();
          });
          if (mode === "full") {
            await holdPreparation();
          }
        }
        return handle;
      });
      let currentAuth: ResolvedGatewayAuth = {
        mode: "token",
        token: "media-reader-before",
        allowTailscale: false,
      };
      let currentConfig: OpenClawConfig = getRuntimeConfigMock();
      const { res, setHeader } = makeMockHttpResponse();
      const req = res.req;
      req.url =
        mode === "thumbnail"
          ? canonicalPath.replace(/\/full$/, "/thumbnail")
          : `${canonicalPath}${isPlayback ? "?playback=1" : ""}`;
      req.method = mode === "HEAD" ? "HEAD" : "GET";
      if (mode === "not-modified") {
        req.headers["if-none-match"] = "*";
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      const responseFinished = new Promise<void>((resolve) => {
        res.once("finish", resolve);
      });
      try {
        const handled = handleManagedOutgoingImageHttpRequest(req, res, {
          auth: currentAuth,
          cfg: currentConfig,
          getRuntimeConfig: () => currentConfig,
          getResolvedAuth: () => currentAuth,
          stateDir,
        });
        await Promise.race([
          preparing.promise,
          handled.then(() => {
            throw new Error("Request ended before its preparation barrier");
          }),
        ]);
        if (mode === "full") {
          currentAuth = { ...currentAuth, token: "media-reader-after" };
        } else {
          currentConfig = { ...currentConfig, gateway: { trustedProxies: ["192.0.2.1"] } };
        }
        resume.resolve();
        await handled;
        await responseFinished;

        expect(res.statusCode).toBe(401);
        expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toMatchObject({
          error: { type: "unauthorized" },
        });
        expect(
          setHeader.mock.calls.some(([name]) => /content-(length|disposition)/i.test(name)),
        ).toBe(false);
        expect(closeOpenedHandle).toHaveBeenCalledOnce();
      } finally {
        resume.resolve();
        openSpy.mockRestore();
      }
    },
  );
});
