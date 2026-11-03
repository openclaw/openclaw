import type { ConfigUiHint } from "../../shared/config-ui-hints-types.js";
import type { JsonSchemaObject } from "../../shared/json-schema.types.js";

/** Optional UI metadata for a JSON Schema property. */
export type ChannelConfigUiHint = Pick<
  ConfigUiHint,
  | "label"
  | "help"
  | "tags"
  | "advanced"
  | "sensitive"
  | "placeholder"
  | "presentation"
  | "itemTemplate"
>;

/** Normalized validation issue emitted by a channel runtime parser. */
export type ChannelConfigRuntimeIssue = {
  path?: Array<string | number>;
  message?: string;
  code?: string;
} & Record<string, unknown>;

/** Runtime validator contract paired with the JSON Schema config surface. */
export type ChannelConfigRuntimeSchema = {
  safeParse: (value: unknown) =>
    | {
        success: true;
        data: unknown;
      }
    | {
        success: false;
        issues: ChannelConfigRuntimeIssue[];
      };
};

/** Complete channel config schema description exposed to host tooling. */
export type ChannelConfigSchema = {
  schema: JsonSchemaObject;
  uiHints?: Record<string, ChannelConfigUiHint>;
  runtime?: ChannelConfigRuntimeSchema;
};
