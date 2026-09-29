// Defines browser profile configuration types.

import type { z } from "zod";
import type { SsrFPolicyConfig } from "./types.ssrf.js";
import type { OpenClawSchemaShape } from "./zod-schema.root-shape.js";

type BrowserSchemaInput = NonNullable<z.input<typeof OpenClawSchemaShape.browser>>;

export type BrowserProfileConfig = NonNullable<BrowserSchemaInput["profiles"]>[string] & {
  /** @deprecated Doctor-only legacy input; canonical schema rejects this field. */
  color?: string;
};

export type BrowserSnapshotDefaults = NonNullable<BrowserSchemaInput["snapshotDefaults"]>;

export type BrowserTabCleanupConfig = NonNullable<BrowserSchemaInput["tabCleanup"]>;

export type BrowserExtensionRelayConfig = NonNullable<BrowserSchemaInput["extensionRelay"]>;

export type BrowserSsrFPolicyConfig = SsrFPolicyConfig;

export type BrowserConfig = Omit<BrowserSchemaInput, "profiles" | "ssrfPolicy"> & {
  /** @deprecated Doctor-only legacy input; canonical schema rejects this field. */
  color?: string;
  /** Named browser profiles with explicit CDP ports or URLs. */
  profiles?: Record<string, BrowserProfileConfig>;
  /** SSRF policy for browser navigation/open-tab operations. */
  ssrfPolicy?: BrowserSsrFPolicyConfig;
};
