import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { SessionMetadataUnavailableError } from "../state/session-metadata-unavailable-error.js";
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

  it("serves a managed attachment without executing SQLite on the request thread", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);
    const url = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
    readSessionMessagesMock.mockResolvedValue([
      { content: [{ type: "image", url }], __openclaw: { id: "msg-1" } },
    ]);
    authorizeGatewayHttpRequestOrReplyMock.mockResolvedValue({ assertCurrent: () => {} });
    resolveSharedSecretHttpOperatorScopesMock.mockReturnValue(["operator.read"]);
    resolveOpenAiCompatibleHttpSenderIsOwnerMock.mockReturnValue(true);
    const { res } = makeMockHttpResponse();
    res.req.url = url;
    res.req.method = "GET";
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<void>((resolve) => {
      res.once("finish", resolve);
    });
    const sql = observeHostDataSql();
    try {
      expect(
        await handleManagedOutgoingImageHttpRequest(res.req, res, {
          auth: { mode: "none", allowTailscale: false },
          stateDir,
        }),
      ).toBe(true);
      await finished;
      expect(res.statusCode).toBe(200);
      expect(Buffer.concat(chunks).toString()).toBe("original-image");
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  });

  it.each(["revoked", "rejected", "retired", "schema-missing"] as const)(
    "refuses a %s worker ownership read before opening media",
    async (outcome) => {
      const { attachmentId, sessionKey, originalPath } = await createFixture(stateDir);
      const url = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
      readSessionMessagesMock.mockResolvedValue([
        { content: [{ type: "image", url }], __openclaw: { id: "msg-1" } },
      ]);
      let current = true;
      authorizeGatewayHttpRequestOrReplyMock.mockResolvedValue({
        assertCurrent: () => {
          if (!current) {
            throw new Error("request revoked");
          }
        },
      });
      resolveSharedSecretHttpOperatorScopesMock.mockReturnValue(["operator.read"]);
      resolveOpenAiCompatibleHttpSenderIsOwnerMock.mockReturnValue(true);
      const entered = createDeferred();
      const resume = createDeferred();
      const readDatabases = history.withSessionHistoryWorkerDatabases;
      let databasePath: string | undefined;
      let closing: Promise<boolean> | undefined;
      const readSpy = vi
        .spyOn(history, "withSessionHistoryWorkerDatabases")
        .mockImplementation((databases, consume, lane) => {
          databasePath = databases[0]?.path;
          return readDatabases(
            databases,
            (owners) =>
              consume(
                owners.map((owner) => ({
                  ...owner,
                  async readExactEntries(input) {
                    const result = await owner.readExactEntries(input);
                    entered.resolve();
                    await resume.promise;
                    if (outcome === "rejected") {
                      throw new Error("worker read rejected");
                    }
                    if (outcome === "schema-missing") {
                      throw new SessionMetadataUnavailableError("schema-missing");
                    }
                    return result;
                  },
                })),
              ),
            lane,
          );
        });
      const openSpy = vi.spyOn(fs, "open");
      const { res, setHeader } = makeMockHttpResponse();
      res.req.url = url;
      res.req.method = "GET";
      const handled = handleManagedOutgoingImageHttpRequest(res.req, res, {
        auth: { mode: "none", allowTailscale: false },
        stateDir,
      });
      try {
        await Promise.race([
          entered.promise,
          handled.then(() => {
            throw new Error("ownership read was bypassed");
          }),
        ]);
        current = outcome !== "revoked";
        if (outcome === "retired") {
          expect(databasePath).toBeDefined();
          closing = closeOpenClawAgentDatabaseByPathAsync(databasePath!);
        }
        resume.resolve();
        if (outcome === "schema-missing") {
          await expect(handled).resolves.toBe(true);
          expect(res.statusCode).toBe(404);
        } else {
          await expect(handled).rejects.toThrow(
            outcome === "revoked"
              ? "request revoked"
              : outcome === "rejected"
                ? "worker read rejected"
                : /revoked/,
          );
        }
        expect(openSpy.mock.calls.some(([file]) => String(file) === originalPath)).toBe(false);
        expect(
          setHeader.mock.calls.some(([name]) => /content-(length|disposition)/i.test(name)),
        ).toBe(false);
        expect(readSessionMessagesMock).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        await handled.catch(() => {});
        await closing;
        readSpy.mockRestore();
        openSpy.mockRestore();
      }
    },
  );

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
