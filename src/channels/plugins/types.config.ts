import type { JsonSchemaObject } from "../../shared/json-schema.types.js";

/** Optional UI metadata for one channel config schema path. */
export type ChannelConfigUiHint = {
  /** Human-readable label for forms or docs. */
  label?: string;
  /** Longer help text shown near the field. */
  help?: string;
  /** Lightweight grouping/search tags for config UIs. */
  tags?: string[];
  /** True when the field should be hidden behind advanced controls. */
  advanced?: boolean;
  /** True when the value should be redacted or treated as secret-like. */
  sensitive?: boolean;
  /** Placeholder value for text-like controls. */
  placeholder?: string;
  /** Optional template used by array/object item editors. */
  itemTemplate?: unknown;
};

/** Runtime validation issue normalized from Zod or JSON Schema validators. */
export type ChannelConfigRuntimeIssue = {
  path?: Array<string | number>;
  message?: string;
  code?: string;
} & Record<string, unknown>;

/** Result shape returned by runtime channel config parsers. */
export type ChannelConfigRuntimeParseResult =
  | {
      success: true;
      data: unknown;
    }
  | {
      success: false;
      issues: ChannelConfigRuntimeIssue[];
    };

/** Runtime parser attached to a channel config schema. */
export type ChannelConfigRuntimeSchema = {
  safeParse: (value: unknown) => ChannelConfigRuntimeParseResult;
};

/** Public channel config schema contract exposed through plugin metadata. */
export type ChannelConfigSchema = {
  schema: JsonSchemaObject;
  uiHints?: Record<string, ChannelConfigUiHint>;
  runtime?: ChannelConfigRuntimeSchema;
};
