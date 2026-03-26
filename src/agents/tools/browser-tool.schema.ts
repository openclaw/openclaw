import { Type } from "@sinclair/typebox";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";

const BROWSER_ACT_KINDS = [
  "click",
  "type",
  "press",
  "hover",
  "drag",
  "select",
  "fill",
  "resize",
  "wait",
  "evaluate",
  "close",
] as const;

const BROWSER_TOOL_ACTIONS = [
  "status",
  "start",
  "stop",
  "profiles",
  "tabs",
  "open",
  "focus",
  "close",
  "snapshot",
  "screenshot",
  "navigate",
  "console",
  "pdf",
  "upload",
  "dialog",
  "act",
] as const;

const BROWSER_TARGETS = ["sandbox", "host", "node"] as const;

const BROWSER_SNAPSHOT_FORMATS = ["aria", "ai"] as const;
const BROWSER_SNAPSHOT_MODES = ["efficient"] as const;
const BROWSER_SNAPSHOT_REFS = ["role", "aria"] as const;

const BROWSER_IMAGE_TYPES = ["png", "jpeg"] as const;

// NOTE: Using a flattened object schema instead of Type.Union([Type.Object(...), ...])
// because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
// The discriminator (kind) determines which properties are relevant; runtime validates.
const BrowserActSchema = Type.Object({
  kind: stringEnum(BROWSER_ACT_KINDS),
  // Common fields
  targetId: Type.Optional(Type.String()),
  ref: Type.Optional(Type.String()),
  // click
  doubleClick: Type.Optional(Type.Boolean()),
  button: Type.Optional(Type.String()),
  modifiers: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
  // type
  text: Type.Optional(Type.String()),
  submit: Type.Optional(Type.Boolean()),
  slowly: Type.Optional(Type.Boolean()),
  // press
  key: Type.Optional(Type.String()),
  delayMs: Type.Optional(Type.Number({ minimum: 0, maximum: 30_000 })),
  // drag
  startRef: Type.Optional(Type.String()),
  endRef: Type.Optional(Type.String()),
  // select
  values: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
  // fill - use permissive array of objects
  fields: Type.Optional(
    Type.Array(Type.Object({}, { additionalProperties: true }), { maxItems: 50 }),
  ),
  // resize
  width: Type.Optional(Type.Number({ minimum: 1, maximum: 7680 })),
  height: Type.Optional(Type.Number({ minimum: 1, maximum: 4320 })),
  // wait
  timeMs: Type.Optional(Type.Number({ minimum: 0, maximum: 60_000 })),
  selector: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  loadState: Type.Optional(Type.String()),
  textGone: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number({ minimum: 0, maximum: 120_000 })),
  // evaluate
  fn: Type.Optional(Type.String()),
});

// IMPORTANT: OpenAI function tool schemas must have a top-level `type: "object"`.
// A root-level `Type.Union([...])` compiles to `{ anyOf: [...] }` (no `type`),
// which OpenAI rejects ("Invalid schema ... type: None"). Keep this schema an object.
export const BrowserToolSchema = Type.Object({
  action: stringEnum(BROWSER_TOOL_ACTIONS),
  target: optionalStringEnum(BROWSER_TARGETS),
  node: Type.Optional(Type.String()),
  profile: Type.Optional(Type.String()),
  targetUrl: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  targetId: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
  maxChars: Type.Optional(Type.Number({ minimum: 1, maximum: 500_000 })),
  mode: optionalStringEnum(BROWSER_SNAPSHOT_MODES),
  snapshotFormat: optionalStringEnum(BROWSER_SNAPSHOT_FORMATS),
  refs: optionalStringEnum(BROWSER_SNAPSHOT_REFS),
  interactive: Type.Optional(Type.Boolean()),
  compact: Type.Optional(Type.Boolean()),
  depth: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
  selector: Type.Optional(Type.String()),
  frame: Type.Optional(Type.String()),
  labels: Type.Optional(Type.Boolean()),
  fullPage: Type.Optional(Type.Boolean()),
  ref: Type.Optional(Type.String()),
  element: Type.Optional(Type.String()),
  type: optionalStringEnum(BROWSER_IMAGE_TYPES),
  level: Type.Optional(Type.String()),
  paths: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
  inputRef: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number({ minimum: 0, maximum: 120_000 })),
  accept: Type.Optional(Type.Boolean()),
  promptText: Type.Optional(Type.String()),
  // Legacy flattened act params (preferred: request={...})
  kind: Type.Optional(stringEnum(BROWSER_ACT_KINDS)),
  doubleClick: Type.Optional(Type.Boolean()),
  button: Type.Optional(Type.String()),
  modifiers: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
  text: Type.Optional(Type.String()),
  submit: Type.Optional(Type.Boolean()),
  slowly: Type.Optional(Type.Boolean()),
  key: Type.Optional(Type.String()),
  delayMs: Type.Optional(Type.Number({ minimum: 0, maximum: 30_000 })),
  startRef: Type.Optional(Type.String()),
  endRef: Type.Optional(Type.String()),
  values: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
  fields: Type.Optional(
    Type.Array(Type.Object({}, { additionalProperties: true }), { maxItems: 50 }),
  ),
  width: Type.Optional(Type.Number({ minimum: 1, maximum: 7680 })),
  height: Type.Optional(Type.Number({ minimum: 1, maximum: 4320 })),
  timeMs: Type.Optional(Type.Number({ minimum: 0, maximum: 60_000 })),
  textGone: Type.Optional(Type.String()),
  loadState: Type.Optional(Type.String()),
  fn: Type.Optional(Type.String()),
  request: Type.Optional(BrowserActSchema),
});
