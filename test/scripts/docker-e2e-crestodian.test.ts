// Crestodian Docker E2E tests cover packaged-dist harness wiring.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readScript(pathname: string): string {
  return readFileSync(pathname, "utf8");
}

describe("Crestodian Docker E2E scripts", () => {
  it("keeps first-run checks wired to packaged CLI and Crestodian behavior", () => {
    const source = readScript("scripts/e2e/crestodian-first-run-docker-client.ts");
    const spec = readScript("scripts/e2e/crestodian-first-run-spec.json");

    expect(source).toContain("../../dist/cli/run-main.js");
    expect(source).toContain("../../dist/crestodian/crestodian.js");
    expect(source).toContain("shouldHandleBareRoot");
    expect(source).toContain("shouldStartCrestodianForModernOnboard");
    expect(source).toContain('runCli(["node", "openclaw", "onboard"');
    expect(source).toContain("runCrestodian(");
    expect(source).toContain("Config: missing");
    expect(source).toContain("Crestodian first-run Docker E2E passed");
    expect(spec).toContain('"auditOperations"');
    expect(spec).toContain('"crestodian.setup"');
  });

  it("keeps planner fallback checks wired to packaged Crestodian assistant flow", () => {
    const source = readScript("scripts/e2e/crestodian-planner-docker-client.mjs");

    expect(source).toContain("../../dist/crestodian/crestodian.js");
    expect(source).toContain("installFakeClaudeCli");
    expect(source).toContain("claude-cli/claude-opus-4-8");
    expect(source).toContain("Fake Claude planner selected a typed model update.");
    expect(source).toContain("[crestodian] interpreted: set default model openai/gpt-5.2");
    expect(source).toContain("[crestodian] done: config.setDefaultModel");
    expect(source).toContain("OpenClaw docs:");
    expect(source).toContain("Crestodian planner Docker E2E passed");
  });

  it("keeps rescue checks wired through auto-reply command handling", () => {
    const source = readScript("scripts/e2e/crestodian-rescue-docker-client.ts");

    expect(source).toContain("../../dist/auto-reply/reply/commands-crestodian.js");
    expect(source).toContain("../../dist/crestodian/rescue-message.js");
    expect(source).toContain("handleCrestodianCommand(");
    expect(source).toContain("runCrestodianRescueMessage({");
    expect(source).toContain("sandboxing is active");
    expect(source).toContain("cannot open the local TUI");
    expect(source).toContain("[crestodian] done: gateway.restart");
    expect(source).toContain("[crestodian] done: doctor.fix");
    expect(source).toContain("Crestodian rescue Docker E2E passed");
  });
});
