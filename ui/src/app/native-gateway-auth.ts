import {
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  gatewayCredentialScope,
} from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../i18n/index.ts";
import { formatConnectionError, formatConnectionErrorSummary } from "../lib/connection-error.ts";
import { listen } from "../lib/reactive/listener.ts";
import { generateUUID } from "../lib/uuid.ts";
import type { NativeGatewayAuthorization } from "./native-gateway-authorization.ts";

export type NativeGatewayConnectAuth = {
  (challenge: {
    gatewayUrl: string;
    nonce: string;
    signedAt: number;
    signal: AbortSignal;
  }): Promise<NativeGatewayAuthorization>;
  enrollProfile?: (
    params: import("../api/gateway-profile-enrollment.ts").ProfileEnrollmentParams,
    signal: AbortSignal,
  ) => Promise<NativeProfileEnrollmentResult>;
};
export type NativeProfileEnrollmentResult = {
  deviceId: string;
  profileId: string;
  reconnect: boolean;
};
type EnrollmentMessage = {
  id: string;
  action: "enrollProfile";
  params: import("../api/gateway-profile-enrollment.ts").ProfileEnrollmentParams;
};

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
      OpenClawNativeGatewayAuth?: {
        postMessage(message: ChallengeMessage | EnrollmentMessage): Promise<unknown>;
      };
    };
  };
};

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
  let stopPortMessage: (() => void) | undefined;
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
      stopPortMessage = listen(port, "message", (reply) => accept(reply.data));
      port.start();
      stopPortHandshake();
      for (const [id, message] of waitingForPort) {
        try {
          // MessagePort has a fixed peer, not a Window target origin.
          port.postMessage(message);
        } catch (error) {
          void formatConnectionError(error).then((detail) => accept({ id, error: detail }));
        }
      }
      waitingForPort.clear();
    };
    const stopPortHandshake = listen(host, "message", receivePort);
    listen(
      host,
      "pagehide",
      () => {
        retired = true;
        stopPortHandshake();
        stopPortMessage?.();
        port?.close();
        for (const id of pending.keys()) {
          accept({ id, error: t("runtimeErrors.nativeClosed") });
        }
        waitingForPort.clear();
      },
      { once: true },
    );
  }

  const authorize: NativeGatewayConnectAuth = async ({
    gatewayUrl: target,
    nonce,
    signedAt,
    signal,
  }) => {
    const [{ registerLocalErrorsEnglish }, { readAuthorization }] = await Promise.all([
      import("../i18n/locales/en-local-errors.ts"),
      import("./native-gateway-authorization.ts"),
    ]);
    // This owner publishes resolved error text after registration, not reactive catalog reads.
    registerLocalErrorsEnglish();
    if (gatewayCredentialScope(target) !== gatewayCredentialScope(gatewayUrl)) {
      throw new Error(t("runtimeErrors.nativeGateway"));
    }
    // send owns current document/bridge admission at the effect; no awaited work follows validation.
    // Match the supported native challenge representation before dispatch. A
    // malformed challenge cannot recover when the native connection reconnects.
    if (
      !/[^\p{White_Space}\p{Control}\ufeff]/u.test(nonce) ||
      new TextEncoder().encode(nonce).length > 512 ||
      nonce.includes("|") ||
      !Number.isSafeInteger(signedAt) ||
      signedAt <= 0
    ) {
      throw new Error(t("runtimeErrors.nativeChallenge"));
    }
    const request = { id: generateUUID(), nonce, signedAt };
    return send(request, signal, (value) => readAuthorization(value, request));
  };
  authorize.enrollProfile = async (params, signal) => {
    const { enrollNativeProfile } = await import("./native-profile-enrollment.ts");
    return enrollNativeProfile(send, params, signal);
  };
  return authorize;

  function send<T>(
    request: ChallengeMessage | EnrollmentMessage,
    signal: AbortSignal,
    readResult: (value: unknown) => T,
  ): Promise<T> {
    if (retired || host.top !== host || (!bridge && !webkit && !options.messagePort)) {
      throw new Error(t("runtimeErrors.nativeUnavailable"));
    }
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const finish = (error?: Error, authorization?: T) => {
        if (!pending.delete(request.id)) {
          return;
        }
        waitingForPort.delete(request.id);
        clearTimeout(timer);
        stopAbort();
        if (error !== undefined) {
          reject(error);
        } else if (authorization) {
          resolve(authorization);
        }
      };
      const failBridge = (error: unknown) =>
        formatConnectionError(error).then((message) =>
          finish(new NativeGatewayAuthUnavailableError(message, { cause: error })),
        );
      const abort = () =>
        finish(
          new Error(
            formatConnectionErrorSummary(
              signal.reason ?? "Native Gateway authorization cancelled.",
            ),
          ),
        );
      const timer = setTimeout(
        () => finish(new NativeGatewayAuthUnavailableError(t("runtimeErrors.nativeTimeout"))),
        // Leave half the preauth budget for sending the signed connect and receiving hello.
        DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS / 2,
      );
      pending.set(request.id, (reply) => {
        try {
          if (typeof reply.error === "string") {
            throw new NativeGatewayAuthUnavailableError(reply.error);
          }
          finish(undefined, readResult(reply.result));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(formatConnectionErrorSummary(error)));
        }
      });
      const stopAbort = listen(signal, "abort", abort, { once: true });
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
          void result.then(accept, failBridge);
        }
      } catch (error) {
        void failBridge(error);
      }
    });
  }
}
