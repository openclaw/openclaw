import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildModelAliasIndex,
  resolveModelRefFromString,
  resolveConfiguredModelRef,
} from "../agents/model-selection-shared.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
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
  registeredRuntimeLogs,
  registeredRuntimeErrors,
  runRegisteredConfigCommand,
  withConfigFileHarness,
} = useConfigCliIntegrationHarness();

describe("config CLI candidate model environment", () => {
  it.each([false, true])(
    "rejects candidate environment-backed model before committing (preview=%s)",
    async (preview) => {
      const raw = JSON.stringify({ agents: { entries: { main: {} } } });
      await withConfigFileHarness("config-candidate-model-env-", raw, async ({ configPath }) => {
        const env = captureEnv(["CONFIG_CANDIDATE_MODEL"]);
        const candidateModel = "fixture-unavailable-provider/private-candidate-model";
        try {
          deleteTestEnvValue("CONFIG_CANDIDATE_MODEL");
          await expect(
            runRegisteredConfigCommand([
              "config",
              "set",
              "--batch-json",
              JSON.stringify([
                { path: "env.vars.CONFIG_CANDIDATE_MODEL", value: candidateModel },
                { path: "agents.defaults.model", value: "${CONFIG_CANDIDATE_MODEL}" },
              ]),
              ...(preview ? ["--dry-run"] : []),
            ]),
          ).rejects.toMatchObject({ name: "ExitError", code: 1 });
          const output = [...registeredRuntimeLogs, ...registeredRuntimeErrors].join("\n");
          expect(output).toContain("Cannot set model reference");
          expect(output).not.toContain(candidateModel);
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
          expect(fs.existsSync(configPath + ".bak")).toBe(false);
        } finally {
          env.restore();
        }
      });
    },
  );

  it.each([false, true])(
    "accepts a valid candidate environment-backed model (preview=%s)",
    async (preview) => {
      const raw = JSON.stringify({ agents: { entries: { main: {} } } });
      await withConfigFileHarness(
        "config-valid-candidate-model-env-",
        raw,
        async ({ configPath }) => {
          const env = captureEnv(["CONFIG_VALID_CANDIDATE_MODEL"]);
          try {
            deleteTestEnvValue("CONFIG_VALID_CANDIDATE_MODEL");
            const error = await runRegisteredConfigCommand([
              "config",
              "set",
              "--batch-json",
              JSON.stringify([
                { path: "env.vars.CONFIG_VALID_CANDIDATE_MODEL", value: "fixture-model/allowed" },
                { path: "agents.defaults.model", value: "${CONFIG_VALID_CANDIDATE_MODEL}" },
              ]),
              ...(preview ? ["--dry-run"] : []),
            ]).catch((caught: unknown) => caught);
            expect(
              error,
              [...registeredRuntimeLogs, ...registeredRuntimeErrors].join("\n"),
            ).toBeUndefined();
            if (preview) {
              expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
              expect(fs.existsSync(configPath + ".bak")).toBe(false);
            } else {
              const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
              expect(saved.agents.defaults.model).toBe("${CONFIG_VALID_CANDIDATE_MODEL}");
              expect(saved.env.vars.CONFIG_VALID_CANDIDATE_MODEL).toBe("fixture-model/allowed");
              expect(fs.readFileSync(configPath + ".bak", "utf8")).toBe(raw);
            }
          } finally {
            env.restore();
          }
        },
      );
    },
  );
  it.each([
    { preview: false, retouch: false },
    { preview: true, retouch: false },
    { preview: false, retouch: true },
    { preview: true, retouch: true },
  ])(
    "rejects changed environment behind an unchanged model reference (preview=$preview, retouch=$retouch)",
    async ({ preview, retouch }) => {
      const raw = JSON.stringify({
        env: { vars: { CONFIG_EXISTING_MODEL: "fixture-model/allowed" } },
        agents: { entries: { main: {} }, defaults: { model: "${CONFIG_EXISTING_MODEL}" } },
      });
      await withConfigFileHarness("config-existing-model-env-", raw, async ({ configPath }) => {
        const env = captureEnv(["CONFIG_EXISTING_MODEL"]);
        try {
          deleteTestEnvValue("CONFIG_EXISTING_MODEL");
          await expect(
            runRegisteredConfigCommand([
              "config",
              "set",
              "--batch-json",
              JSON.stringify([
                { path: "env.vars.CONFIG_EXISTING_MODEL", value: "fixture-model/unknown" },
                ...(retouch
                  ? [{ path: "agents.defaults.model", value: "${CONFIG_EXISTING_MODEL}" }]
                  : []),
              ]),
              ...(preview ? ["--dry-run"] : []),
            ]),
          ).rejects.toMatchObject({ name: "ExitError", code: 1 });
          expect([...registeredRuntimeLogs, ...registeredRuntimeErrors].join("\n")).toContain(
            "Cannot set model reference",
          );
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
          expect(fs.existsSync(configPath + ".bak")).toBe(false);
        } finally {
          env.restore();
        }
      });
    },
  );
  it.each(
    [false, true].flatMap((preview) =>
      (["removed", "redirected", "unrelated", "external"] as const).map((change) => ({
        preview,
        change,
      })),
    ),
  )(
    "validates env-backed alias dependencies (preview=$preview, change=$change)",
    async ({ preview, change }) => {
      const aliasKey = `CONFIG_MODEL_ALIAS_${change.toUpperCase()}_${preview ? "PREVIEW" : "WRITE"}`;
      const otherKey = `CONFIG_OTHER_ALIAS_${change.toUpperCase()}_${preview ? "PREVIEW" : "WRITE"}`;
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
      await withConfigFileHarness("config-model-alias-env-", raw, async ({ configPath }) => {
        const env = captureEnv([aliasKey, otherKey]);
        try {
          deleteTestEnvValue(aliasKey);
          deleteTestEnvValue(otherKey);
          if (change === "external") {
            setTestEnvValue(aliasKey, "friendly");
          }
          catalog.calls.mockClear();
          const result = runRegisteredConfigCommand([
            "config",
            "set",
            "--batch-json",
            JSON.stringify([
              { path: `env.vars.${aliasKey}`, value: change === "unrelated" ? "friendly" : "gone" },
              {
                path: `env.vars.${otherKey}`,
                value: change === "redirected" ? "friendly" : "different",
              },
            ]),
            ...(preview ? ["--dry-run"] : []),
          ]);
          if (change === "removed" || change === "redirected") {
            await expect(result).rejects.toMatchObject({ name: "ExitError", code: 1 });
            expect(
              catalog.calls,
              [...registeredRuntimeLogs, ...registeredRuntimeErrors].join("\n"),
            ).toHaveBeenCalled();
            expect([...registeredRuntimeLogs, ...registeredRuntimeErrors].join("\n")).toContain(
              "Cannot set model reference",
            );
            expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
            expect(fs.existsSync(configPath + ".bak")).toBe(false);
          } else {
            await expect(result).resolves.toBeUndefined();
            expect(catalog.calls).not.toHaveBeenCalled();
            if (preview) {
              expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
              expect(fs.existsSync(configPath + ".bak")).toBe(false);
            } else {
              const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
              expect(saved.agents.defaults.model).toBe("friendly");
              expect(saved.agents.defaults.models["fixture-model/allowed"].alias).toBe(aliasRef);
              expect(fs.readFileSync(configPath + ".bak", "utf8")).toBe(raw);
            }
          }
        } finally {
          env.restore();
        }
      });
    },
  );
  it.each(
    [false, true].flatMap((preview) =>
      (
        [
          "default-direct",
          "agent-direct",
          "agent-env",
          "inherited-env",
          "fallback-env",
          "default-parent",
          "agent-parent",
        ] as const
      ).map((kind) => ({ preview, kind })),
    ),
  )(
    "checks alias changes in the owning agent scope (preview=$preview, kind=$kind)",
    async ({ preview, kind }) => {
      const aliasKey = `CONFIG_OWNING_ALIAS_${kind.replaceAll("-", "_").toUpperCase()}_${preview ? "PREVIEW" : "WRITE"}`;
      const aliasRef = "${" + aliasKey + "}";
      const direct = kind.endsWith("direct") || kind.endsWith("parent");
      const agentScoped = !kind.startsWith("default");
      const raw = JSON.stringify({
        env: { vars: { [aliasKey]: "friendly" } },
        agents: {
          ownership: "explicit",
          defaults: {
            model: !agentScoped || kind === "inherited-env" ? "friendly" : "fixture-model/allowed",
            models: { "fixture-model/allowed": { alias: "friendly" } },
          },
          entries: {
            main: {},
            ...(agentScoped
              ? {
                  ops: {
                    ...(kind === "inherited-env"
                      ? {}
                      : {
                          model:
                            kind === "fallback-env"
                              ? { primary: "fixture-model/allowed", fallbacks: ["friendly"] }
                              : "friendly",
                        }),
                    models: { "fixture-model/allowed": { alias: direct ? "friendly" : aliasRef } },
                  },
                }
              : {}),
          },
        },
      });
      await withConfigFileHarness("config-owning-alias-", raw, async ({ configPath }) => {
        const env = captureEnv([aliasKey]);
        try {
          deleteTestEnvValue(aliasKey);
          catalog.calls.mockClear();
          await expect(
            runRegisteredConfigCommand([
              "config",
              "set",
              "--batch-json",
              JSON.stringify([
                {
                  path: kind.endsWith("parent")
                    ? agentScoped
                      ? "agents.entries.ops"
                      : "agents.defaults"
                    : direct
                      ? `${agentScoped ? "agents.entries.ops" : "agents.defaults"}.models["fixture-model/allowed"].alias`
                      : `env.vars.${aliasKey}`,
                  value: kind.endsWith("parent")
                    ? { model: "friendly", models: { "fixture-model/allowed": { alias: "gone" } } }
                    : "gone",
                },
              ]),
              ...(preview ? ["--dry-run"] : []),
            ]),
          ).rejects.toMatchObject({ name: "ExitError", code: 1 });
          expect(
            catalog.calls,
            [...registeredRuntimeLogs, ...registeredRuntimeErrors].join("\n"),
          ).toHaveBeenCalled();
          expect([...registeredRuntimeLogs, ...registeredRuntimeErrors].join("\n")).toContain(
            "Cannot set model reference",
          );
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
          expect(fs.existsSync(configPath + ".bak")).toBe(false);
        } finally {
          env.restore();
        }
      });
    },
  );
  it.each([false, true])(
    "checks fallback provider after an owning primary edit (preview=%s)",
    async (preview) => {
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
      await withConfigFileHarness("config-owning-provider-", raw, async ({ configPath }) => {
        catalog.calls.mockClear();
        await expect(
          runRegisteredConfigCommand([
            "config",
            "set",
            "agents.entries.ops.model.primary",
            "fixture-other/allowed",
            ...(preview ? ["--dry-run"] : []),
          ]),
        ).rejects.toMatchObject({ name: "ExitError", code: 1 });
        expect(catalog.calls).toHaveBeenCalledWith("backup");
        expect([...registeredRuntimeLogs, ...registeredRuntimeErrors].join("\n")).toContain(
          "Cannot set model reference",
        );
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(fs.existsSync(configPath + ".bak")).toBe(false);
      });
    },
  );
  it.each(
    [false, true].flatMap((preview) =>
      ["invalid-default", "invalid-agent", "valid", "discarded"].map((kind) => ({ preview, kind })),
    ),
  )(
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
      await withConfigFileHarness("config-ordered-model-delete-", raw, async ({ configPath }) => {
        const { runConfigOperations } = await import("./config-cli-runner.js");
        const prefix = agentScoped
          ? ["agents", "entries", "ops", "model", "fallbacks"]
          : ["agents", "defaults", "model", "fallbacks"];
        const target = [...prefix, "2"];
        const deleted = [...prefix, kind === "discarded" ? "2" : "0"];
        const value = kind === "valid" ? "fixture-model/backup" : "fixture-model/not-available";
        const { runtime, logs } = createTestRuntime();
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
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
          expect(fs.existsSync(configPath + ".bak")).toBe(false);
          return;
        }
        await outcome;
        if (kind === "discarded") {
          expect(catalog.calls).not.toHaveBeenCalledWith(value);
        } else {
          expect(catalog.calls).toHaveBeenCalledWith(value);
        }
        if (preview) {
          expect(logs.join("\n")).toContain("2 update(s)");
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
          expect(fs.existsSync(configPath + ".bak")).toBe(false);
        } else {
          const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
          expect(saved.agents.defaults.model.fallbacks).toEqual([
            "fixture-model/allowed",
            kind === "discarded" ? "fixture-model/allowed" : value,
          ]);
          expect(fs.readFileSync(configPath + ".bak", "utf8")).toBe(raw);
        }
      });
    },
  );
});
