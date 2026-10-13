import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const ASSERT_CONFIG_SCRIPT = "scripts/e2e/lib/onboard/assert-config.mjs";
const WRITE_CONFIG_SCRIPT = "scripts/e2e/lib/onboard/write-config.mjs";
const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function runScript(scriptPath: string, args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env },
  });
}

function writeJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf8"));
}

describe("onboard config fixture helpers", () => {
  it("writes configured guided skip-UI fixtures with a local mock model", () => {
    const root = makeTempDir(tempDirs, "openclaw-onboard-config-guided-");
    const configPath = path.join(root, "openclaw.json");
    const workspace = path.join(root, "workspace");

    const writeResult = runScript(WRITE_CONFIG_SCRIPT, [
      "guided-skip-ui",
      configPath,
      workspace,
      "19091",
    ]);
    const config = readJson(configPath);

    expect(writeResult.status).toBe(0);
    expect(config.gateway).toEqual({
      mode: "local",
      bind: "loopback",
      controlUi: { enabled: false },
    });
    expect(config.agents.defaults.workspace).toBe(workspace);
    expect(config.agents.defaults.model.primary).toBe("openai/gpt-5.6-luna");
    expect(config.models.providers.openai.baseUrl).toBe("http://127.0.0.1:19091/v1");
    expect(config.models.providers.openai.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
    expect(config.wizard).toMatchObject({
      securityAcknowledgedAt: "2026-01-01T00:00:00.000Z",
      accessMode: "full",
      appRecommendations: false,
    });
    expect(readFileSync(configPath, "utf8")).toMatch(/\n$/u);
  });

  it("accepts password Gateway fixtures", () => {
    const root = makeTempDir(tempDirs, "openclaw-onboard-config-password-");
    const passwordConfigPath = path.join(root, "password.json");
    writeJson(passwordConfigPath, {
      gateway: {
        mode: "local",
        auth: { mode: "password", password: "openclaw-onboard-password-e2e" },
      },
      wizard: { lastRunMode: "local" },
    });

    const passwordResult = runScript(ASSERT_CONFIG_SCRIPT, ["local-password", passwordConfigPath]);

    expect(passwordResult.status).toBe(0);
    expect(passwordResult.stderr).toBe("");

    const secretValue = "must-not-appear-in-assertion-output";
    writeJson(passwordConfigPath, {
      gateway: { mode: "local", auth: { mode: "password", password: secretValue } },
      wizard: { lastRunMode: "local" },
    });

    const mismatchResult = runScript(ASSERT_CONFIG_SCRIPT, ["local-password", passwordConfigPath]);

    expect(mismatchResult.status).toBe(1);
    expect(mismatchResult.stderr).toContain("gateway.auth.password mismatch");
    expect(mismatchResult.stderr).not.toContain(secretValue);
  });
});
