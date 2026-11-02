import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertLegacyOperatorConfig,
  assertLegacyOperatorExternalPlugin,
  seedLegacyOperatorState,
} from "../../scripts/e2e/lib/upgrade-survivor/legacy-operator-state.mjs";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS } from "../../src/commands/doctor/shared/legacy-config-migrations.runtime.skills.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const commands = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: commands.spawnSync }));
const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let configPath: string;
let available: boolean;
let retired: boolean;
let workshopProperties: Record<string, unknown>;
const modeSchema = {
  anyOf: ["off", "propose", "auto"].map((mode) => ({ type: "string", const: mode })),
};

type FixtureConfig = {
  plugins?: { allow?: string[]; deny?: string[]; entries?: Record<string, unknown> };
  hooks?: { path?: string };
  skills?: { workshop?: { autonomous?: { mode?: unknown; enabled?: unknown } } };
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
  workshopProperties = { mode: modeSchema };
  save({ agents: { entries: { main: {}, ops: {} } } });
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_TEST_WORKSPACE_DIR", root);
  vi.stubEnv("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT", root);
  vi.stubEnv("OPENCLAW_UPGRADE_SURVIVOR_MOCK_PORT", "18888");
  vi.stubEnv("OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION", "2026.9.2");
  commands.spawnSync.mockImplementation((_command: string, args: string[]) => {
    let stdout = "";
    if (args[0] === "config" && args[1] === "schema") {
      expect(args).toEqual(["config", "schema"]);
      stdout = JSON.stringify({
        properties: {
          skills: {
            properties: {
              workshop: { properties: { autonomous: { properties: workshopProperties } } },
            },
          },
        },
      });
    } else if (args[0] === "config" && args[1] === "set") {
      if (
        args[2]!.startsWith("skills.workshop.autonomous.") &&
        !Object.hasOwn(workshopProperties, args[2]!.split(".").at(-1)!)
      ) {
        return { status: 1, stdout: "", stderr: "Unrecognized Workshop autonomous key" };
      }
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
          { id: "byteplus", enabled: true },
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
    save({
      ...config(),
      plugins: { entries: { disabled: { enabled: false } } },
    });
    seedLegacyOperatorState();
    expect(config().plugins?.allow).toEqual(["device-pair", "webhooks"]);
    expect(config().skills?.workshop?.autonomous?.mode).toBe("off");
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

  it("preserves an authored allowlist even when an ID is only enabled by default", () => {
    save({ ...config(), plugins: { allow: ["device-pair", "byteplus"] } });
    seedLegacyOperatorState();
    expect(config().plugins?.allow).toEqual(["device-pair", "byteplus", "webhooks"]);
  });

  it.each(["2026.6.34", "2026.9.2", "2026.10.9"])(
    "preserves the Workshop opt-out authored by %s alongside the workspace skill",
    (version) => {
      vi.stubEnv("OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION", version);
      available = version === "2026.9.2";
      const field = version === "2026.6.34" ? "enabled" : "mode";
      workshopProperties =
        field === "enabled"
          ? { enabled: { type: "boolean" } }
          : {
              mode: {
                anyOf: modeSchema.anyOf.filter(
                  (option) => version === "2026.9.2" || option.const !== "propose",
                ),
              },
            };
      seedLegacyOperatorState();
      const seeded = config();
      const baselinePath = path.join(root, "legacy-operator-baseline.json");
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
      expect(baseline.workshopAutonomousField).toBe(field);
      expect(seeded.skills?.workshop?.autonomous).toEqual({
        [field]: field === "enabled" ? false : "off",
      });
      expect(() => assertLegacyOperatorConfig("baseline")).not.toThrow();
      for (const autonomous of [
        {},
        { [field]: field === "enabled" ? true : "auto" },
        { enabled: false, mode: "off" },
      ]) {
        save({ ...seeded, skills: { workshop: { autonomous } } });
        expect(() => assertLegacyOperatorConfig("baseline")).toThrow(
          "legacy operator Workshop opt-out changed",
        );
      }
      save(seeded);
      writeFileSync(baselinePath, "{}");
      expect(() => assertLegacyOperatorConfig("baseline")).toThrow(
        "legacy operator Workshop baseline field missing",
      );
      writeFileSync(baselinePath, JSON.stringify(baseline));
      removeWebhooks();
      const preserved = config();
      const migrated = structuredClone(preserved);
      for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS) {
        if (migration.id === "skills.workshop->plugins.entries.skill-workshop.config") {
          // Check the canonical core era after boolean normalization, before the move.
          save(migrated);
          expect(() => assertLegacyOperatorConfig("survival")).not.toThrow();
        }
        migration.apply(migrated, []);
      }
      const core = { ...preserved, skills: { workshop: { autonomous: { mode: "off" } } } };
      save(core);
      expect(() => assertLegacyOperatorConfig("survival")).not.toThrow();
      for (const mode of [undefined, "auto", null]) {
        save({ ...preserved, skills: { workshop: { autonomous: { mode } } } });
        expect(() => assertLegacyOperatorConfig("survival")).toThrow(
          "legacy operator Workshop opt-out changed",
        );
      }
      save(migrated);
      expect(() => assertLegacyOperatorConfig("survival")).not.toThrow();
      for (const enabled of [false, true]) {
        save({ ...core, skills: { workshop: { autonomous: { mode: "off", enabled } } } });
        expect(() => assertLegacyOperatorConfig("survival")).toThrow(
          "legacy operator Workshop opt-out changed",
        );
        const broken = structuredClone(migrated);
        broken.plugins!.entries!["skill-workshop"] = {
          config: { autonomous: { mode: "off", enabled } },
        };
        save(broken);
        expect(() => assertLegacyOperatorConfig("survival")).toThrow(
          "legacy operator Workshop opt-out changed",
        );
      }
      for (const mode of [undefined, "auto", null]) {
        const broken = structuredClone(migrated);
        broken.plugins!.entries!["skill-workshop"] = { config: { autonomous: { mode } } };
        save(broken);
        expect(() => assertLegacyOperatorConfig("survival")).toThrow(
          "legacy operator Workshop opt-out changed",
        );
      }
      for (const mode of ["off", "auto"]) {
        save({ ...migrated, skills: { workshop: { autonomous: { mode } } } });
        expect(() => assertLegacyOperatorConfig("survival")).toThrow(
          "legacy operator Workshop locations changed",
        );
      }
      for (const marker of [undefined, false]) {
        save({ ...migrated, meta: { migrations: { skillWorkshopPlugin: marker } } });
        expect(() => assertLegacyOperatorConfig("survival")).toThrow(
          "legacy operator Workshop migration marker missing",
        );
      }
      for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS) {
        migration.apply(seeded, []);
      }
      save(seeded);
      expect(() => assertLegacyOperatorConfig("baseline")).toThrow(
        "legacy operator baseline Workshop placement changed",
      );
    },
  );

  it("allows an older baseline without Webhooks but requires the exact 9.2 specimen", () => {
    available = false;
    vi.stubEnv("OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION", "2026.6.34");
    workshopProperties = { enabled: { type: "boolean" } };
    seedLegacyOperatorState();
    expect(config().hooks).toBeUndefined();
    expect(() => assertLegacyOperatorConfig("baseline")).not.toThrow();
    expect(() => assertLegacyOperatorConfig("survival")).toThrow(
      "legacy operator Workshop opt-out changed",
    );
    const migrated = config();
    for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS) {
      migration.apply(migrated, []);
    }
    save(migrated);
    expect(() => assertLegacyOperatorConfig("survival")).not.toThrow();
    vi.stubEnv("OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION", "2026.9.2");
    workshopProperties = { mode: modeSchema };
    expect(() => seedLegacyOperatorState()).toThrow("must seed the published plugin");
  });

  it("rejects missing, ambiguous, or unsupported Workshop schemas before writing config", () => {
    for (const properties of [
      {},
      { enabled: { type: "boolean" }, mode: modeSchema },
      { enabled: { type: "string" } },
      { mode: { anyOf: [{ type: "string", const: "auto" }] } },
    ]) {
      workshopProperties = properties;
      commands.spawnSync.mockClear();
      const before = config();
      expect(() => seedLegacyOperatorState()).toThrow(/legacy operator Workshop schema/);
      expect(config()).toEqual(before);
      expect(commands.spawnSync.mock.calls.every(([, args]) => args[1] === "schema")).toBe(true);
    }
  });
});
