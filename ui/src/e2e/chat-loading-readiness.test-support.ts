import type {
  ChatHistoryParams,
  ConnectParams,
  ModelCatalogTarget,
  ModelsSnapshotEvent,
  RequestFrame,
} from "@openclaw/gateway-protocol";
import type { Page } from "playwright";
import type { ApplicationContext } from "../app/context.ts";

type AcceptedIdentity = Pick<ModelsSnapshotEvent, "target" | "scope"> & {
  acceptedAtMs: number;
  pathname: string;
  plainUrl: boolean;
};

type StartupReadiness = Pick<ChatHistoryParams, "sessionKey" | "agentId"> & {
  requestId: string;
  sentAtMs: number;
  resolutionRequestId?: string;
  resolutionSourceCurrent: boolean;
  prepared?: AcceptedIdentity & { sourceCurrent: boolean };
};

declare global {
  interface Window {
    chatLoadingReadiness: {
      connects: number;
      target?: ModelCatalogTarget;
      observerAttached: boolean;
      startups: StartupReadiness[];
    };
  }
}

/** Observe accepted application events before the connect reply can arrive. */
export async function installChatLoadingReadinessObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sample: Window["chatLoadingReadiness"] = {
      connects: 0,
      observerAttached: false,
      startups: [],
    };
    window.chatLoadingReadiness = sample;
    const NativeWebSocket = WebSocket;
    const stops: Array<() => void> = [];
    const cleanup = () => {
      for (const stop of stops.splice(0)) {
        stop();
      }
    };
    const context = () =>
      document.querySelector<HTMLElement & { context?: ApplicationContext }>("openclaw-app")
        ?.context;
    const captureSource = (owner: ApplicationContext, socket: WebSocket) => {
      const { gateway, sessions } = owner;
      const { client, hello } = gateway.snapshot;
      const userId = gateway.snapshot.selfUser?.id;
      let retired = false;
      const current = () =>
        !retired &&
        client !== null &&
        hello !== null &&
        context() === owner &&
        owner.sessions === sessions &&
        !owner.lifecycleAbortSignal?.aborted &&
        gateway.snapshot.phase === "connected" &&
        gateway.snapshot.client === client &&
        gateway.snapshot.hello === hello &&
        gateway.snapshot.selfUser?.id === userId;
      stops.push(
        gateway.subscribe(() => {
          if (!current()) {
            retired = true;
          }
        }),
      );
      return (sender: WebSocket) => sender === socket && current();
    };
    let resolution: { id: string; current: (sender: WebSocket) => boolean } | undefined;
    let prepared:
      | { identity: AcceptedIdentity; current: (sender: WebSocket) => boolean }
      | undefined;
    window.WebSocket = class extends NativeWebSocket {
      override send(data: Parameters<WebSocket["send"]>[0]) {
        if (typeof data !== "string") {
          return super.send(data);
        }
        const frame = JSON.parse(data) as RequestFrame;
        const owner = context();
        if (frame.method === "connect") {
          cleanup();
          resolution = undefined;
          prepared = undefined;
          sample.connects += 1;
          sample.target = (frame.params as ConnectParams).modelCatalog;
          sample.observerAttached = Boolean(owner);
          if (owner) {
            stops.push(
              owner.gateway.subscribeEvents((event) => {
                if (event.event !== "models.snapshot") {
                  return;
                }
                const publication = event.payload as ModelsSnapshotEvent;
                prepared = {
                  identity: {
                    target: publication.target,
                    scope: publication.scope,
                    acceptedAtMs: Date.now(),
                    pathname: location.pathname,
                    plainUrl: !location.search && !location.hash,
                  },
                  current: captureSource(owner, this),
                };
              }),
            );
          }
        } else if (frame.method === "sessions.resolve" && owner) {
          resolution = { id: frame.id, current: captureSource(owner, this) };
        } else if (frame.method === "chat.startup") {
          const params = frame.params as ChatHistoryParams;
          sample.startups.push({
            requestId: frame.id,
            sessionKey: params.sessionKey,
            agentId: params.agentId,
            sentAtMs: Date.now(),
            resolutionRequestId: resolution?.id,
            resolutionSourceCurrent: resolution?.current(this) ?? false,
            ...(prepared
              ? {
                  prepared: {
                    ...prepared.identity,
                    sourceCurrent:
                      prepared.current(this) && location.pathname === prepared.identity.pathname,
                  },
                }
              : {}),
          });
        }
        return super.send(data);
      }
    };
    window.addEventListener("pagehide", cleanup, { once: true });
  });
}
