import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/e2e/parallels-npm-update-smoke.sh";

describe("parallels npm update smoke", () => {
  it("does not leave guard/server children attached to the wrapper", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('wait "$SERVER_PID" 2>/dev/null || true');
    expect(script).toContain(") >&2 &");
    expect(script).toContain('wait "$pid" 2>/dev/null || true');
  });

  it("scrubs future plugin entries before invoking old same-guest updaters", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("Remove-FuturePluginEntries");
    expect(script).toContain("scrub_future_plugin_entries");
    expect(script).toContain('"feishu", "whatsapp"');
    expect(script).toContain("Remove-FuturePluginEntries\n  Stop-OpenClawGatewayProcesses");
    expect(script).toContain("scrub_future_plugin_entries\nstop_openclaw_gateway_processes");
  });
});
