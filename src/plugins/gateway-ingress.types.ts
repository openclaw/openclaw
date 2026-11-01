/** A failure to admit remote Control UI transport through the host. */
export type GatewayControlUiIngressErrorCode =
  | "unsupported-auth"
  | "invalid-options"
  | "unavailable"
  | "closed"
  | "limit-exceeded"
  | "forbidden";

export class GatewayControlUiIngressError extends Error {
  readonly code: GatewayControlUiIngressErrorCode;

  constructor(code: GatewayControlUiIngressErrorCode, message: string) {
    super(message);
    this.name = "GatewayControlUiIngressError";
    this.code = code;
  }
}

export type GatewayIngressPrincipal = { kind: "owner" } | { kind: "person"; profileId: string };

/** The plugin owns consent, expiry, persistence, and revocation of this exact grant. */
export type GatewayIngressPrincipalOptionsV1 = {
  audienceId: string;
  principal: GatewayIngressPrincipal;
  operatorScopeCeiling: readonly string[];
  signal: AbortSignal;
  assertCurrent: () => void;
};

export type GatewayControlUiIngressPresentationOptionsV1 = {
  publicOrigin: string;
  sandboxOrigin: string;
  frameAncestors: readonly string[];
};

export type GatewayControlUiIngressOpenOptionsV2 = GatewayIngressPrincipalOptionsV1 &
  GatewayControlUiIngressPresentationOptionsV1;

export type GatewayIngressRequestOptionsV1 = { signal?: AbortSignal };

/** One live principal resolution shared by RPC and any Control UI transport it opens. */
export interface GatewayIngressPrincipalBindingV1 {
  request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    options?: GatewayIngressRequestOptionsV1,
  ): Promise<T>;
  openControlUi(
    options: GatewayControlUiIngressPresentationOptionsV1,
  ): Promise<GatewayControlUiIngressV2>;
  close(): Promise<void>;
}

/** Versioned principal-bound ingress supplied by an admitted plugin service. */
export interface GatewayControlUiIngressFactoryV2 {
  readonly capabilityVersion: 2;
  open(options: GatewayControlUiIngressOpenOptionsV2): Promise<GatewayControlUiIngressV2>;
  bindPrincipal(
    options: GatewayIngressPrincipalOptionsV1,
  ): Promise<GatewayIngressPrincipalBindingV1>;
}

export type GatewayIngressMessage =
  | { kind: "text"; text: string }
  | { kind: "binary"; bytes: Uint8Array };

export interface GatewayIngressSocketV1 {
  send(message: GatewayIngressMessage): Promise<void>;
  readonly messages: AsyncIterable<GatewayIngressMessage>;
  readonly closed: Promise<{ code: number; reason: string }>;
  close(code?: number, reason?: string): void;
}

export type GatewayControlUiIngressRequestV1 = {
  surface: "control-ui" | "sandbox";
  method: string;
  pathAndQuery: string;
  headers: readonly (readonly [string, string])[];
  body?: ReadableStream<Uint8Array>;
  signal: AbortSignal;
};

export type GatewayControlUiIngressWebSocketRequestV1 = {
  pathAndQuery: string;
  /** Actual browser Origin, matched exactly against this handle's public origin. */
  origin: string;
  protocols: readonly string[];
  signal: AbortSignal;
};

/** Only core-issued signed read grants may be published as plugin cookies. */
export interface GatewayPluginReadCookieV1 {
  name: string;
  value: string;
  path: string;
  maxAgeSeconds: number;
  kind: "native-assets" | "iframe-read";
}

export interface GatewayControlUiIngressV2 {
  readonly presentation: {
    readonly basePath: string;
    readonly publicOrigin: string;
    readonly sandboxOrigin: string;
    readonly operatorScopeCeiling: readonly string[];
  };
  request(input: GatewayControlUiIngressRequestV1): Promise<{
    response: Response;
    pluginReadCookies: readonly GatewayPluginReadCookieV1[];
  }>;
  openWebSocket(input: GatewayControlUiIngressWebSocketRequestV1): Promise<{
    protocol?: string;
    socket: GatewayIngressSocketV1;
  }>;
  requestGateway: GatewayIngressPrincipalBindingV1["request"];
  /** Fence admission and abort transport; effect and publication guards reject stale work. */
  close(): Promise<void>;
}
