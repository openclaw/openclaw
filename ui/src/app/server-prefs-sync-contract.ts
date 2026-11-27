import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { RuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import type { ServerUiPrefs } from "./server-prefs-state.ts";

// Contracts shared by the eager owner and deferred operations.
export type ServerUiPrefsWriter = Pick<
  RuntimeConfigCapability,
  "canPatch" | "runExternalMutation"
> & {
  readonly state: {
    readonly client: GatewayBrowserClient | null;
    readonly connected: boolean;
    readonly configSnapshot?: { readonly config?: unknown } | null;
  };
};
export type ServerUiPrefsCommit = { needsRefresh: boolean; retainedLocal?: boolean };

export type ConfirmedPrefsFallback = {
  scope: string;
  raw: string | null;
  prefs: ServerUiPrefs | null;
  dirty: boolean;
};
