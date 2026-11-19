// Published plugins link these named imports from JavaScript-only SDK facades; a missing
// name fails ESM linking and the whole plugin fails to load (#173386).
import { readFileSync } from "node:fs";
import { readApprovalReactionDeliveryMetadata } from "openclaw/plugin-sdk/approval-reaction-runtime";
import { describe, expect, it } from "vitest";
import { packagedPrivatePluginSdkRuntimeEntrypoints } from "../../scripts/lib/plugin-sdk-entries.mts";
import { PLUGIN_SDK_PRIVATE_RUNTIME_EXPORT_COMPAT_RECORD } from "../plugins/compat/plugin-sdk-private-runtime-export-record.js";

const SURFACE_PREFIX = "openclaw/plugin-sdk/";

/** Runtime value exports declared directly by a facade; type-only exports never link at runtime. */
function readFacadeValueExports(subpath: string): Set<string> {
  const source = readFileSync(new URL(`./${subpath}.ts`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "");
  const names = new Set<string>();
  for (const match of source.matchAll(/\bexport\s*\{([^}]*)\}/gu)) {
    for (const segment of (match[1] ?? "").split(",")) {
      const name = segment.trim().match(/^(?!type\s)(?:[\w$]+\s+as\s+)?([\w$]+)$/u)?.[1];
      if (name) {
        names.add(name);
      }
    }
  }
  for (const match of source.matchAll(/\bexport\s+(?:async\s+)?(?:function|const)\s+([\w$]+)/gu)) {
    names.add(match[1] ?? "");
  }
  return names;
}

describe("shipped private runtime facade exports", () => {
  it("keeps every recorded surface exported from its packaged subpath", () => {
    const packaged = new Set(packagedPrivatePluginSdkRuntimeEntrypoints);
    const missing = PLUGIN_SDK_PRIVATE_RUNTIME_EXPORT_COMPAT_RECORD.surfaces.filter((surface) => {
      const qualified = surface.slice(SURFACE_PREFIX.length);
      const dot = qualified.lastIndexOf(".");
      const subpath = qualified.slice(0, dot);
      return (
        !packaged.has(subpath) || !readFacadeValueExports(subpath).has(qualified.slice(dot + 1))
      );
    });
    expect(missing).toStrictEqual([]);
  });

  it("reads approval delivery metadata through the approval-reaction-runtime package subpath", () => {
    expect(
      readApprovalReactionDeliveryMetadata({
        channelData: {
          execApproval: {
            approvalId: "req-1",
            approvalSlug: "req-1",
            approvalKind: "exec",
            allowedDecisions: ["allow-once", "deny"],
          },
        },
      }),
    ).toEqual({
      approvalId: "req-1",
      approvalKind: "exec",
      allowedDecisions: ["allow-once", "deny"],
      approvalSlug: "req-1",
    });
    expect(readApprovalReactionDeliveryMetadata({ text: "no metadata" })).toBeNull();
  });
});
