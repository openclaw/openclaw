// Config CLI integration tests cover end-to-end config command reads and writes.
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createTestRuntime,
  useConfigCliIntegrationHarness,
} from "./config-cli.integration.test-harness.js";

// Register the harness metadata mock before loading the real config and command modules.
const configRuntime = await import("../config/config.js");
const { clearConfigCache } = configRuntime;
const { REDACTED_SENTINEL } = await import("../config/redact-snapshot.js");
const { readDeferredPluginMigrations, recordDeferredPluginMigrations } =
  await import("../infra/deferred-plugin-migrations.js");
const { closeOpenClawStateDatabaseForTest } = await import("../state/openclaw-state-db.js");
const runtimeSchema = await import("../config/runtime-schema.js");
const { runConfigGet, runConfigPatch, runConfigSet, runConfigUnset } =
  await import("./config-cli.js");
const {
  registeredRuntimeLogs: logs,
  registeredRuntimeErrors: errors,
  runRegisteredConfigCommand: invoke,
  withConfigFileHarness: withFile,
} = useConfigCliIntegrationHarness();

const read = (file: string) => fs.readFileSync(file, "utf8");
const load = (file: string) => JSON5.parse(read(file));
const readJson = (file: string) => JSON.parse(read(file));
const run = (...args: string[]) => invoke(["config", ...args]);
const set = (...args: string[]) => invoke(["config", "set", ...args]);
const reject = (result: Promise<unknown>) =>
  expect(result).rejects.toMatchObject({ name: "ExitError", code: 1 });
const withConfig = (raw: string, visit: Parameters<typeof withFile>[2]) =>
  withFile("config-cli-", raw, visit);

function installRuntimeSchemaReadHook(hook: () => void | Promise<void>): void {
  const readSchema = runtimeSchema.readBestEffortRuntimeConfigSchema;
  vi.spyOn(runtimeSchema, "readBestEffortRuntimeConfigSchema").mockImplementation(async () => {
    const result = await readSchema();
    await hook();
    return result;
  });
}

describe("config cli integration", () => {
  it.each([true, false])(
    "retains completed validation on a thrown preview refusal (json=%s)",
    async (json) => {
      const raw = '{"agents":{"entries":{"main":{}}}}';
      const refusal =
        "Config write would drop agent roster entries without an explicit deletion: main.";
      await withConfig(raw, async ({ configPath, tempDir }) => {
        const stateDir = path.join(tempDir, "state");
        fs.mkdirSync(stateDir);
        const inventory = fs.readdirSync(tempDir).toSorted();
        await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
          await reject(
            set(
              "agents.entries",
              "{}",
              "--replace",
              "--strict-json",
              "--dry-run",
              ...(json ? ["--json"] : []),
            ),
          );
          if (json) {
            expect(logs).toHaveLength(1);
            expect(JSON.parse(logs[0] ?? "")).toEqual({
              ok: false,
              operations: 1,
              configPath,
              inputModes: ["json"],
              checks: { schema: true, resolvability: true, resolvabilityComplete: true },
              refsChecked: 0,
              skippedExecRefs: 0,
              errors: [{ kind: "schema", message: refusal }],
            });
          } else {
            expect(logs).toEqual([]);
            expect(errors).toEqual([refusal]);
          }
          expect(read(configPath)).toBe(raw);
          expect(fs.readdirSync(tempDir).toSorted()).toEqual(inventory);
        });
      });
    },
  );

  it.each([
    { name: "large root shrink", include: false, remaining: 2, rejected: true },
    { name: "moderate root shrink", include: false, remaining: 60, rejected: false },
    { name: "include-owned shrink", include: true, remaining: 2, rejected: false },
  ])("previews the writer size guard for $name", async ({ include, remaining, rejected }) => {
    const models = Array.from({ length: 80 }, (_, index) => ({
      id: `fixture-model-${index}`,
      name: `Fixture model ${index}`,
    }));
    const provider = {
      baseUrl: "https://provider.example/v1",
      api: "openai-completions",
      models,
    };
    const raw = `${JSON.stringify({
      gateway: { mode: "local" },
      models: { providers: { example: include ? { $include: "./provider.json" } : provider } },
    })}\n`;
    await withConfig(raw, async ({ configPath, tempDir }) => {
      const ownedPath = include ? path.join(tempDir, "provider.json") : configPath;
      if (include) {
        fs.writeFileSync(ownedPath, JSON.stringify(provider));
      }
      const before = read(ownedPath);
      const nextModels = models.slice(0, remaining);
      const patchPath = path.join(tempDir, "patch.json");
      fs.writeFileSync(
        patchPath,
        JSON.stringify({ models: { providers: { example: { models: nextModels } } } }),
      );
      const args = [
        "patch",
        "--file",
        patchPath,
        "--replace-path",
        "models.providers.example.models",
      ];
      const stateDir = path.join(tempDir, "state");
      fs.mkdirSync(stateDir);
      const inventory = fs.readdirSync(tempDir).toSorted();
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const preview = run(...args, "--dry-run", "--json");
        if (rejected) {
          await reject(preview);
        } else {
          await preview;
        }
        expect(logs).toHaveLength(1);
        const result = JSON.parse(logs[0] ?? "");
        expect(result).toMatchObject({ ok: !rejected, configPath, operations: 1 });
        if (rejected) {
          expect(result.errors).toEqual([
            { kind: "write-safety", message: expect.stringMatching(/size-drop:\d+->\d+/) },
          ]);
          expect(result.errors[0].message).toContain("Correct the proposed update");
          expect(result.errors[0].message).toContain("openclaw doctor --fix");
          logs.length = 0;
          await reject(run(...args, "--dry-run"));
          expect(errors.join("\n")).toContain(result.errors[0].message);
        } else {
          expect(errors).toEqual([]);
        }
        expect(read(configPath)).toBe(raw);
        expect(read(ownedPath)).toBe(before);
        expect(fs.readdirSync(tempDir).toSorted()).toEqual(inventory);
        logs.length = 0;
        errors.length = 0;
        if (rejected) {
          await reject(run(...args));
          expect(errors.join("\n")).toContain("OpenClaw blocked this config update");
          expect(read(ownedPath)).toBe(before);
          expect(fs.existsSync(`${ownedPath}.bak`)).toBe(false);
        } else {
          await run(...args);
          const saved = load(ownedPath);
          expect(include ? saved.models : saved.models.providers.example.models).toEqual(
            nextModels,
          );
          expect(read(`${ownedPath}.bak`)).toBe(before);
          expect(errors).toEqual([]);
          if (include) {
            expect(read(configPath)).toBe(raw);
          }
        }
      });
    });
  });

  it.each(["builder", "batch"])(
    "previews write safety for a prevalidated %s input",
    async (mode) => {
      const raw = JSON.stringify({
        gateway: { mode: "local" },
        secrets: {
          providers: {
            fixture: {
              source: "env",
              allowlist: Array.from({ length: 80 }, (_, i) => `FIXTURE_VARIABLE_${i}`),
            },
          },
        },
      });
      await withConfig(raw, async ({ configPath, tempDir }) => {
        const stateDir = path.join(tempDir, "state");
        fs.mkdirSync(stateDir);
        const args =
          mode === "builder"
            ? [
                "secrets.providers.fixture",
                "--provider-source",
                "env",
                "--provider-allowlist",
                "FIXTURE_VARIABLE_0",
              ]
            : [
                "--batch-json",
                JSON.stringify([
                  {
                    path: "secrets.providers.fixture",
                    provider: { source: "env", allowlist: ["FIXTURE_VARIABLE_0"] },
                  },
                ]),
              ];
        const inventory = fs.readdirSync(tempDir).toSorted();
        await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
          await reject(set(...args, "--replace", "--dry-run", "--json"));
          expect(JSON.parse(logs[0] ?? "")).toMatchObject({
            ok: false,
            operations: 1,
            errors: [
              { kind: "write-safety", message: expect.stringMatching(/size-drop:\d+->\d+/) },
            ],
          });
          expect(read(configPath)).toBe(raw);
          expect(fs.readdirSync(tempDir).toSorted()).toEqual(inventory);
        });
      });
    },
  );

  it("protects pending plugin inputs while admitting explicit plugin entry removal", async () => {
    const pluginPath = "plugins.entries.sample.config";
    const raw = JSON.stringify({
      gateway: { mode: "local", port: 18789 },
      session: { store: "/srv/legacy/sessions.json" },
      plugins: { entries: { sample: { config: { legacyRoot: "/srv/legacy" } } } },
    });
    await withConfig(raw, async ({ configPath, tempDir }) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(tempDir, "state") }, async () => {
        try {
          await recordDeferredPluginMigrations({
            pending: [
              {
                pluginId: "sample",
                reason: "The configured plugin is not installed.",
                command: "openclaw plugins install @example/sample",
                requiresStateMigration: true,
                configPaths: [
                  ["plugins", "entries", "sample", "config"],
                  ["session", "store"],
                ],
              },
            ],
          });
          for (const args of [
            ["set", `${pluginPath}.legacyRoot`, "/srv/replacement"],
            ["set", `${pluginPath}.legacyRoot`, "/srv/replacement", "--dry-run"],
            ["unset", `${pluginPath}.legacyRoot`],
            ["set", pluginPath, '{"legacyRoot":"/srv/replacement"}', "--replace"],
            ["unset", "plugins.entries"],
          ]) {
            await reject(run(...args));
            expect(errors.at(-1)).toContain('Plugin "sample" data/settings upgrade is unfinished');
            expect(errors.at(-1)).toContain("openclaw plugins install @example/sample");
            expect(read(configPath)).toBe(raw);
            expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
            expect(logs.join("\n")).not.toMatch(/Updated|Removed|Applied/);
          }
          await set("gateway.port", "18790");
          expect(load(configPath)).toMatchObject({
            gateway: { port: 18790 },
            plugins: { entries: { sample: { config: { legacyRoot: "/srv/legacy" } } } },
          });
          const beforeRemoval = read(configPath);
          const pending = readDeferredPluginMigrations();
          await run("unset", "plugins.entries.sample");
          expect(load(configPath)).not.toHaveProperty("plugins.entries.sample");
          expect(load(configPath)).toMatchObject({
            gateway: { port: 18790 },
            session: { store: "/srv/legacy/sessions.json" },
          });
          expect(read(`${configPath}.bak`)).toBe(beforeRemoval);
          expect(readDeferredPluginMigrations()).toEqual(pending);
          expect(logs.join("\n")).toContain("Removed plugins.entries.sample");
        } finally {
          closeOpenClawStateDatabaseForTest();
        }
      });
    });
  });

  it.each(["restore", "empty external replacement", "recovery failure"])(
    "openclaw config set reports owned root removal with %s",
    async (recovery) => {
      const raw = '{"gateway":{"mode":"local"},"logging":{"$include":"logging.json"}}\n';
      await withConfig(raw, async ({ configPath, tempDir }) => {
        const includePath = path.join(tempDir, "logging.json");
        fs.writeFileSync(includePath, '{"level":"info"}\n');
        const rename = fs.renameSync;
        vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
          if (to === configPath) {
            throw Object.assign(new Error("rename denied"), { code: "EPERM" });
          }
          return rename(from, to);
        });
        const concurrentRaw =
          recovery === "empty external replacement"
            ? ""
            : '{"gateway":{"mode":"local","port":19003}}\n';
        let removed = false;
        const remove = fs.rmSync;
        vi.spyOn(fs, "rmSync").mockImplementation((file, options) => {
          remove(file, options);
          if (file === configPath) {
            removed = true;
            fs.writeFileSync(includePath, '{"level":"warn"}\n');
            if (recovery === "external replacement" || recovery === "empty external replacement") {
              fs.writeFileSync(configPath, concurrentRaw);
            }
          }
        });
        const open = fs.openSync;
        vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
          if (removed && recovery === "recovery failure" && String(file).endsWith(".tmp")) {
            throw Object.assign(new Error("recovery stage full"), { code: "ENOSPC" });
          }
          return open(file, flags, mode);
        });
        await reject(set("messages.responsePrefix", "changed"));
        expect(removed).toBe(true);
        expect(read(`${configPath}.bak`)).toBe(raw);
        expect(read(includePath)).toBe('{"level":"warn"}\n');
        const error = errors.join("\n");
        expect(error).toContain("Config publication failed after removing");
        expect(error).toContain(`${configPath}.bak`);
        expect(error).not.toContain("nothing was changed");
        expect(error).not.toContain("Re-run the same command");
        if (recovery === "recovery failure") {
          expect(fs.existsSync(configPath)).toBe(false);
          expect(error).toContain("Rollback could not be confirmed");
        } else {
          expect(read(configPath)).toBe(recovery === "restore" ? raw : concurrentRaw);
        }
      });
    },
  );

  it.each(["root", "include"])(
    "openclaw config set preserves all five %s backups after five failed stages",
    async (location) => {
      const includeRaw = '{"level":"info"}\n';
      const raw =
        JSON.stringify({
          gateway: { mode: "local" },
          logging: location === "include" ? { $include: "logging.json" } : { level: "info" },
        }) + "\n";
      await withConfig(raw, async ({ configPath }) => {
        const target =
          location === "include" ? path.join(path.dirname(configPath), "logging.json") : configPath;
        if (location === "include") {
          fs.writeFileSync(target, includeRaw);
        }
        const publication = await import("../config/backup-rotation.js");
        const prepare = vi.spyOn(publication, "prepareConfigFileWrite");
        const backups = Array.from({ length: 5 }, (_, i) => `${target}.bak${i ? `.${i}` : ""}`);
        backups.forEach((file, i) => fs.writeFileSync(file, `recovery-${i}`));
        const open = fs.openSync;
        vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
          if (
            path.dirname(String(file)) === path.dirname(target) &&
            path.basename(String(file)).startsWith(".fs-safe-") &&
            String(file).endsWith(".tmp")
          ) {
            throw Object.assign(new Error("stage full"), { code: "ENOSPC" });
          }
          return open(file, flags, mode);
        });
        for (let attempt = 0; attempt < 5; attempt++) {
          await reject(set("logging.level", "debug"));
          expect(read(configPath)).toBe(raw);
          expect(read(target)).toBe(location === "include" ? includeRaw : raw);
          expect(prepare.mock.calls.at(-1)?.[0].configPath).toBe(target);
          expect(backups.map((file) => read(file))).toEqual([
            "recovery-0",
            "recovery-1",
            "recovery-2",
            "recovery-3",
            "recovery-4",
          ]);
        }
      });
    },
  );

  it("openclaw config set preserves the parent mode when saving a long include filename", async () => {
    const name = "a".repeat(230) + ".json";
    const raw =
      JSON.stringify({ gateway: { mode: "local" }, logging: { $include: "shared/" + name } }) +
      "\n";
    await withConfig(raw, async ({ configPath, tempDir }) => {
      const parent = path.join(tempDir, "shared");
      fs.mkdirSync(parent, { mode: 0o750 });
      const mode = fs.statSync(parent).mode;
      const include = path.join(parent, name);
      const original = '{"level":"info"}\n';
      fs.writeFileSync(include, original);
      await set("logging.level", "debug");
      expect(readJson(include)).toEqual({ level: "debug" });
      expect(read(include + ".bak")).toBe(original);
      expect(read(configPath)).toBe(raw);
      expect(fs.statSync(parent).mode).toBe(mode);
    });
  });

  it.skipIf(process.platform === "win32").each([
    { alias: "direct", outcome: "save" },
    { alias: "direct", outcome: "root conflict" },
    { alias: "chain", outcome: "same target replacement" },
    { alias: "parent", outcome: "alias replacement" },
    { alias: "relative", outcome: "save" },
  ])(
    "openclaw config set preserves $alias include identity during fallback: $outcome",
    async ({ alias, outcome }) => {
      const raw =
        JSON.stringify({
          gateway: { mode: "local" },
          logging: {
            $include:
              alias === "parent"
                ? "alias/actual.json"
                : alias === "relative"
                  ? "links/logging.json"
                  : "logging.json",
          },
        }) + "\n";
      await withConfig(raw, async ({ configPath, tempDir }) => {
        const directory = alias === "parent" ? path.join(tempDir, "real") : tempDir;
        fs.mkdirSync(directory, { recursive: true });
        if (alias === "relative") {
          fs.mkdirSync(path.join(tempDir, "links"));
        }
        const target = path.join(directory, "actual.json");
        const original = '{"level":"info"}\n';
        fs.writeFileSync(target, original);
        const link = path.join(
          tempDir,
          alias === "parent"
            ? "alias"
            : alias === "chain"
              ? "next.json"
              : alias === "relative"
                ? "links/logging.json"
                : "logging.json",
        );
        const linkTarget =
          alias === "parent" ? "real" : alias === "relative" ? "../actual.json" : "actual.json";
        fs.symlinkSync(linkTarget, link);
        if (alias === "chain") {
          fs.symlinkSync("next.json", path.join(tempDir, "logging.json"));
        }
        const other = path.join(tempDir, "other");
        fs.mkdirSync(other);
        const external = path.join(other, "actual.json");
        const externalRaw = '{"level":"warn"}\n';
        fs.writeFileSync(external, externalRaw);
        const concurrentRoot =
          JSON.stringify({ ...JSON.parse(raw), messages: { responsePrefix: "external" } }) + "\n";
        const rename = fs.renameSync;
        vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
          if (to === target) {
            throw Object.assign(new Error("include rename denied"), { code: "EPERM" });
          }
          return rename(from, to);
        });
        let removed = false;
        const remove = fs.rmSync;
        vi.spyOn(fs, "rmSync").mockImplementation((file, options) => {
          remove(file, options);
          if (file === target && !removed) {
            removed = true;
            if (outcome === "root conflict") {
              fs.writeFileSync(configPath, concurrentRoot);
            } else if (outcome.endsWith("replacement")) {
              rename(link, `${link}.original`);
              fs.symlinkSync(
                outcome === "same target replacement"
                  ? linkTarget
                  : path.relative(path.dirname(link), alias === "parent" ? other : external),
                link,
              );
            }
          }
        });
        const save = set("logging.level", "debug");
        if (outcome === "save") {
          await save;
          expect(readJson(target)).toEqual({ level: "debug" });
        } else {
          await reject(save);
          expect(errors.join("\n")).toContain("Config publication failed after removing");
          if (outcome === "root conflict") {
            expect(read(target)).toBe(original);
            expect(errors.join("\n")).toContain("rolled back");
          } else {
            expect(fs.existsSync(target)).toBe(false);
            expect(errors.join("\n")).toContain(`${target}.bak`);
            expect(read(external)).toBe(externalRaw);
          }
        }
        expect(removed).toBe(true);
        expect(read(`${target}.bak`)).toBe(original);
        expect(read(configPath)).toBe(outcome === "root conflict" ? concurrentRoot : raw);
      });
    },
  );

  it.each([
    {
      name: "empty inline batch",
      args: ["gateway.port", "19001", "--batch-json="],
      error: "Failed to parse --batch-json",
    },
    {
      name: "whitespace batch file path",
      args: ["gateway.port", "19001", "--batch-file", " \t"],
      error: "--batch-file must not be empty",
    },
  ])("honors config set batch input selection for $name", async ({ args, error }) => {
    const raw = '{"agents":{"entries":{"main":{}}},"gateway":{"port":18789}}\n';
    await withConfig(raw, async ({ configPath }) => {
      const command = set(...args, "--dry-run", "--json");
      await reject(command);

      expect(logs).toHaveLength(1);
      const result = JSON.parse(logs[0] ?? "");
      expect(result).toMatchObject({
        ok: false,
        operations: 0,
        configPath,
        inputModes: [],
      });
      expect(result.errors).toEqual([{ kind: "schema", message: expect.stringContaining(error) }]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(error);
      expect(read(configPath)).toBe(raw);
    });
  });

  it("recognizes root editor metadata before and after authored removal", async () => {
    await withConfig('{"$schema":"https://openclaw.ai/schema.json"}', async () => {
      await run("get", "$schema");
      expect(logs.join("\n")).toContain("https://openclaw.ai/schema.json");
      await run("unset", "$schema");
      errors.length = 0;
      await reject(run("get", "$schema"));
      expect(errors.join("\n")).toContain("Config path is valid but unset: $schema.");
      for (const field of ["$schema.child", "$notARealKey", "gateway.$schema"]) {
        errors.length = 0;
        await reject(run("get", field));
        expect(errors.join("\n")).toContain(`Unknown config path: ${field}.`);
      }
      await set("$schema", "https://openclaw.ai/schema.json");
      logs.length = 0;
      await run("get", "$schema");
      expect(logs.join("\n")).toContain("https://openclaw.ai/schema.json");
    });
  });

  it("explains unset managed metadata without recommending a refused write", async () => {
    await withConfig('{"gateway":{"port":18789}}', async ({ configPath }) => {
      const original = read(configPath);
      for (const field of [
        "meta",
        "meta.lastTouchedVersion",
        "meta.migrations",
        "meta.migrations.modelPolicyAllowlist",
        "meta.migrations.utilityModelSeparation",
      ]) {
        for (const json of [false, true]) {
          logs.length = 0;
          errors.length = 0;
          await reject(run("get", field, ...(json ? ["--json"] : [])));
          const message = json ? JSON.parse(logs[0] ?? "").error.message : errors[0];
          expect(message).toContain(`Config path is valid but unset: ${field}.`);
          expect(message).toContain("managed automatically by OpenClaw");
          expect(message).not.toContain("openclaw config set");
          expect(message).not.toContain("runtime default");
        }
      }
      for (const field of ["logging.level", "meta.migrations.webhookListeners"]) {
        errors.length = 0;
        await reject(run("get", field));
        expect(errors[0]).toContain(`openclaw config set ${field} <value>`);
      }
      expect(read(configPath)).toBe(original);
    });
  });

  it("classifies unset model metadata while preserving authored values", async () => {
    const modelPath = "models.providers.fixture.models[0]";
    const raw = JSON.stringify({
      agents: { entries: { main: {} } },
      models: {
        providers: {
          fixture: {
            baseUrl: "https://provider.example.invalid/v1",
            api: "openai-completions",
            models: [
              {
                id: "qa-model",
                name: "QA Model",
                params: { nil: null, off: false, zero: 0, empty: "" },
              },
            ],
          },
        },
      },
    });
    await withConfig(raw, async ({ configPath }) => {
      const get = (field: string, json: boolean) => {
        logs.length = 0;
        errors.length = 0;
        return run("get", field, ...(json ? ["--json"] : []));
      };
      await get(modelPath, true);
      expect(errors).toEqual([]);
      expect(logs).toHaveLength(1);
      const model = JSON.parse(logs[0] ?? "");
      expect(model).toMatchObject({ id: "qa-model", reasoning: false });
      expect(model).not.toHaveProperty("contextWindow");
      expect(model).not.toHaveProperty("contextTokens");
      for (const [field, prefix, remedy] of [
        ["contextWindow", "Config path is valid but unset", "openclaw config set"],
        ["params.custom.nested", "Config path is valid but unset", "openclaw config set"],
        ["params.items[0].name", "Config path is valid but unset", "openclaw config set"],
        ["headers.X-Future", "Config path is valid but unset", "openclaw config set"],
        ["headers.X-Future.nested", "Unknown config path", "openclaw config schema"],
        ["notAConfigField", "Unknown config path", "openclaw config schema"],
      ]) {
        const getterPath = `${modelPath}.${field}`;
        for (const json of [false, true]) {
          await reject(get(getterPath, json));
          let message: string;
          if (json) {
            expect(errors).toEqual([]);
            expect(logs).toHaveLength(1);
            const failure = JSON.parse(logs[0] ?? "");
            expect(failure).toEqual({
              ok: false,
              error: { type: "cli_error", message: expect.any(String) },
            });
            message = failure.error.message;
          } else {
            expect(logs).toEqual([]);
            expect(errors).toHaveLength(1);
            message = errors[0] ?? "";
          }
          expect(message).toContain(`${prefix}: ${getterPath}.`);
          expect(message).toContain(remedy);
        }
      }
      for (const [field, value, text] of [
        ["nil", null, "null"],
        ["off", false, "false\n"],
        ["zero", 0, "0\n"],
        ["empty", "", "\n"],
      ]) {
        for (const json of [false, true]) {
          await get(`${modelPath}.params.${field}`, json);
          expect(errors).toEqual([]);
          expect(logs).toHaveLength(1);
          expect(json ? JSON.parse(logs[0] ?? "") : logs[0]).toEqual(json ? value : text);
        }
      }
      expect(read(configPath)).toBe(raw);
    });
  });

  it("redacts SecretRef ids and plugin-only sensitive fields in JSON/text order", async () => {
    const secretRefId = "CONFIG_GET_TEST_TOKEN";
    const schemaOnlySecrets = ["first-private-route", "second-private-route"];
    await withConfig(
      `${JSON.stringify(
        {
          channels: {
            discord: {
              enabled: false,
              token: { source: "env", provider: "default", id: secretRefId },
            },
          },
          plugins: {
            entries: {
              codex: {
                enabled: true,
                config: {
                  appServer: {
                    headers: {
                      "X-First": schemaOnlySecrets[0],
                      "X-Second": schemaOnlySecrets[1],
                    },
                  },
                },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      async () => {
        const output = createTestRuntime();
        await runConfigGet({ path: "channels.discord.token", json: true, runtime: output.runtime });
        await runConfigGet({ path: "channels.discord.token.id", runtime: output.runtime });
        await runConfigGet({
          path: "plugins.entries.codex.config.appServer.headers",
          json: true,
          runtime: output.runtime,
        });
        await runConfigGet({
          path: "plugins.entries.codex.config.appServer.headers",
          runtime: output.runtime,
        });

        expect(output.errors).toStrictEqual([]);
        expect(output.logs).toStrictEqual([
          JSON.stringify({ source: "env", provider: "default", id: REDACTED_SENTINEL }, null, 2),
          `${REDACTED_SENTINEL}\n`,
          JSON.stringify(REDACTED_SENTINEL),
          `${REDACTED_SENTINEL}\n`,
        ]);
        expect(output.logs.join("\n")).not.toContain(secretRefId);
        for (const secret of schemaOnlySecrets) {
          expect(output.logs.join("\n")).not.toContain(secret);
        }
      },
    );
  });

  it.each([
    {
      name: "plugin metadata is absent",
      installFailure: async () => {
        const snapshot = await configRuntime.readConfigFileSnapshot({ observe: false });
        vi.spyOn(configRuntime, "readConfigFileSnapshotWithPluginMetadata").mockResolvedValue({
          snapshot,
        });
      },
      expectedError: "plugin metadata unavailable",
    },
    {
      name: "schema construction fails",
      installFailure: async () => {
        vi.spyOn(runtimeSchema, "buildRuntimeConfigSchemaFromRegistry").mockImplementation(() => {
          throw new Error("schema construction unavailable");
        });
      },
      expectedError: "schema construction unavailable",
    },
  ])("fails closed before config get emits values when $name", async (testCase) => {
    await withConfig("{ gateway: { port: 19001 } }\n", async () => {
      await testCase.installFailure();
      const output = createTestRuntime();

      await expect(runConfigGet({ path: "gateway.port", runtime: output.runtime })).rejects.toThrow(
        "__exit__:1",
      );

      expect(output.logs).toStrictEqual([]);
      expect(output.errors.join("\n")).toContain(testCase.expectedError);
      expect(output.errors.join("\n")).not.toContain("19001");
    });
  });

  it("repairs a stale agent deployment patch without changing policy", async () => {
    const configForExec = (exec: Record<string, string>) => ({
      agents: { entries: { worker: { tools: { exec } } } },
    });
    const migrated = configForExec({ mode: "ask" });
    const migratedRaw = JSON.stringify(migrated) + "\n";
    await withConfig(migratedRaw, async ({ configPath, tempDir }) => {
      const patchPath = path.join(tempDir, "patch.json5");
      fs.writeFileSync(
        patchPath,
        JSON.stringify(configForExec({ security: "allowlist", ask: "on-miss" })),
      );
      const output = createTestRuntime();

      await expect(
        runConfigPatch({ cliOptions: { file: patchPath }, runtime: output.runtime }),
      ).rejects.toThrow("__exit__:1");

      expect(read(configPath)).toBe(migratedRaw);
      const diagnostic = output.errors.join("\n");
      expect(diagnostic).toContain("agents.entries.worker.tools.exec.mode:");
      expect(diagnostic).toContain('Replace security/ask with mode="ask"');
      expect(diagnostic).toContain("at this scope");

      fs.writeFileSync(patchPath, JSON.stringify({ ...migrated, messages: { ackReaction: "✅" } }));
      await runConfigPatch({ cliOptions: { file: patchPath }, runtime: output.runtime });
      expect(load(configPath)).toMatchObject({
        ...migrated,
        messages: { ackReaction: "✅" },
      });
    });
  });

  it("conflicts when a top-level include changes after config set starts", async () => {
    await withConfig(
      '{ gateway: { $include: "./gateway.json5" } }\n',
      async ({ configPath, tempDir }) => {
        const includePath = path.join(tempDir, "gateway.json5");
        const concurrentRaw = '{ port: 19002, bind: "loopback" }\n';
        fs.writeFileSync(includePath, "{ port: 18789 }\n", "utf8");
        clearConfigCache();
        installRuntimeSchemaReadHook(() => {
          fs.writeFileSync(includePath, concurrentRaw, "utf8");
        });
        const output = createTestRuntime();

        await expect(
          runConfigSet({
            path: "gateway.port",
            value: "19001",
            cliOptions: { strictJson: true },
            runtime: output.runtime,
          }),
        ).rejects.toThrow("__exit__:1");

        expect(read(configPath)).toBe('{ gateway: { $include: "./gateway.json5" } }\n');
        expect(read(includePath)).toBe(concurrentRaw);
        expect(output.errors.join("\n")).toContain("included config changed since last load");
      },
    );
  });

  it("accepts absent and exact authored expectations", async () => {
    await withConfig("{ gateway: { port: 18789 } }\n", async ({ configPath }) => {
      const absentOutput = createTestRuntime();
      await runConfigSet({
        path: "gateway.bind",
        value: '"loopback"',
        cliOptions: { strictJson: true, expectCurrentAbsent: true },
        runtime: absentOutput.runtime,
      });
      expect(absentOutput.errors).toStrictEqual([]);

      const exactOutput = createTestRuntime();
      await runConfigSet({
        path: "gateway.port",
        value: "19001",
        cliOptions: { strictJson: true, expectCurrentJson: "18789" },
        runtime: exactOutput.runtime,
      });
      expect(exactOutput.errors).toStrictEqual([]);
      expect(load(configPath)).toMatchObject({
        gateway: { bind: "loopback", port: 19001 },
      });
    });
  });

  it("rejects a conditional set when the authored value changed before CLI load", async () => {
    await withConfig("{ gateway: { port: 19002 } }\n", async ({ configPath }) => {
      const before = read(configPath);
      const output = createTestRuntime();

      await expect(
        runConfigSet({
          path: "gateway.port",
          value: "19001",
          cliOptions: { strictJson: true, expectCurrentJson: "18789" },
          runtime: output.runtime,
        }),
      ).rejects.toThrow("__exit__:1");

      expect(read(configPath)).toBe(before);
      expect(output.logs).toStrictEqual([]);
      expect(output.errors.join("\n")).toContain(
        "conditional config set expectation did not match the authored config",
      );
      expect(output.errors.join("\n")).toContain("No settings were saved");
      expect(output.errors.join("\n")).toContain(
        "Review the current config and any conditional expectations before retrying",
      );
      expect(output.errors.join("\n")).not.toContain("changed while this command was writing");
      expect(output.errors.join("\n")).not.toContain("Re-run the same command");
      expect(output.errors.join("\n")).not.toContain("18789");
      expect(output.errors.join("\n")).not.toContain("19002");
    });
  });

  it("keeps the snapshot hash guard after a matching conditional preflight", async () => {
    await withConfig("{ gateway: { port: 18789 } }\n", async ({ configPath }) => {
      const concurrentRaw = "{ gateway: { port: 19002 } }\n";
      const output = createTestRuntime();

      await expect(
        runConfigSet({
          path: "gateway.port",
          value: "19001",
          cliOptions: { strictJson: true, expectCurrentJson: "18789" },
          runtime: output.runtime,
          beforePersistentApply: () => {
            fs.writeFileSync(configPath, concurrentRaw, "utf8");
          },
        }),
      ).rejects.toThrow("__exit__:1");

      expect(read(configPath)).toBe(concurrentRaw);
      expect(output.logs).toStrictEqual([]);
      expect(output.errors.join("\n")).toContain("config changed since last load");
      expect(output.errors.join("\n")).not.toContain("18789");
      expect(output.errors.join("\n")).not.toContain("19002");
    });
  });

  it("preserves exact JSON5 bytes while rejecting an absent authored unset", async () => {
    const raw =
      '{\n  // preserve this comment and order\n  gateway: { port: 18789 },\n  logging: { level: "info" },\n}\n';
    await withConfig(raw, async ({ configPath }) => {
      const output = createTestRuntime();

      await expect(
        runConfigUnset({ path: "gateway.bind", runtime: output.runtime }),
      ).rejects.toThrow("__exit__:1");

      expect(read(configPath)).toBe(raw);
      expect(output.logs).toStrictEqual([]);
      expect(output.errors.join("\n")).toContain(
        "Config path not found: gateway.bind. Nothing was changed. Run openclaw config get <path> first if you are unsure of the path.",
      );
    });
  });

  it("writes an absent key even when its value equals the resolved default", async () => {
    const raw = "{\n  // the default is not authored yet\n  gateway: {},\n}\n";
    await withConfig(raw, async ({ configPath }) => {
      const output = createTestRuntime();

      await runConfigSet({
        path: "gateway.port",
        value: "18789",
        cliOptions: { strictJson: true },
        runtime: output.runtime,
      });

      const after = read(configPath);
      expect(after).not.toBe(raw);
      expect(JSON5.parse(after)).toMatchObject({ gateway: { port: 18789 } });
      expect(output.logs.join("\n")).not.toContain("No change");
    });
  });
});
