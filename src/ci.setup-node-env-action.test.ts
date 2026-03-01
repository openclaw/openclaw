import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type ActionStep = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
  "continue-on-error"?: boolean;
};

type CompositeAction = {
  runs?: {
    using?: string;
    steps?: ActionStep[];
  };
};

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const setupNodeEnvActionPath = resolve(repoRoot, ".github/actions/setup-node-env/action.yml");

function findStep(steps: ActionStep[], name: string): ActionStep {
  const step = steps.find((entry) => entry.name === name);
  expect(step, `missing step "${name}" in setup-node-env action`).toBeDefined();
  return step as ActionStep;
}

describe("setup-node-env composite action bun hardening", () => {
  it("retries and falls back when setup-bun fails", async () => {
    const raw = await readFile(setupNodeEnvActionPath, "utf8");
    const action = parse(raw) as CompositeAction;

    expect(action.runs?.using).toBe("composite");
    const steps = action.runs?.steps ?? [];

    const primary = findStep(steps, "Setup Bun (primary)");
    expect(primary.id).toBe("setup_bun_primary");
    expect(primary.uses).toBe("oven-sh/setup-bun@v2");
    expect(primary["continue-on-error"]).toBe(true);
    expect(primary.with?.["bun-version"]).toBe("1.3.9+cf6cdbbba");
    expect(primary.with?.token).toBe("${{ github.token }}");

    const retry = findStep(steps, "Setup Bun (retry)");
    expect(retry.id).toBe("setup_bun_retry");
    expect(retry.uses).toBe("oven-sh/setup-bun@v2");
    expect(retry["continue-on-error"]).toBe(true);
    expect(retry.if).toContain("steps.setup_bun_primary.outcome == 'failure'");
    expect(retry.with?.token).toBe("${{ github.token }}");

    const fallback = findStep(steps, "Setup Bun (fallback via npm)");
    expect(fallback.if).toContain("steps.setup_bun_primary.outcome == 'failure'");
    expect(fallback.if).toContain("steps.setup_bun_retry.outcome == 'failure'");
    expect(fallback.run).toContain("npm install -g bun@1.3.9+cf6cdbbba");

    const verify = findStep(steps, "Verify Bun");
    expect(verify.if).toBe("inputs.install-bun == 'true'");
    expect(verify.run).toContain("command -v bun");
    expect(verify.run).toContain("Bun setup failed after retry and fallback.");
  });
});
