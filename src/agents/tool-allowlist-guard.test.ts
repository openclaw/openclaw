// Tool allowlist guard tests cover fail-closed behavior when explicit
// allowlists leave no callable tools for the selected runtime/model.
import { describe, expect, it } from "vitest";
import {
  buildEmptyExplicitToolAllowlistError,
  collectExplicitToolAllowlistSources,
} from "./tool-allowlist-guard.js";

describe("tool allowlist guard", () => {
  it.each([
    {
      entries: ["skill_*"],
      toolsEnabled: true,
      disableTools: false,
      expected: "sandboxed run without library-authoring authority",
    },
    {
      entries: ["query_db"],
      toolsEnabled: true,
      disableTools: false,
      expected: "no registered tools matched",
    },
    {
      entries: ["skill_workshop"],
      toolsEnabled: false,
      disableTools: false,
      expected: "selected model does not support tools",
    },
    {
      entries: ["skill_workshop"],
      toolsEnabled: true,
      disableTools: true,
      expected: "tools are disabled for this run",
    },
  ])(
    "reports the relevant gate for $entries (enabled=$toolsEnabled, disabled=$disableTools)",
    ({ entries, toolsEnabled, disableTools, expected }) => {
      const input = {
        sources: [{ label: "runtime toolsAllow", entries, enforceWhenToolsDisabled: true }],
        hasCallableTools: false,
        toolsEnabled,
        disableTools,
        skillWorkshop: { sandboxed: true },
      };
      expect(buildEmptyExplicitToolAllowlistError(input)?.message).toContain(expected);
    },
  );

  it("allows inherited config allowlists when runtime toolsAllow is explicitly empty", () => {
    expect(
      buildEmptyExplicitToolAllowlistError({
        sources: [{ label: "tools.allow", entries: ["*", "read", "cron"] }],
        hasCallableTools: false,
        toolsEnabled: true,
        toolsAllowExplicitlyEmpty: true,
      }),
    ).toBeNull();
  });

  it("still enforces command-time allowlists for explicitly tool-less runs", () => {
    const error = buildEmptyExplicitToolAllowlistError({
      sources: [
        { label: "tools.allow", entries: ["read"] },
        { label: "runtime toolsAllow", entries: ["query_db"], enforceWhenToolsDisabled: true },
      ],
      hasCallableTools: false,
      toolsEnabled: true,
      toolsAllowExplicitlyEmpty: true,
    });

    expect(error?.message).toContain("runtime toolsAllow: query_db");
    expect(error?.message).not.toContain("tools.allow: read");
  });

  it("keeps source labels for config and runtime allowlists", () => {
    const sources = collectExplicitToolAllowlistSources([
      { label: "tools.allow", allow: [" read ", ""] },
      {
        label: "runtime toolsAllow",
        allow: ["query_db"],
        enforceWhenToolsDisabled: true,
      },
      { label: "tools.byProvider.allow" },
    ]);

    expect(sources).toEqual([
      { label: "tools.allow", entries: ["read"] },
      {
        label: "runtime toolsAllow",
        entries: ["query_db"],
        enforceWhenToolsDisabled: true,
      },
    ]);
  });
});
