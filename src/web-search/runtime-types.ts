import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";

// Shared web_search runtime contracts. Keep these in a types-only module so
// provider registries and callers can import them without loading runtime code.
export type RuntimeWebSearchConfig = NonNullable<
  NonNullable<OpenClawConfig["tools"]>["web"]
>["search"];

export type ResolveWebSearchDefinitionParams = {
  config?: OpenClawConfig;
  agentDir?: string;
  sandboxed?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  providerId?: string;
  preferRuntimeProviders?: boolean;
  preferInputConfig?: boolean;
};

export type RunWebSearchParams = ResolveWebSearchDefinitionParams & {
  args: Record<string, unknown>;
  signal?: AbortSignal;
  /** Caller-owned synchronous authority check, repeated immediately before external requests. */
  assertCurrent?: () => void;
};

export type RunWebSearchResult = {
  provider: string;
  result: Record<string, unknown>;
};
