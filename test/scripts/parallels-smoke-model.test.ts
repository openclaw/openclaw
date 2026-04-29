import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const OS_SCRIPT_PATHS = [
  "scripts/e2e/parallels-linux-smoke.sh",
  "scripts/e2e/parallels-macos-smoke.sh",
  "scripts/e2e/parallels-windows-smoke.sh",
];
const NPM_UPDATE_SCRIPT_PATH = "scripts/e2e/parallels-npm-update-smoke.sh";
const WORKSPACE_SEED_HELPER_PATH = "scripts/e2e/lib/parallels-package-common.sh";

function readWorkspaceSeedSurface(script: string): string {
  const helper = existsSync(WORKSPACE_SEED_HELPER_PATH)
    ? readFileSync(WORKSPACE_SEED_HELPER_PATH, "utf8")
    : "";
  return `${script}\n${helper}`;
}

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
      const seedSurface = readWorkspaceSeedSurface(script);

      expect(seedSurface, scriptPath).toContain("workspace-state.json");
      expect(seedSurface, scriptPath).toContain("IDENTITY.md");
      expect(seedSurface, scriptPath).toContain("BOOTSTRAP.md");
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
});
