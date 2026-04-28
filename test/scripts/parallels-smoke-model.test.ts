import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const OS_SCRIPT_PATHS = [
  "scripts/e2e/parallels-linux-smoke.sh",
  "scripts/e2e/parallels-macos-smoke.sh",
  "scripts/e2e/parallels-windows-smoke.sh",
];
const NPM_UPDATE_SCRIPT_PATH = "scripts/e2e/parallels-npm-update-smoke.sh";

describe("Parallels smoke model selection", () => {
  it("keeps the OpenAI smoke lane on the stable direct API model by default", () => {
    for (const scriptPath of [...OS_SCRIPT_PATHS, NPM_UPDATE_SCRIPT_PATH]) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script, scriptPath).toContain(
        'MODEL_ID="${OPENCLAW_PARALLELS_OPENAI_MODEL:-openai/gpt-5.5}"',
      );
      expect(script, scriptPath).toContain("--model <provider/model>");
      expect(script, scriptPath).toContain("MODEL_ID_EXPLICIT=1");
    }
  });

  it("seeds agent workspace state before OS smoke agent turns", () => {
    for (const scriptPath of OS_SCRIPT_PATHS) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script, scriptPath).toContain("workspace-state.json");
      expect(script, scriptPath).toContain("IDENTITY.md");
      expect(script, scriptPath).toContain("BOOTSTRAP.md");
      expect(script, scriptPath).toMatch(/--session-id\s+['"]?parallels-/);
      expect(script, scriptPath).toContain("agents.defaults.skipBootstrap true --strict-json");
    }
  });

  it("passes aggregate model overrides into each OS fresh lane", () => {
    const script = readFileSync(NPM_UPDATE_SCRIPT_PATH, "utf8");

    expect(script).toMatch(/parallels-macos-smoke\.sh"[\s\S]*?--model "\$MODEL_ID"/);
    expect(script).toMatch(/parallels-windows-smoke\.sh"[\s\S]*?--model "\$MODEL_ID"/);
    expect(script).toMatch(/parallels-linux-smoke\.sh"[\s\S]*?--model "\$MODEL_ID"/);
  });

  it("disables Bonjour by default for the standalone Linux gateway smoke", () => {
    const script = readFileSync("scripts/e2e/parallels-linux-smoke.sh", "utf8");

    expect(script).toContain("DISABLE_BONJOUR_FOR_GATEWAY=1");
    expect(script).toContain("OPENCLAW_DISABLE_BONJOUR=1");
  });

  it("lets the macOS gateway status probe use the full phase budget", () => {
    const script = readFileSync("scripts/e2e/parallels-macos-smoke.sh", "utf8");

    expect(script).toContain("deadline=$((SECONDS + TIMEOUT_GATEWAY_S))");
    expect(script).toContain("gateway probe");
    expect(script).toContain("--url ws://127.0.0.1:18789");
    expect(script).toContain("gateway status --deep --require-rpc --timeout 30000");
  });

  it("runs the macOS agent turn through the logged guest runner", () => {
    const script = readFileSync("scripts/e2e/parallels-macos-smoke.sh", "utf8");

    expect(script).toContain('agent_log="/tmp/openclaw-parallels-agent-turn.log"');
    expect(script).toContain("run_logged_guest_current_user_sh");
    expect(script).toContain("retrying macOS agent turn after staged runtime mirror race");
  });

  it("keeps the Windows first agent turn patient enough for cold package startup", () => {
    const script = readFileSync("scripts/e2e/parallels-windows-smoke.sh", "utf8");

    expect(script).toContain(
      'TIMEOUT_AGENT_S="${OPENCLAW_PARALLELS_WINDOWS_AGENT_TIMEOUT_S:-1500}"',
    );
  });
});
