import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { RawData } from "ws";
import {
  WebSocket as NpmWebSocket,
  WebSocketServer as NpmWebSocketServer,
} from "../../../packages/gateway-client/src/websocket.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createOneTimeTicketStore } from "../../shared/one-time-ticket-store.js";
import { rejectWebSocketUpgrade } from "../../shared/websocket-upgrade-reject.js";
import { startWebSocketKeepalive } from "../websocket-keepalive.js";
import { connectRfbAttachment, type DesktopRfbAttachment } from "./attachment.js";
import { mintDesktopAudioObserver } from "./audio-bridge.js";
import type { DesktopAudioSource } from "./managed-linux-audio.js";
import type { DesktopObserveRequester } from "./observe-requester.js";
import {
  preauthenticateRfb,
  RfbAuthenticationRejectedError,
  RfbPreauthBuffer,
  type RfbPreauthDescriptor,
  type RfbPreauthPeer,
  RfbPreauthTimeoutError,
} from "./rfb-preauth.js";
import { createRfbClientMessageFilter } from "./rfb-view-only-filter.js";
import type { DesktopSessionRegistry } from "./session-registry.js";

type WebSocket = import("ws").WebSocket;

export const DESKTOP_OBSERVE_PATH = "/desktop/observe";
const TOKEN_TTL_MS = 60_000;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const PAUSE_BUFFERED_BYTES = 4 * 1024 * 1024;
const RESUME_CHECK_MS = 25;
const observerLog = createSubsystemLogger("gateway/desktop");

type DesktopCloseTrigger =
  | "owner-close"
  | "browser-close"
  | "browser-error"
  | "stream-close"
  | "stream-error"
  | "authority-revoked"
  | "invalid-view-only-stream"
  | "authentication-failed";

type DesktopObserverTokenEntry = {
  sourceKey: string;
  ownerEpoch: number;
  control: boolean;
  attachment: DesktopRfbAttachment;
  preauth?: RfbPreauthDescriptor;
  requester?: DesktopObserveRequester;
  onAbandon?: () => Promise<void>;
  audio?: ReturnType<typeof mintDesktopAudioObserver>;
};

const observerTokens = createOneTimeTicketStore<DesktopObserverTokenEntry>({
  ttlMs: TOKEN_TTL_MS,
  onExpire: (entry) => entry.audio?.close(),
});
const desktopObserverWss = new NpmWebSocketServer({
  noServer: true,
  maxPayload: MAX_PAYLOAD_BYTES,
});

export function mintDesktopObserverToken(params: {
  sourceKey: string;
  ownerEpoch: number;
  control: boolean;
  attachment: DesktopRfbAttachment;
  preauth?: RfbPreauthDescriptor;
  requester?: DesktopObserveRequester;
  onAbandon?: () => Promise<void>;
  nowMs?: number;
  audio?: DesktopAudioSource;
}) {
  const { nowMs, audio: source, ...payload } = params;
  // Audio is gated on the screen authentication result, not possession of its token.
  const audio =
    source && params.preauth
      ? mintDesktopAudioObserver({ source, requester: params.requester })
      : undefined;
  const minted = observerTokens.mint(
    { ...payload, ...(audio ? { audio } : {}) },
    {
      nowMs,
      revokeSignal:
        params.requester?.isCurrent() === false ? AbortSignal.abort() : params.requester?.signal,
    },
  );
  return { ...minted, ...(audio ? { audio: audio.descriptor } : {}) };
}

function consumeDesktopObserverToken(
  token: string,
  nowMs = Date.now(),
): DesktopObserverTokenEntry | undefined {
  return observerTokens.consume(token, nowMs);
}

export async function releaseDesktopObserverToken(
  wsPath: string,
  requester: DesktopObserveRequester | undefined,
): Promise<boolean> {
  const connId = requester?.connId;
  if (!connId || !requester.isCurrent()) {
    return false;
  }
  let resource: URL;
  try {
    resource = new URL(wsPath, "http://127.0.0.1");
  } catch {
    return false;
  }
  if (resource.pathname !== DESKTOP_OBSERVE_PATH) {
    return false;
  }
  const entry = observerTokens.consume(
    resource.searchParams.get("token") ?? "",
    Date.now(),
    (candidate) =>
      candidate.requester?.connId === connId &&
      candidate.requester.isCurrent() &&
      requester.isCurrent(),
  );
  if (!entry) {
    return false;
  }
  entry.audio?.close();
  await entry.onAbandon?.();
  return true;
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

class WebSocketPreauthPeer implements RfbPreauthPeer {
  private readonly reader = new RfbPreauthBuffer();
  private readonly onMessage = (data: RawData, isBinary: boolean) => {
    if (!isBinary) {
      this.reader.fail(new Error("RFB browser sent a non-binary handshake frame"));
    } else {
      this.reader.push(rawDataBuffer(data));
    }
  };
  private readonly onClose = () => {
    this.reader.fail(new Error("RFB browser closed during authentication negotiation"));
  };
  private readonly onError = () => {
    this.reader.fail(new Error("RFB browser failed during authentication negotiation"));
  };

  constructor(private readonly ws: WebSocket) {
    ws.on("message", this.onMessage);
    ws.once("close", this.onClose);
    ws.once("error", this.onError);
  }

  async readExactly(length: number, signal: AbortSignal): Promise<Buffer> {
    return await this.reader.readExactly(length, signal);
  }

  async write(buffer: Buffer, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw signal.reason;
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
        cleanup();
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("RFB authentication negotiation aborted"),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.ws.send(buffer, { binary: true }, (error) => {
        cleanup();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  detach(): Buffer {
    this.ws.off("message", this.onMessage);
    this.ws.off("close", this.onClose);
    this.ws.off("error", this.onError);
    return this.reader.takeBuffered();
  }
}

/** Upgrades one authenticated observer token into a raw bidirectional RFB stream. */
export function handleDesktopObserveUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: {
    registry: Pick<DesktopSessionRegistry, "attachObserver" | "claimStream">;
    getBufferedAmount?: (ws: WebSocket) => number;
  },
): boolean {
  const resource = new URL(req.url ?? "/", "http://127.0.0.1");
  if (resource.pathname !== DESKTOP_OBSERVE_PATH) {
    return false;
  }
  const token = resource.searchParams.get("token") ?? "";
  const entry = consumeDesktopObserverToken(token);
  if (!entry || entry.requester?.isCurrent() === false) {
    entry?.audio?.close();
    rejectWebSocketUpgrade(socket, { status: 401 });
    return true;
  }
  desktopObserverWss.handleUpgrade(req, socket, head, (ws) => {
    const claimedStream =
      entry.attachment.kind === "stream"
        ? deps.registry.claimStream(entry.sourceKey, entry.attachment)
        : undefined;
    if (entry.attachment.kind === "stream" && !claimedStream) {
      entry.audio?.close();
      ws.close(1013, "desktop stream unavailable");
      return;
    }
    // View-only is enforced here at the RFB message boundary; the UI setting is only UX.
    const observer = deps.registry.attachObserver(entry.sourceKey, {
      control: entry.control,
      operatorName: entry.requester?.operatorName,
      ownerEpoch: entry.ownerEpoch,
      // Retire the stream and keepalive before the close handshake can wait on a paused peer.
      close: (code, reason) => closeBoth(code, reason, "owner-close"),
    });
    if (!observer) {
      entry.audio?.close();
      claimedStream?.destroy();
      ws.close(1013, "desktop observer limit");
      return;
    }
    const desktopSocket =
      entry.attachment.kind === "stream" ? claimedStream : connectRfbAttachment(entry.attachment);
    if (!desktopSocket) {
      entry.audio?.close();
      observer.release();
      ws.close(1013, "desktop stream unavailable");
      return;
    }
    let closeCause: { trigger: DesktopCloseTrigger; code: number } | undefined;
    let negotiating = Boolean(entry.preauth);
    let resumeTimer: ReturnType<typeof setInterval> | undefined;
    const stopKeepalive = startWebSocketKeepalive(ws);
    const resumeWebSocket = () => ws.resume();
    desktopSocket.on("drain", resumeWebSocket);

    const closeBoth = (code: number, reason: string, trigger: DesktopCloseTrigger) => {
      if (closeCause) {
        return;
      }
      // Keep the first cleanup decision when its destroyed stream emits a later close.
      closeCause = { trigger, code };
      entry.audio?.close();
      entry.requester?.signal?.removeEventListener("abort", onRequesterGone);
      stopKeepalive();
      clearInterval(resumeTimer);
      resumeTimer = undefined;
      observer.release();
      desktopSocket.off("drain", resumeWebSocket);
      // A blocked desktop cannot drain, but the browser must still acknowledge close.
      ws.resume();
      desktopSocket.destroy();
      if (ws.readyState === NpmWebSocket.OPEN || ws.readyState === NpmWebSocket.CONNECTING) {
        ws.close(code, reason);
      }
    };
    const onRequesterGone = () => closeBoth(4006, "authority_revoked", "authority-revoked");

    const startSplice = (browserRemainder: Buffer = Buffer.alloc(0), preauthenticated = false) => {
      if (preauthenticated) {
        entry.audio?.activate();
      }
      const clientMessageFilter = entry.control
        ? undefined
        : createRfbClientMessageFilter({
            startPhase: preauthenticated ? "clientInit" : "version",
          });
      const forwardClientChunk = (chunk: Buffer) => {
        if (entry.requester?.isCurrent() === false) {
          onRequesterGone();
          return;
        }
        const result = clientMessageFilter?.filter(chunk);
        if (result && "error" in result) {
          closeBoth(1008, "invalid view-only RFB stream", "invalid-view-only-stream");
          return;
        }
        const forward = result?.forward ?? chunk;
        if (forward.length > 0 && !desktopSocket.write(forward)) {
          ws.pause();
        }
      };
      ws.on("message", (data, isBinary) => {
        if (!isBinary || closeCause) {
          return;
        }
        forwardClientChunk(rawDataBuffer(data));
      });
      desktopSocket.on("data", (chunk) => {
        if (closeCause || ws.readyState !== NpmWebSocket.OPEN) {
          return;
        }
        if (entry.requester?.isCurrent() === false) {
          onRequesterGone();
          return;
        }
        ws.send(chunk, { binary: true });
        const bufferedAmount = () => deps.getBufferedAmount?.(ws) ?? ws.bufferedAmount;
        if (bufferedAmount() <= PAUSE_BUFFERED_BYTES || resumeTimer) {
          return;
        }
        desktopSocket.pause();
        resumeTimer = setInterval(() => {
          if (bufferedAmount() <= PAUSE_BUFFERED_BYTES) {
            clearInterval(resumeTimer);
            resumeTimer = undefined;
            desktopSocket.resume();
          }
        }, RESUME_CHECK_MS);
        resumeTimer.unref?.();
      });
      if (browserRemainder.length > 0) {
        forwardClientChunk(browserRemainder);
      }
    };

    ws.once("close", (closeCode) => {
      closeBoth(1000, "desktop observer closed", "browser-close");
      observerLog.info("desktop observer closed", {
        sourceKey: entry.sourceKey,
        ownerEpoch: entry.ownerEpoch,
        ...(entry.attachment.kind === "stream" ? { streamId: entry.attachment.streamId } : {}),
        trigger: closeCause?.trigger,
        cleanupCode: closeCause?.code,
        closeCode,
      });
    });
    ws.once("error", () => closeBoth(1011, "desktop observer failed", "browser-error"));
    desktopSocket.once("close", () => closeBoth(1000, "desktop stream closed", "stream-close"));
    desktopSocket.once("error", () =>
      closeBoth(
        1011,
        negotiating ? "desktop connection failed during authentication" : "desktop stream failed",
        "stream-error",
      ),
    );

    entry.requester?.signal?.addEventListener("abort", onRequesterGone, { once: true });
    if (entry.requester?.signal?.aborted || entry.requester?.isCurrent() === false) {
      onRequesterGone();
      return;
    }

    if (!entry.preauth) {
      startSplice();
      return;
    }

    const preauth = entry.preauth;
    const browser = new WebSocketPreauthPeer(ws);
    void (async () => {
      try {
        await preauthenticateRfb({ server: desktopSocket, browser, preauth });
        const remainder = browser.detach();
        entry.preauth = undefined;
        negotiating = false;
        if (!closeCause) {
          startSplice(remainder, true);
        }
      } catch (error) {
        browser.detach();
        entry.preauth = undefined;
        closeBoth(
          error instanceof RfbAuthenticationRejectedError ? 1008 : 1011,
          error instanceof RfbPreauthTimeoutError
            ? "desktop authentication timed out"
            : error instanceof RfbAuthenticationRejectedError
              ? preauth.auth === "ard-account"
                ? "macOS denied desktop access; check credentials and Screen Sharing or Remote Management Observe/Control permissions"
                : "desktop VNC authentication rejected"
              : "desktop security negotiation failed; check the desktop service and reconnect",
          "authentication-failed",
        );
      }
    })();
  });
  return true;
}
