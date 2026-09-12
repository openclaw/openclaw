// Defines hook configuration matching and command types.
import type { InstallRecordBase } from "./types.installs.js";
import type {
  HookMappingConfigInput,
  HooksGmailConfigInput,
  InternalHooksConfigInput,
} from "./zod-schema.hooks.js";

export type HookMappingConfig = Omit<HookMappingConfigInput, "channel"> & {
  /** Preserve channel-id autocomplete while allowing runtime plugin channels. */
  channel?: "last" | (string & {});
};

export type HookMappingMatch = NonNullable<HookMappingConfigInput["match"]>;
export type HookMappingTransform = NonNullable<HookMappingConfigInput["transform"]>;
export type HookSessionMode = NonNullable<HookMappingConfigInput["sessionMode"]>;
export type HooksGmailConfig = HooksGmailConfigInput;
export type HooksGmailTailscaleMode = NonNullable<
  NonNullable<HooksGmailConfigInput["tailscale"]>["mode"]
>;
export type HookConfig = NonNullable<NonNullable<InternalHooksConfigInput["entries"]>[string]>;

export type HookInstallRecord = InstallRecordBase & {
  hooks?: string[];
};

export type InternalHooksConfig = InternalHooksConfigInput;

export type HooksConfig = {
  enabled?: boolean;
  path?: string;
  token?: string;
  /**
   * Default session key used for hook agent runs when no request/mapping session key is used.
   * If omitted, OpenClaw generates `hook:<uuid>` per request.
   */
  defaultSessionKey?: string;
  /**
   * Allow `sessionKey` from external `/hooks/agent` and `/hooks/wake` request payloads.
   * Default: false.
   */
  allowRequestSessionKey?: boolean;
  /**
   * Optional allowlist for explicit session keys (request + mapping). Example: ["hook:"].
   * Empty/omitted means no prefix restriction.
   */
  allowedSessionKeyPrefixes?: string[];
  /**
   * Restrict hook execution to these effective agent ids, including
   * default-agent routing when `agentId` is omitted. Omit or include `*` to
   * allow any agent. Set `[]` to deny all agent routing.
   */
  allowedAgentIds?: string[];
  presets?: string[];
  transformsDir?: string;
  mappings?: HookMappingConfig[];
  gmail?: HooksGmailConfig;
  /** Internal agent event hooks */
  internal?: InternalHooksConfig;
};
