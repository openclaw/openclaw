import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertLegacyOperatorConfig,
  assertLegacyOperatorExternalPlugin,
  seedLegacyOperatorState,
} from "../../scripts/e2e/lib/upgrade-survivor/legacy-operator-state.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const commands = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: commands.spawnSync }));
const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let configPath: string;
let available: boolean;
let retired: boolean;

type FixtureConfig = {
  plugins?: { allow?: string[]; deny?: string[]; entries?: Record<string, unknown> };
  hooks?: { path?: string };
};

function config(): FixtureConfig {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function save(value: unknown) {
  writeFileSync(configPath, JSON.stringify(value));
}

function removeWebhooks() {
  const next = config();
  delete next.plugins?.entries?.webhooks;
  next.plugins!.allow = next.plugins!.allow?.filter((id) => id !== "webhooks");
  next.plugins!.deny = next.plugins!.deny?.filter((id) => id !== "webhooks");
  save(next);
}

beforeEach(() => {
  root = dirs.make("openclaw-survivor-webhooks-");
  configPath = path.join(root, "openclaw.json");
  available = true;
  retired = false;
  save({ agents: { entries: { main: {}, ops: {} } } });
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_TEST_WORKSPACE_DIR", root);
  vi.stubEnv("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT", root);
  vi.stubEnv("OPENCLAW_UPGRADE_SURVIVOR_MOCK_PORT", "18888");
  vi.stubEnv("OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION", "2026.9.2");
  commands.spawnSync.mockImplementation((_command: string, args: string[]) => {
    let stdout = "";
    if (args[0] === "config" && args[1] === "set") {
      const value = config();
      const keys = args[2]!.split(".");
      let current: object = value;
      for (const key of keys.slice(0, -1)) {
        let nested: unknown = Reflect.get(current, key);
        if (nested === undefined) {
          nested = {};
          Reflect.set(current, key, nested);
        }
        if (!nested || typeof nested !== "object") {
          throw new Error("fixture config path is not an object");
        }
        current = nested;
      }
      Reflect.set(current, keys.at(-1)!, JSON.parse(args[3]!));
      save(value);
    } else if (args[0] === "plugins") {
      stdout = JSON.stringify({
        plugins: [
          { id: "device-pair", enabled: true },
          ...(available && !retired ? [{ id: "webhooks", enabled: false }] : []),
          ...(retired
            ? [{ id: "duckduckgo", enabled: true, origin: "npm", version: "candidate" }]
            : []),
        ],
      });
    } else if (args[0] === "config" && args[1] === "validate") {
      stdout = JSON.stringify({ valid: true, warnings: [] });
    } else {
      expect(args[0]).toBe("setup");
    }
    return { status: 0, stdout, stderr: "" };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  commands.spawnSync.mockReset();
});

describe("legacy operator Webhooks retirement acceptance", () => {
  it("authors the published specimen and refuses retained ids or lost ordinary hooks", () => {
    seedLegacyOperatorState();
    const specimen = JSON.parse(
      readFileSync(path.join(root, "legacy-operator-webhooks.json"), "utf8"),
    );
    expect(specimen.model).toBe("survivor/gpt-5.6-luna");
    expect(specimen.provider).toMatchObject({
      baseUrl: "http://127.0.0.1:18888/v1",
      api: "openai-completions",
      apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    });
    expect(() => assertLegacyOperatorConfig("baseline")).not.toThrow();
    expect(config().plugins?.entries?.webhooks).toMatchObject({
      enabled: true,
      config: {
        routes: {
          survivor: {
            secret: { source: "env", provider: "default", id: "GATEWAY_AUTH_TOKEN_REF" },
          },
        },
      },
    });
    expect(() => assertLegacyOperatorConfig("survival")).toThrow("retired Webhooks entry remains");
    const next = config();
    delete next.plugins?.entries?.webhooks;
    save(next);
    expect(() => assertLegacyOperatorConfig("survival")).toThrow(
      "retired Webhooks allow id remains",
    );
    next.plugins!.allow = ["device-pair"];
    save(next);
    expect(() => assertLegacyOperatorConfig("survival")).toThrow(
      "retired Webhooks deny id remains",
    );
    removeWebhooks();
    expect(() => assertLegacyOperatorConfig("survival")).not.toThrow();
    expect(() => assertLegacyOperatorExternalPlugin("candidate")).toThrow(
      "candidate still discovers retired Webhooks",
    );
    retired = true;
    expect(() => assertLegacyOperatorExternalPlugin("candidate")).not.toThrow();
    const broken = config();
    broken.hooks!.path = "/wrong";
    save(broken);
    expect(() => assertLegacyOperatorConfig("survival")).toThrow("ordinary hooks changed");
  });

  it("allows an older baseline without Webhooks but requires the exact 9.2 specimen", () => {
    available = false;
    vi.stubEnv("OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION", "2026.6.34");
    seedLegacyOperatorState();
    expect(config().hooks).toBeUndefined();
    expect(() => assertLegacyOperatorConfig("survival")).not.toThrow();
    vi.stubEnv("OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION", "2026.9.2");
    expect(() => seedLegacyOperatorState()).toThrow("must seed the published plugin");
  });
});
