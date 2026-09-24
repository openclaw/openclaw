// Defines hook configuration matching and command types.
import type { z } from "zod";
import type { InstallRecordBase } from "./types.installs.js";
import type {
  HookMappingConfigInput,
  HooksGmailConfigInput,
  InternalHooksConfigInput,
} from "./zod-schema.hooks.js";
import type { OpenClawSchemaShape } from "./zod-schema.root-shape.js";

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

type HooksSchemaInput = NonNullable<z.input<typeof OpenClawSchemaShape.hooks>>;

export type HooksConfig = Omit<HooksSchemaInput, "mappings"> & {
  mappings?: HookMappingConfig[];
};
