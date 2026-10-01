/**
 * Config types for provider HTTP transport overrides.
 * Values that can carry credentials use SecretInput so redaction and secret refs stay consistent.
 */
import type { z } from "zod";
import type { ModelsConfigSchema } from "./zod-schema.core.js";

type ModelProvidersInput = NonNullable<
  NonNullable<z.input<typeof ModelsConfigSchema>>["providers"]
>;

/** Model-provider request overrides plus the private-network opt-in used by model transports. */
export type ConfiguredModelProviderRequest = NonNullable<ModelProvidersInput[string]["request"]>;

/** Shared provider request overrides used by model providers and media/tool providers. */
export type ConfiguredProviderRequest = Omit<ConfiguredModelProviderRequest, "allowPrivateNetwork">;

/** Authentication override applied to provider requests after model/provider defaults resolve. */
export type ConfiguredProviderRequestAuth = NonNullable<ConfiguredProviderRequest["auth"]>;

/** TLS material and verification knobs for provider or proxy connections. */
export type ConfiguredProviderRequestTls = NonNullable<ConfiguredProviderRequest["tls"]>;

/** Proxy selection for provider requests, including optional TLS settings for proxy transport. */
export type ConfiguredProviderRequestProxy = NonNullable<ConfiguredProviderRequest["proxy"]>;
