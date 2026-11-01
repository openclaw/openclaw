import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import SHARED_TOOL_DISPLAY_JSON from "../../../../apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json" with { type: "json" };
import { unwrapToolCallForDisplay } from "../../../../src/agents/tool-display-call.js";
import {
  resolveToolDetailForArgs,
  type ToolDisplaySpec,
} from "../../../../src/agents/tool-display-common.js";
import type { ToolDetailMode } from "../../../../src/agents/tool-display-exec.js";
import { resolveToolDisplayIdentity } from "./tool-display-identity.ts";

type ToolDisplay = {
  name: string;
  icon: ReturnType<typeof resolveToolDisplayIdentity>["icon"];
  label: string;
  detail?: string;
};

const FALLBACK = SHARED_TOOL_DISPLAY_JSON.fallback;
const TOOL_MAP: Record<string, ToolDisplaySpec> = SHARED_TOOL_DISPLAY_JSON.tools;

function shortenHomeInString(input: string): string {
  // Browser-safe home shortening: avoid importing Node-only helpers (keeps Vite builds working in Docker/CI).
  return input
    .replace(/^\/(?:Users|home)\/[^/]+(\/|$)/, "~$1")
    .replace(/^[A-Za-z]:\\Users\\[^\\]+(\\|$)/i, "~$1");
}

export function resolveToolDisplay(params: {
  name?: string;
  args?: unknown;
  detailMode?: ToolDetailMode;
}): ToolDisplay {
  const call = unwrapToolCallForDisplay({ name: params.name, args: params.args });
  const { name, label, icon } = resolveToolDisplayIdentity(call.name);
  const key = normalizeLowercaseStringOrEmpty(name);
  const spec = TOOL_MAP[key];
  let detail = resolveToolDetailForArgs({
    toolKey: key,
    args: call.args,
    spec,
    fallbackDetailKeys: FALLBACK.detailKeys,
    detailMode: "first",
    toolDetailMode: params.detailMode,
    detailCoerce: { includeFalsy: true },
  });

  if (detail) {
    detail = shortenHomeInString(detail);
  }

  return {
    name,
    icon,
    label,
    detail,
  };
}

export function formatToolDetail(display: ToolDisplay): string | undefined {
  return display.detail ? `with ${display.detail}` : undefined;
}
