// One mock/request owner shared by managed attachment storage and playback consumers.
import http from "node:http";
import path from "node:path";
import { beforeEach, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import {
  prepareManagedSessionStore as seedManagedSessionStore,
  requestManagedImageHttp,
  usePreparedManagedImageState,
} from "./managed-image-attachments.test-support.js";
import type { GatewayClient } from "./server-methods/types.js";

type PlaybackTranscodeResolver =
  (typeof import("../media/playback-transcode.js"))["resolvePlaybackTranscode"];
type PlaybackMetadataForSourceResolver =
  (typeof import("../media/playback-transcode.js"))["resolvePlaybackMetadataForSource"];

export const authorizeGatewayHttpRequestOrReplyMock = vi.fn();
export const resolveSharedSecretHttpOperatorScopesMock = vi.fn();
export const resolveOpenAiCompatibleHttpSenderIsOwnerMock = vi.fn();
export const loadSessionEntryMock = vi.fn();
export const readSessionMessagesMock = vi.fn();
const getRuntimeConfigMock = vi.hoisted(() => vi.fn(() => ({})));
export { getRuntimeConfigMock };
export const resolvePlaybackMetadataForSourceMock = vi.fn<PlaybackMetadataForSourceResolver>();
export const resolvePlaybackTranscodeMock = vi.fn<PlaybackTranscodeResolver>(async () => ({
  kind: "passthrough",
}));

beforeEach(() => {
  resolvePlaybackMetadataForSourceMock.mockReset();
  resolvePlaybackMetadataForSourceMock.mockImplementation(async ({ mimeType }) => ({
    playback: mimeType === "audio/x-caf" ? "transcode" : "native",
  }));
});

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("./http-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http-utils.js")>()),
  authorizeGatewayHttpRequestOrReply: authorizeGatewayHttpRequestOrReplyMock,
  resolveSharedSecretHttpOperatorScopes: resolveSharedSecretHttpOperatorScopesMock,
  resolveOpenAiCompatibleHttpSenderIsOwner: resolveOpenAiCompatibleHttpSenderIsOwnerMock,
}));

vi.mock("./session-utils-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils-store.js")>()),
  loadGatewaySessionEntryReadOnlyAsync: async (...args: unknown[]) => loadSessionEntryMock(...args),
}));

vi.mock("./session-transcript-readers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-transcript-readers.js")>()),
  readSessionMessagesAsync: readSessionMessagesMock,
  readSessionMessagesMatchingIdAsync: async (scope: unknown, messageId: string) =>
    (await readSessionMessagesMock(scope)).filter(
      (message: { __openclaw?: { id?: string } }) => message["__openclaw"]?.id === messageId,
    ),
  readSessionMessagesWithSourceAsync: async (...args: unknown[]) => ({
    messages: await readSessionMessagesMock(...args),
  }),
}));

vi.mock("../media/playback-transcode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/playback-transcode.js")>();
  resolvePlaybackMetadataForSourceMock.mockImplementation(async ({ mimeType }) => ({
    playback: mimeType === "audio/x-caf" ? "transcode" : "native",
  }));
  return {
    ...actual,
    resolvePlaybackMetadataForSource: resolvePlaybackMetadataForSourceMock,
    resolvePlaybackTranscode: resolvePlaybackTranscodeMock,
  };
});

const {
  cleanupManagedOutgoingMediaRecords: cleanupManagedOutgoingImageRecords,
  handleManagedOutgoingMediaHttpRequest: handleManagedOutgoingImageHttpRequest,
} = await import("./managed-image-attachments.js");
export { handleManagedOutgoingImageHttpRequest };
export const { bindHttpResponseAuthority } = await import("./http-request-authority.js");

export async function prepareManagedSessionStore(stateDir: string): Promise<void> {
  const store = await seedManagedSessionStore(stateDir);
  getRuntimeConfigMock.mockReturnValue({ session: { store } });
}

export function assistantMessage(content: unknown) {
  return { role: "assistant", content, __openclaw: { id: "msg-1" } };
}

export function mockSessionEntry(
  storePath: string,
  sessionId = "sess-1",
  sessionFile = "session.jsonl",
) {
  loadSessionEntryMock.mockReturnValue({ storePath, entry: { sessionId, sessionFile } });
}

export function mediaPath(fixture: { sessionKey: string; attachmentId: string }) {
  return `/api/chat/media/outgoing/${encodeURIComponent(fixture.sessionKey)}/${fixture.attachmentId}/full`;
}

export function mediaMessage(fixture: Parameters<typeof mediaPath>[0], type = "image") {
  const url = mediaPath(fixture);
  return assistantMessage([{ type, url, openUrl: url }]);
}

export function useManagedImageState(prefix: string, bindState: (stateDir: string) => void): void {
  usePreparedManagedImageState({
    prefix,
    bindState,
    prepareSessionStore: prepareManagedSessionStore,
    cleanupRecords: cleanupManagedOutgoingImageRecords,
    resetMocks: (stateDir) => {
      vi.clearAllMocks();
      authorizeGatewayHttpRequestOrReplyMock.mockReset();
      resolveSharedSecretHttpOperatorScopesMock.mockReset();
      resolveOpenAiCompatibleHttpSenderIsOwnerMock.mockReset();
      loadSessionEntryMock.mockReset();
      readSessionMessagesMock.mockReset();
      resolvePlaybackTranscodeMock.mockReset().mockResolvedValue({ kind: "passthrough" });
      getRuntimeConfigMock.mockReturnValue({
        session: { store: path.join(stateDir, "sessions.sqlite") },
      });
    },
  });
}

export async function requestManagedImage(params: {
  stateDir: string;
  pathName: string;
  method?: string;
  scopes?: string[];
  denyAuth?: boolean;
  authResponse?: Record<string, unknown>;
  headers?: http.ClientRequestArgs["headers"];
  transcriptMessages?: Record<string, unknown>[];
  sessionEntry?: { sessionId: string; sessionFile?: string };
  clients?: ReadonlySet<GatewayClient>;
}) {
  authorizeGatewayHttpRequestOrReplyMock.mockImplementation(async ({ res }) => {
    if (params.denyAuth) {
      res.statusCode = 401;
      res.end();
      return null;
    }
    return bindHttpResponseAuthority({ ok: true, ...params.authResponse }, res, () => true);
  });
  resolveSharedSecretHttpOperatorScopesMock.mockReturnValue(params.scopes ?? ["operator.read"]);
  resolveOpenAiCompatibleHttpSenderIsOwnerMock.mockImplementation((_req, requestAuth) => {
    if (requestAuth.authMethod === "token" || requestAuth.authMethod === "password") {
      return true;
    }
    return (
      requestAuth.trustDeclaredOperatorScopes === true &&
      (params.scopes ?? ["operator.read"]).includes("operator.admin")
    );
  });
  loadSessionEntryMock.mockReturnValue({
    storePath: path.join(params.stateDir, "sessions.sqlite"),
    entry: params.sessionEntry ?? { sessionId: "sess-1", sessionFile: "session.jsonl" },
  });
  readSessionMessagesMock.mockImplementation(
    async () =>
      params.transcriptMessages ?? [
        assistantMessage([{ type: "image", url: params.pathName, openUrl: params.pathName }]),
      ],
  );

  const auth = { mode: "test" } as never;
  const server = http.createServer((req, res) => {
    void (async () => {
      const handled = await handleManagedOutgoingImageHttpRequest(req, res, {
        auth,
        trustedProxies: ["127.0.0.1/32"],
        allowRealIpFallback: false,
        stateDir: params.stateDir,
        clients: params.clients,
      });
      if (!handled) {
        res.statusCode = 404;
        res.end("unhandled");
      }
    })();
  });

  const origin = await listenLoopback(server);
  try {
    const result = await requestManagedImageHttp(
      origin,
      params.pathName,
      params.method,
      params.headers,
    );
    return { result, auth };
  } finally {
    await closeHttpServer(server);
  }
}
