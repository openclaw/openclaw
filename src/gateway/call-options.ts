import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayCallDeviceAuthOptions } from "./call-device-auth.js";
import type { GatewayClientOptions, GatewayClientRequestOptions } from "./client.js";
import type { OperatorScope } from "./method-scopes.js";

export type GatewayRequestFunction = <T = Record<string, unknown>>(
  method: string,
  params?: unknown,
  opts?: GatewayClientRequestOptions,
) => Promise<T>;

export type CallGatewayBaseOptions = Pick<GatewayClientOptions, "caps"> &
  GatewayCallDeviceAuthOptions & {
    url?: string;
    /** Require this resolved endpoint without overriding target selection or authentication. */
    expectUrl?: string;
    token?: string;
    password?: string;
    tlsFingerprint?: string;
    preauthHandshakeTimeoutMs?: number;
    config?: OpenClawConfig;
    method: string;
    params?: unknown;
    expectFinal?: boolean;
    timeoutMs?: number | null;
    signal?: AbortSignal;
    assertConnectionCurrent?: () => void;
    prepareDispatchCurrent?: () => Promise<void>;
    assertDispatchCurrent?: () => void;
    onAccepted?: GatewayClientRequestOptions["onAccepted"];
    onSignalAbort?: (request: GatewayRequestFunction) => Promise<void> | void;
    /** Continue a multi-request operation on this exact authenticated connection. */
    onResponse?: (request: GatewayRequestFunction, signal: AbortSignal) => Promise<void>;
    clientDisplayName?: string;
    clientVersion?: string;
    platform?: string;
    requiredStoredDeviceAuthScopes?: OperatorScope[];
    /** Keep caller-resolved token/password authoritative, including an empty result. */
    skipImplicitAuth?: boolean;
    onHelloOk?: GatewayClientOptions["onHelloOk"];
    instanceId?: string;
    minProtocol?: number;
    maxProtocol?: number;
    requiredCapabilities?: string[];
    requiredMethods?: string[];
    /**
     * Overrides the config path shown in connection error details.
     * Does not affect config loading; callers still control auth via opts.token/password/env/config.
     */
    configPath?: string;
    /**
     * Explicit local gateway port for command-line overrides such as `gateway health --port`.
     * Bypasses OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_PORT for this call only.
     */
    localPortOverride?: number;
    /** Keep a caller-supplied config target authoritative over OPENCLAW_GATEWAY_URL. */
    ignoreEnvUrlOverride?: boolean;
    /**
     * Service-derived probe target (e.g. custom bind host or Tailnet address).
     * Used as the connection URL without classifying it as a caller URL override,
     * so the explicit-credential guard does not fire.
     */
    serviceTargetUrl?: string;
  };

export type CallGatewayCliOptions = CallGatewayOptions;

export type CallGatewayOptions = CallGatewayBaseOptions & {
  scopes?: OperatorScope[];
};
