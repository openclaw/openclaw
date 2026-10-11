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

export type GatewayControlUiIngressOpenOptionsV1 = {
  /** Plugin-owned grant identity; never an OAuth token. */
  audienceId: string;
  publicOrigin: string;
  sandboxOrigin: string;
  operatorScopeCeiling: readonly ("operator.read" | "operator.write")[];
  frameAncestors: readonly string[];
  signal: AbortSignal;
  /** Revalidate the live plugin grant; a signed or unexpired token is insufficient. */
  assertCurrent: () => void;
};

export interface GatewayControlUiIngressFactoryV1 {
  open(options: GatewayControlUiIngressOpenOptionsV1): Promise<GatewayControlUiIngressV1>;
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

export interface GatewayControlUiIngressV1 {
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
  /** Fence admission, abort reads, and wait for owned work to settle. */
  close(): Promise<void>;
}
