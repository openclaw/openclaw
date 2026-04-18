/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import {
  buildMcpAppHostContext,
  resolveMcpAppIframeSandbox,
  resolveMcpAppSandboxMode,
} from "./mcp-app-view.ts";

describe("mcp-app-view helpers", () => {
  it("includes safe host context for MCP Apps", () => {
    const context = buildMcpAppHostContext({
      width: 320,
      height: 600,
    });

    expect(context.toolInfo).toBeUndefined();
    expect(context.displayMode).toBe("inline");
    expect(context.availableDisplayModes).toEqual(["inline"]);
    expect(context.containerDimensions).toMatchObject({ width: 320, height: 600 });
    expect(context.locale).toBeTruthy();
    expect(context.timeZone).toBeTruthy();
  });

  it("never upgrades MCP Apps to trusted sandbox mode", () => {
    expect(resolveMcpAppSandboxMode("trusted")).toBe("scripts");
    expect(resolveMcpAppSandboxMode("scripts")).toBe("scripts");
    expect(resolveMcpAppSandboxMode("strict")).toBe("strict");
  });

  it("does not grant popup permissions to MCP App iframes", () => {
    expect(resolveMcpAppIframeSandbox("trusted")).toBe("allow-scripts allow-forms");
    expect(resolveMcpAppIframeSandbox("scripts")).toBe("allow-scripts allow-forms");
    expect(resolveMcpAppIframeSandbox("strict")).toBe("allow-forms");
  });
});
