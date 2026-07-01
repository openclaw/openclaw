/**
 * Config types for provider HTTP transport overrides.
 * Values that can carry credentials use SecretInput so redaction and secret refs stay consistent.
 */
import type { SecretInput } from "./types.secrets.js";

/** Authentication override applied to provider requests after model/provider defaults resolve. */
export type ConfiguredProviderRequestAuth =
  | {
      mode: "provider-default";
    }
  | {
      mode: "authorization-bearer";
      token: SecretInput;
    }
  | {
      mode: "header";
      headerName: string;
      value: SecretInput;
      prefix?: string;
    };

/** TLS material and verification knobs for provider or proxy connections. */
export type ConfiguredProviderRequestTls = {
  ca?: SecretInput;
  cert?: SecretInput;
  key?: SecretInput;
  passphrase?: SecretInput;
  serverName?: string;
  insecureSkipVerify?: boolean;
};

/** Proxy selection for provider requests, including optional TLS settings for proxy transport. */
export type ConfiguredProviderRequestProxy =
  | {
      mode: "env-proxy";
      tls?: ConfiguredProviderRequestTls;
    }
  | {
      mode: "explicit-proxy";
      url: string;
      tls?: ConfiguredProviderRequestTls;
    };

/** Shared provider request overrides used by model providers and media/tool providers. */
export type ConfiguredProviderRequest = {
  headers?: Record<string, SecretInput>;
  auth?: ConfiguredProviderRequestAuth;
  proxy?: ConfiguredProviderRequestProxy;
  tls?: ConfiguredProviderRequestTls;
};

export type ConfiguredModelProviderRateLimit = {
  /** Maximum provider requests admitted per rolling minute. */
  requestsPerMinute?: number;
  /** Minimum delay between admitted requests for this provider/model bucket. */
  minIntervalMs?: number;
  /** Maximum locally queued requests waiting for this bucket. */
  maxQueueSize?: number;
};

/** Model-provider request overrides plus model-transport policy knobs. */
export type ConfiguredModelProviderRequest = ConfiguredProviderRequest & {
  allowPrivateNetwork?: boolean;
  rateLimit?: ConfiguredModelProviderRateLimit;
};
