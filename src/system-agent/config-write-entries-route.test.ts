import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { classifyInferenceRouteConfigPath } from "./config-write-policy.js";
import { assertConfigWriteDoesNotBypassInferenceVerification } from "./operations-execution-helpers.js";

let temp: TempHomeEnv;

async function assertWrite(configPath: string) {
  await assertConfigWriteDoesNotBypassInferenceVerification({
    kind: "config-set",
    path: configPath,
    value: '"x"',
  } as never);
}

beforeEach(async () => {
  temp = await createTempHomeEnv("openclaw-config-write-entries-");
  const configPath = path.join(temp.home, ".openclaw", "openclaw.json");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  const config: OpenClawConfig = {
    plugins: { enabled: false },
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "main" } },
      entries: {
        main: { name: "Main", model: "anthropic/claude-sonnet-4-5" },
        helper: { name: "Helper", model: "anthropic/claude-haiku-4-5" },
      },
    },
  };
  await fs.writeFile(configPath, JSON.stringify(config));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await temp?.restore();
});

describe("system-agent config writes to the canonical agents.entries shape", () => {
  it("classifies agents.entries routing and identity fields like agents.list", () => {
    for (const field of ["model", "models", "params", "agentRuntime"]) {
      expect(
        classifyInferenceRouteConfigPath(["agents", "entries", "main", field]),
        `agents.entries.main.${field}`,
      ).toBe(classifyInferenceRouteConfigPath(["agents", "list", "0", field]));
    }
    for (const field of ["id", "default", "agentDir", "name", "tools", "prompt"]) {
      expect(
        classifyInferenceRouteConfigPath(["agents", "entries", "main", field]),
        `agents.entries.main.${field}`,
      ).toBe(classifyInferenceRouteConfigPath(["agents", "list", "0", field]));
    }
    expect(classifyInferenceRouteConfigPath(["agents", "entries"])).toBe("blocked");
    expect(classifyInferenceRouteConfigPath(["agents", "entries", "main"])).toBe("blocked");
  });

  it("refuses a direct write to the default agent's inference route", async () => {
    await expect(assertWrite("agents.entries.main.model")).rejects.toThrow(
      /set_default_model|inference route/i,
    );
    await expect(assertWrite("agents.entries.main.models")).rejects.toThrow();
    await expect(assertWrite("agents.entries.main.agentRuntime")).rejects.toThrow();
    await expect(assertWrite("agents.entries.main.params")).rejects.toThrow();
  });

  it("refuses identity and topology writes for every agents.entries agent", async () => {
    for (const agentId of ["main", "helper"]) {
      for (const field of ["id", "default", "agentDir"]) {
        await expect(
          assertWrite(`agents.entries.${agentId}.${field}`),
          `agents.entries.${agentId}.${field}`,
        ).rejects.toThrow();
      }
    }
  });

  it("still allows non-routing entries edits and routing edits for non-default agents", async () => {
    await expect(assertWrite("agents.entries.main.prompt")).resolves.toBeUndefined();
    await expect(assertWrite("agents.entries.main.name")).resolves.toBeUndefined();
    await expect(assertWrite("agents.entries.main.tools.profile")).resolves.toBeUndefined();
    await expect(assertWrite("agents.entries.helper.model")).resolves.toBeUndefined();
    await expect(assertWrite("agents.entries.helper.agentRuntime")).resolves.toBeUndefined();
  });
});
