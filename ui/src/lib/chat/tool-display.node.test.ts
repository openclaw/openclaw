// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolveToolDisplayIcon } from "./tool-display-icon.ts";
import { formatToolDetail, resolveEmbedSandbox, resolveToolDisplay } from "./tool-display.ts";

describe("tool display", () => {
  it("shares semantic icons across compact and full tool displays", () => {
    for (const { name, icon } of [
      { name: " EXEC ", icon: "squareTerminal" },
      { name: "web_search", icon: "search" },
      { name: "read", icon: "fileText" },
      { name: "unknown_tool", icon: "puzzle" },
      { name: "constructor", icon: "puzzle" },
    ]) {
      expect(resolveToolDisplayIcon(name)).toBe(icon);
      expect(resolveToolDisplay({ name }).icon).toBe(icon);
    }
  });

  it.each([
    {
      name: "trimmed action with a false first detail",
      params: {
        name: "browser",
        args: { action: " dialog ", accept: false, promptText: "not selected" },
      },
      detail: "with false",
    },
    {
      name: "redacted unknown-tool fallback",
      params: { name: "unknown_tool", args: { path: "AKIDABCDEFGHIJKLMNOP1234567890" } },
      detail: ["with AKIDAB…7890", "with AKIDAB...7890"],
    },
    {
      name: "raw command detail",
      params: {
        name: "exec",
        args: { command: "cd ~/my-project && npm install" },
        detailMode: "raw",
      },
      detail: "with install dependencies (in ~/my-project), `cd ~/my-project && npm install`",
    },
    {
      name: "explained command detail",
      params: {
        name: "exec",
        args: { command: "cd ~/my-project && npm install" },
        detailMode: "explain",
      },
      detail: "with install dependencies (in ~/my-project)",
    },
  ] as const)("preserves $name", ({ params, detail }) => {
    const display = resolveToolDisplay(params);
    const formatted = formatToolDetail(display);
    if (Array.isArray(detail)) {
      // Core uses a Unicode ellipsis; the browser alias uses three dots.
      expect(detail).toContain(formatted);
      expect(formatted).not.toContain("AKIDABCDEFGHIJKLMNOP1234567890");
    } else {
      expect(formatted).toBe(detail);
    }
  });
});

describe("resolveEmbedSandbox", () => {
  it("caps a trusted global sandbox at scripts-only for isolated previews", () => {
    expect(resolveEmbedSandbox("trusted", "scripts")).toBe("allow-scripts");
    expect(resolveEmbedSandbox("scripts", "scripts")).toBe("allow-scripts");
    expect(resolveEmbedSandbox("strict", "scripts")).toBe("");
  });

  it("preserves existing behavior when a preview has no sandbox ceiling", () => {
    expect(resolveEmbedSandbox("trusted")).toBe("allow-scripts allow-same-origin");
  });
});
