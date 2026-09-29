import {
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  gatewayCredentialScope,
  type ConnectParams,
} from "@openclaw/gateway-client/browser";
import {
  normalizeGatewayClientId,
  normalizeGatewayClientMode,
} from "@openclaw/gateway-protocol/client-info";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatUiError } from "../lib/format-error.ts";
import { generateUUID } from "../lib/uuid.ts";

export type NativeGatewayAuthorization = {
  client: ConnectParams["client"];
  scopes: string[];
  auth:
    | { deviceToken: string; token?: never; password?: never }
    | { token: string; deviceToken?: never; password?: never }
    | { password: string; token?: never; deviceToken?: never };
  device: NonNullable<ConnectParams["device"]>;
};

export type NativeGatewayConnectAuth = (challenge: {
  gatewayUrl: string;
  nonce: string;
  signedAt: number;
  signal: AbortSignal;
}) => Promise<NativeGatewayAuthorization>;

type ChallengeMessage = { id: string; nonce: string; signedAt: number };

// A current native grant can become available again after the app reconnects.
// Retry through that same owner; malformed proofs and route violations stay terminal.
export class NativeGatewayAuthUnavailableError extends Error {}

type NativeAuthHost = Window & {
  OpenClawNativeGatewayAuth?: {
    postMessage(message: string): void | Promise<unknown>;
    onmessage?: ((event: { data: string }) => void) | null;
  };
  webkit?: {
    messageHandlers?: {
      OpenClawNativeGatewayAuth?: { postMessage(message: ChallengeMessage): Promise<unknown> };
    };
  };
};

function readNativeCredential(value: Record<string, unknown>): NativeGatewayAuthorization["auth"] {
  // Preserve the accepted native method. In particular, role-configured Gateways
  // distinguish shared-owner token/password auth from device-token authentication.
  if (Object.keys(value).length === 1) {
    if (typeof value.deviceToken === "string" && value.deviceToken) {
      return { deviceToken: value.deviceToken };
    }
    if (typeof value.token === "string" && value.token) {
      return { token: value.token };
    }
    if (typeof value.password === "string" && value.password) {
      return { password: value.password };
    }
  }
  throw new Error("The app returned an invalid Gateway credential. Reconnect in the app.");
}

function readAuthorization(
  value: unknown,
  challenge: ChallengeMessage,
): NativeGatewayAuthorization {
  const result = isRecord(value) ? value : {};
  const client = isRecord(result.client) ? result.client : {};
  const device = isRecord(result.device) ? result.device : {};
  const auth = isRecord(result.auth) ? result.auth : {};
  const id = normalizeGatewayClientId(typeof client.id === "string" ? client.id : undefined);
  const mode = normalizeGatewayClientMode(
    typeof client.mode === "string" ? client.mode : undefined,
  );
  if (
    !id ||
    !mode ||
    typeof client.version !== "string" ||
    typeof client.platform !== "string" ||
    !Array.isArray(result.scopes) ||
    !result.scopes.every((scope): scope is string => typeof scope === "string") ||
    typeof device.id !== "string" ||
    typeof device.publicKey !== "string" ||
    typeof device.signature !== "string" ||
    device.nonce !== challenge.nonce ||
    device.signedAt !== challenge.signedAt
  ) {
    throw new Error("The app returned an invalid Gateway authorization. Reconnect in the app.");
  }
  return {
    client: {
      id,
      mode,
      version: client.version,
      platform: client.platform,
      ...(typeof client.deviceFamily === "string" ? { deviceFamily: client.deviceFamily } : {}),
      ...(typeof client.instanceId === "string" ? { instanceId: client.instanceId } : {}),
    },
    scopes: result.scopes,
    auth: readNativeCredential(auth),
    device: {
      id: device.id,
      publicKey: device.publicKey,
      signature: device.signature,
      nonce: challenge.nonce,
      signedAt: challenge.signedAt,
    },
  };
}

/** Adapts native challenge signing; the app remains the sole credential and grant owner. */
export function createNativeGatewayConnectAuth(
  gatewayUrl: string,
  options: { messagePort?: boolean } = {},
): NativeGatewayConnectAuth {
  // SAFETY: This only adds optional app bridge properties; presence and responses are validated below.
  const host = window as NativeAuthHost;
  const bridge = host.OpenClawNativeGatewayAuth;
  const webkit = host.webkit?.messageHandlers?.OpenClawNativeGatewayAuth;
  const pending = new Map<string, (reply: Record<string, unknown>) => void>();
  const waitingForPort = new Map<string, string>();
  let port: MessagePort | undefined;
  let retired = false;
  const accept = (raw: unknown) => {
    let reply: unknown = raw;
    if (typeof raw === "string") {
      try {
        reply = JSON.parse(raw);
      } catch {
        return;
      }
    }
    if (isRecord(reply) && typeof reply.id === "string") {
      pending.get(reply.id)?.(reply);
    }
  };
  if (bridge) {
    // AndroidX WebMessageListener exposes a JavaScriptReplyProxy, not an EventTarget.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    bridge.onmessage = (event) => accept(event.data);
  }
  if (options.messagePort && host.top === host) {
    const receivePort = (event: MessageEvent) => {
      const incomingPort = event.ports[0];
      // Android postWebMessage has no source window or source origin. Ordinary
      // page/iframe postMessage cannot impersonate that native transfer.
      if (
        retired ||
        port ||
        event.source !== null ||
        event.origin !== "" ||
        event.ports.length !== 1 ||
        !incomingPort
      ) {
        return;
      }
      let value: unknown;
      try {
        value = typeof event.data === "string" ? JSON.parse(event.data) : undefined;
      } catch {
        return;
      }
      if (
        !isRecord(value) ||
        value.type !== "openclaw.native-control-auth" ||
        typeof value.gatewayUrl !== "string" ||
        gatewayCredentialScope(value.gatewayUrl) !== gatewayCredentialScope(gatewayUrl)
      ) {
        return;
      }
      port = incomingPort;
      port.addEventListener("message", (reply) => accept(reply.data));
      port.start();
      host.removeEventListener("message", receivePort);
      for (const [id, message] of waitingForPort) {
        try {
          // MessagePort has a fixed peer, not a Window target origin.
          port.postMessage(message);
        } catch (error) {
          accept({ id, error: formatUiError(error) });
        }
      }
      waitingForPort.clear();
    };
    host.addEventListener("message", receivePort);
    host.addEventListener(
      "pagehide",
      () => {
        retired = true;
        host.removeEventListener("message", receivePort);
        port?.close();
        for (const id of pending.keys()) {
          accept({ id, error: "Native dashboard document closed" });
        }
        waitingForPort.clear();
      },
      { once: true },
    );
  }

  return async ({ gatewayUrl: target, nonce, signedAt, signal }) => {
    if (gatewayCredentialScope(target) !== gatewayCredentialScope(gatewayUrl)) {
      throw new Error(
        "This dashboard belongs to a different Gateway. Select the Gateway in the app.",
      );
    }
    if (retired || host.top !== host || (!bridge && !webkit && !options.messagePort)) {
      throw new Error(
        "Native Gateway authorization is unavailable. Reopen this dashboard in the app.",
      );
    }
    // Match the supported native challenge representation before dispatch. A
    // malformed challenge cannot recover when the native connection reconnects.
    if (
      !/[^\p{White_Space}\p{Control}\ufeff]/u.test(nonce) ||
      new TextEncoder().encode(nonce).length > 512 ||
      nonce.includes("|") ||
      !Number.isSafeInteger(signedAt) ||
      signedAt <= 0
    ) {
      throw new Error("The Gateway did not provide a valid native authentication challenge.");
    }
    signal.throwIfAborted();
    const request = { id: generateUUID(), nonce, signedAt };
    return await new Promise<NativeGatewayAuthorization>((resolve, reject) => {
      const finish = (error?: Error, authorization?: NativeGatewayAuthorization) => {
        if (!pending.delete(request.id)) {
          return;
        }
        waitingForPort.delete(request.id);
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error !== undefined) {
          reject(error);
        } else if (authorization) {
          resolve(authorization);
        }
      };
      const abort = () =>
        finish(
          new Error(formatUiError(signal.reason ?? "Native Gateway authorization cancelled.")),
        );
      const timer = setTimeout(
        () =>
          finish(
            new NativeGatewayAuthUnavailableError(
              "The app did not authorize this dashboard in time. Reconnect in the app.",
            ),
          ),
        // Leave half the preauth budget for sending the signed connect and receiving hello.
        DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS / 2,
      );
      pending.set(request.id, (reply) => {
        try {
          if (typeof reply.error === "string") {
            throw new NativeGatewayAuthUnavailableError(reply.error);
          }
          finish(undefined, readAuthorization(reply.result, request));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(formatUiError(error)));
        }
      });
      signal.addEventListener("abort", abort, { once: true });
      try {
        // Native app bridges are not Window.postMessage; their host owns origin checks.
        let result: void | Promise<unknown> = undefined;
        if (bridge) {
          // oxlint-disable-next-line unicorn/require-post-message-target-origin
          result = bridge.postMessage(JSON.stringify(request));
        } else if (webkit) {
          // oxlint-disable-next-line unicorn/require-post-message-target-origin
          result = webkit.postMessage(request);
        } else if (port) {
          port.postMessage(JSON.stringify(request));
        } else {
          waitingForPort.set(request.id, JSON.stringify(request));
        }
        if (result) {
          void result.then(accept, (error: unknown) =>
            finish(new NativeGatewayAuthUnavailableError(formatUiError(error))),
          );
        }
      } catch (error) {
        finish(new NativeGatewayAuthUnavailableError(formatUiError(error)));
      }
    });
  };
}
