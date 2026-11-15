import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildModelAliasIndex,
  resolveModelRefFromString,
  resolveConfiguredModelRef,
} from "../agents/model-selection-shared.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createTestRuntime,
  useConfigCliIntegrationHarness,
} from "./config-cli.integration.test-harness.js";

const catalog = vi.hoisted(() => ({ calls: vi.fn() }));

// Keep registration, candidate env resolution, model validation and persistence real.
// The catalog boundary is deterministic; no model backend or inference is invoked.
vi.mock("./config-model-validation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config-model-validation.js")>();
  return {
    ...actual,
    checkTouchedTextModelRefs: (params: Parameters<typeof actual.checkTouchedTextModelRefs>[0]) =>
      actual.checkTouchedTextModelRefs({
        ...params,
        resolveModelRef: async ({ config, ref }) => {
          catalog.calls(ref.value);
          const primary = resolveConfiguredModelRef({
            cfg: {
              ...config,
              agents: {
                ...config.agents,
                defaults: { ...config.agents?.defaults, model: ref.value },
              },
            },
            agentId: ref.agentId,
            defaultProvider: "anthropic",
            defaultModel: "",
          });
          const resolved = ref.fallback
            ? resolveModelRefFromString({
                cfg: config,
                agentId: ref.agentId,
                raw: ref.value,
                defaultProvider: primary.provider,
                aliasIndex: buildModelAliasIndex({
                  cfg: config,
                  agentId: ref.agentId,
                  defaultProvider: primary.provider,
                }),
              })?.ref
            : primary;
          return ((resolved?.provider === "fixture-model" ||
            resolved?.provider === "fixture-other") &&
            resolved.model === "allowed") ||
            (resolved?.provider === "fixture-model" && resolved.model === "backup")
            ? undefined
            : "Unknown fixture model";
        },
      }),
  };
});

const {
  registeredRuntimeLogs: logs,
  registeredRuntimeErrors: errors,
  runRegisteredConfigCommand: invoke,
  withConfigFileHarness: withFile,
} = useConfigCliIntegrationHarness();

const read = (file: string) => fs.readFileSync(file, "utf8");
const readJson = (file: string) => JSON.parse(read(file));
const set = (...args: string[]) => invoke(["config", "set", ...args]);
const reject = (result: Promise<unknown>) =>
  expect(result).rejects.toMatchObject({ name: "ExitError", code: 1 });
const withConfig = (raw: string, visit: Parameters<typeof withFile>[2]) =>
  withFile("config-cli-", raw, visit);

function withModelConfig(
  raw: string,
  env: Record<string, string | undefined>,
  run: (configPath: string) => Promise<void>,
) {
  return withConfig(raw, ({ configPath }) => withEnvAsync(env, () => run(configPath)));
}

describe("config CLI candidate model environment", () => {
  it("preserves a shorthand primary when adding default model fallbacks", async () => {
    const raw = JSON.stringify({
      agents: { entries: { main: {} }, defaults: { model: "fixture-model/allowed" } },
    });
    await withConfig(raw, async ({ configPath }) => {
      await set("agents.defaults.model.fallbacks", '["fixture-model/backup"]', "--strict-json");
      expect(readJson(configPath).agents.defaults.model).toEqual({
        primary: "fixture-model/allowed",
        fallbacks: ["fixture-model/backup"],
      });
      expect(read(`${configPath}.bak`)).toBe(raw);
      expect(errors).toEqual([]);
    });
  });
  it("rejects a changed environment behind an unchanged model reference during preview", async () => {
    const raw = JSON.stringify({
      env: { vars: { CONFIG_EXISTING_MODEL: "fixture-model/allowed" } },
      agents: { entries: { main: {} }, defaults: { model: "${CONFIG_EXISTING_MODEL}" } },
    });
    await withModelConfig(raw, { CONFIG_EXISTING_MODEL: undefined }, async (configPath) => {
      await reject(
        set(
          "--batch-json",
          JSON.stringify([
            { path: "env.vars.CONFIG_EXISTING_MODEL", value: "fixture-model/unknown" },
            { path: "agents.defaults.model", value: "${CONFIG_EXISTING_MODEL}" },
          ]),
          "--dry-run",
        ),
      );
      expect([...logs, ...errors].join("\n")).toContain("Cannot set model reference");
      expect([...logs, ...errors].join("\n")).not.toContain("fixture-model/unknown");
      expect(read(configPath)).toBe(raw);
      expect(fs.existsSync(configPath + ".bak")).toBe(false);
    });
  });
  it("validates a redirected env-backed alias during preview", async () => {
    const aliasKey = "CONFIG_MODEL_ALIAS_REDIRECTED_PREVIEW";
    const otherKey = "CONFIG_OTHER_ALIAS_REDIRECTED_PREVIEW";
    const aliasRef = "${" + aliasKey + "}";
    const otherRef = "${" + otherKey + "}";
    const raw = JSON.stringify({
      env: { vars: { [aliasKey]: "friendly", [otherKey]: "other" } },
      agents: {
        entries: { main: {} },
        defaults: {
          model: "friendly",
          models: {
            "fixture-model/allowed": { alias: aliasRef },
            "fixture-model/unknown": { alias: otherRef },
          },
        },
      },
    });
    await withModelConfig(
      raw,
      {
        [aliasKey]: undefined,
        [otherKey]: undefined,
      },
      async (configPath) => {
        catalog.calls.mockClear();
        const result = set(
          "--batch-json",
          JSON.stringify([
            { path: `env.vars.${aliasKey}`, value: "gone" },
            {
              path: `env.vars.${otherKey}`,
              value: "friendly",
            },
          ]),
          "--dry-run",
        );
        await reject(result);
        expect(catalog.calls, [...logs, ...errors].join("\n")).toHaveBeenCalled();
        expect([...logs, ...errors].join("\n")).toContain("Cannot set model reference");
        expect(read(configPath)).toBe(raw);
        expect(fs.existsSync(configPath + ".bak")).toBe(false);
      },
    );
  });
  it("checks an env-backed alias for an agent inheriting the default model", async () => {
    const aliasKey = "CONFIG_OWNING_ALIAS_INHERITED_ENV";
    const aliasRef = "${" + aliasKey + "}";
    const raw = JSON.stringify({
      env: { vars: { [aliasKey]: "friendly" } },
      agents: {
        ownership: "explicit",
        defaults: {
          model: "friendly",
          models: { "fixture-model/allowed": { alias: "friendly" } },
        },
        entries: {
          main: {},
          ops: { models: { "fixture-model/allowed": { alias: aliasRef } } },
        },
      },
    });
    await withModelConfig(raw, { [aliasKey]: undefined }, async (configPath) => {
      catalog.calls.mockClear();
      await expect(
        set(
          "--batch-json",
          JSON.stringify([
            {
              path: `env.vars.${aliasKey}`,
              value: "gone",
            },
          ]),
        ),
      ).rejects.toMatchObject({ name: "ExitError", code: 1 });
      expect(catalog.calls, [...logs, ...errors].join("\n")).toHaveBeenCalled();
      expect([...logs, ...errors].join("\n")).toContain("Cannot set model reference");
      expect(read(configPath)).toBe(raw);
      expect(fs.existsSync(configPath + ".bak")).toBe(false);
    });
  });
  it("checks fallback provider after an owning primary edit", async () => {
    const raw = JSON.stringify({
      agents: {
        ownership: "explicit",
        defaults: { model: "fixture-model/allowed" },
        entries: {
          main: {},
          ops: { model: { primary: "fixture-model/allowed", fallbacks: ["backup"] } },
        },
      },
    });
    await withConfig(raw, async ({ configPath }) => {
      catalog.calls.mockClear();
      await reject(set("agents.entries.ops.model.primary", "fixture-other/allowed"));
      expect(catalog.calls).toHaveBeenCalledWith("backup");
      expect([...logs, ...errors].join("\n")).toContain("Cannot set model reference");
      expect(read(configPath)).toBe(raw);
      expect(fs.existsSync(configPath + ".bak")).toBe(false);
    });
  });

  it.each([
    { preview: false, kind: "invalid-agent" },
    { preview: false, kind: "valid" },
    { preview: false, kind: "discarded" },
  ])(
    "validates surviving model assignments after ordered deletion (preview=$preview, kind=$kind)",
    async ({ preview, kind }) => {
      const agentScoped = kind === "invalid-agent";
      const model = {
        primary: "fixture-model/allowed",
        fallbacks: ["fixture-model/allowed", "fixture-model/allowed", "fixture-model/allowed"],
      };
      const raw = JSON.stringify({
        agents: {
          ownership: "explicit",
          defaults: { model: agentScoped ? "fixture-model/allowed" : model },
          entries: { main: {}, ...(agentScoped ? { ops: { model } } : {}) },
        },
      });
      await withConfig(raw, async ({ configPath }) => {
        const { runConfigOperations } = await import("./config-cli-runner.js");
        const prefix = agentScoped
          ? ["agents", "entries", "ops", "model", "fallbacks"]
          : ["agents", "defaults", "model", "fallbacks"];
        const target = [...prefix, "2"];
        const deleted = [...prefix, kind === "discarded" ? "2" : "0"];
        const value = kind === "valid" ? "fixture-model/backup" : "fixture-model/not-available";
        const { runtime } = createTestRuntime();
        catalog.calls.mockClear();
        const outcome = runConfigOperations({
          runtime,
          options: { dryRun: preview },
          successMode: "patch",
          operations: [
            { inputMode: "json", requestedPath: target, setPath: target, value },
            {
              inputMode: "unset",
              requestedPath: deleted,
              setPath: deleted,
              value: undefined,
              mutation: "delete",
            },
          ],
        });
        if (kind.startsWith("invalid")) {
          await expect(outcome).rejects.toThrow("Cannot set model reference");
          expect(catalog.calls).toHaveBeenCalledWith(value);
          expect(read(configPath)).toBe(raw);
          expect(fs.existsSync(configPath + ".bak")).toBe(false);
          return;
        }
        await outcome;
        if (kind === "discarded") {
          expect(catalog.calls).not.toHaveBeenCalledWith(value);
        } else {
          expect(catalog.calls).toHaveBeenCalledWith(value);
        }
        const saved = readJson(configPath);
        expect(saved.agents.defaults.model.fallbacks).toEqual([
          "fixture-model/allowed",
          kind === "discarded" ? "fixture-model/allowed" : value,
        ]);
        expect(read(configPath + ".bak")).toBe(raw);
      });
    },
  );
});
