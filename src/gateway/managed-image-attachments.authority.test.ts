import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { SessionMetadataUnavailableError } from "../state/session-metadata-unavailable-error.js";
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

  it.each(["rejected", "retired", "schema-missing"] as const)(
    "refuses a %s worker ownership read before opening media",
    async (outcome) => {
      const { attachmentId, sessionKey, originalPath } = await createFixture(stateDir);
      const url = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
      readSessionMessagesMock.mockResolvedValue([
        { content: [{ type: "image", url }], __openclaw: { id: "msg-1" } },
      ]);
      authorizeGatewayHttpRequestOrReplyMock.mockResolvedValue({});
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
            outcome === "rejected" ? "worker read rejected" : /revoked/,
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
});
