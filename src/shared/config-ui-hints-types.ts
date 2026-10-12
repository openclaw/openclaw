import type { ConfigSchemaResponse } from "../../packages/gateway-protocol/src/schema/config.js";

/** Authored groups of immediate object properties; descendants stay with their parent. */
export type ConfigUiGroup = NonNullable<ConfigUiHint["groups"]>[number];

/** UI metadata attached to config schema paths for forms, docs, and redaction policy. */
export type ConfigUiHint = ConfigUiHints[string];

/** Config UI hints keyed by dotted config path, with `*` matching dynamic segments. */
export type ConfigUiHints = ConfigSchemaResponse["uiHints"];
