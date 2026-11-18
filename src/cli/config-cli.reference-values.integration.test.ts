import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot, readConfigFileSnapshotForWrite } from "../config/config.js";
import {
  ConfigWritePostCommitError,
  createConfigValidationFailedError,
} from "../config/io.write-errors.js";
import { registerManagedRuntimeConfigWriteOwner } from "../config/runtime-snapshot.js";
import {
  captureEnv,
  deleteTestEnvValue,
  setTestEnvValue,
  withEnvAsync,
} from "../test-utils/env.js";
import {
  createTestRuntime,
  useConfigCliIntegrationHarness,
} from "./config-cli.integration.test-harness.js";

const configRuntime = await import("../config/config.js");

const {
  registeredRuntimeLogs: logs,
  registeredRuntimeErrors: errors,
  runRegisteredConfigCommand: invoke,
  withConfigFileHarness: withFile,
} = useConfigCliIntegrationHarness();

const read = (file: string) => fs.readFileSync(file, "utf8");
const readJson = (file: string) => JSON.parse(read(file));
const run = (...args: string[]) => invoke(["config", ...args]);
const set = (...args: string[]) => invoke(["config", "set", ...args]);
const reject = (result: Promise<unknown>) =>
  expect(result).rejects.toMatchObject({ name: "ExitError", code: 1 });
const withConfig = (raw: string, visit: Parameters<typeof withFile>[2]) =>
  withFile("config-cli-", raw, visit);

describe("config CLI explicit reference values", () => {
  it("does not retain config env ownership from a rejected read", async () => {
    await withConfig("{}", async ({ configPath, tempDir }) => {
      const originalDir = path.join(fs.realpathSync(tempDir), "external-agent");
      const replacementDir = path.join(fs.realpathSync(tempDir), "config-agent");
      const vars = { CONFIG_REJECTED_AGENT_DIR: originalDir };
      await withEnvAsync({ CONFIG_REJECTED_AGENT_DIR: undefined }, async () => {
        fs.writeFileSync(configPath, JSON.stringify({ env: { vars }, agents: "invalid" }));
        expect((await readConfigFileSnapshot()).valid).toBe(false);
        expect(process.env.CONFIG_REJECTED_AGENT_DIR).toBeUndefined();
        const raw = JSON.stringify({
          env: { vars },
          agents: { entries: { main: { agentDir: "${CONFIG_REJECTED_AGENT_DIR}" } } },
        });
        fs.writeFileSync(configPath, raw);
        setTestEnvValue("CONFIG_REJECTED_AGENT_DIR", originalDir);
        const args = [
          "config",
          "set",
          "--batch-json",
          JSON.stringify([
            { path: "env.vars.CONFIG_REJECTED_AGENT_DIR", value: replacementDir },
            { path: "agents.entries.main.agentDir", value: "${CONFIG_REJECTED_AGENT_DIR}" },
          ]),
        ];
        await invoke([...args, "--dry-run"]);
        expect(read(configPath)).toBe(raw);
        await invoke(args);
        const saved = readJson(configPath);
        expect(saved.env.vars.CONFIG_REJECTED_AGENT_DIR).toBe(replacementDir);
        expect(saved.agents.entries.main.agentDir).toBe("${CONFIG_REJECTED_AGENT_DIR}");
        expect(process.env.CONFIG_REJECTED_AGENT_DIR).toBe(originalDir);
        expect((await readConfigFileSnapshot()).sourceConfig.agents?.entries?.main?.agentDir).toBe(
          originalDir,
        );
        expect(read(configPath + ".bak")).toBe(raw);
        expect(errors).toEqual([]);
      });
    });
  });

  it.each([false, true])(
    "refuses physical owner changes through config-owned environment edits (preview=%s)",
    async (preview) => {
      await withConfig("{}", async ({ configPath, tempDir }) => {
        const originalDir = path.join(fs.realpathSync(tempDir), "original-agent");
        const replacementDir = path.join(fs.realpathSync(tempDir), "replacement-agent");
        const raw = JSON.stringify({
          env: { vars: { CONFIG_EDITED_AGENT_DIR: originalDir } },
          agents: { entries: { main: { agentDir: "${CONFIG_EDITED_AGENT_DIR}" } } },
        });
        fs.writeFileSync(configPath, raw);
        await withEnvAsync({ CONFIG_EDITED_AGENT_DIR: undefined }, async () => {
          await reject(
            set(
              "--batch-json",
              JSON.stringify([
                { path: "env.vars.CONFIG_EDITED_AGENT_DIR", value: replacementDir },
                { path: "agents.entries.main.agentDir", value: "${CONFIG_EDITED_AGENT_DIR}" },
              ]),
              ...(preview ? ["--dry-run"] : []),
            ),
          );
          expect(errors.join("\n")).toContain("inherited auth");
          expect(read(configPath)).toBe(raw);
          expect(fs.existsSync(configPath + ".bak")).toBe(false);
        });
      });
    },
  );

  it("does not revalidate an untouched model reference during a parent merge preview", async () => {
    const raw = JSON.stringify({
      agents: { entries: { main: {} }, defaults: { model: "${CONFIG_UNTOUCHED_MODEL}" } },
    });
    await withConfig(raw, async ({ configPath }) => {
      await withEnvAsync(
        { CONFIG_UNTOUCHED_MODEL: "fixture-unavailable-provider/missing-model" },
        async () => {
          const args = [
            "config",
            "set",
            "agents.defaults",
            '{"maxConcurrent":3}',
            "--merge",
            "--strict-json",
          ];
          const previewError = await invoke([...args, "--dry-run", "--json"]).catch(
            (error: unknown) => error,
          );
          expect(previewError, [...logs, ...errors].join("\n")).toBeUndefined();
          expect(JSON.parse(logs.join("\n"))).toMatchObject({
            ok: true,
            refsChecked: 0,
          });
          expect(read(configPath)).toBe(raw);
          expect(fs.existsSync(configPath + ".bak")).toBe(false);
          await invoke(args);
          expect(readJson(configPath).agents.defaults).toMatchObject({
            model: "${CONFIG_UNTOUCHED_MODEL}",
            maxConcurrent: 3,
          });
          expect(read(configPath + ".bak")).toBe(raw);
          expect(errors).toEqual([]);
        },
      );
    });
  });

  it("checks models from the captured managed environment without writing", async () => {
    const raw = JSON.stringify({
      env: { vars: { CONFIG_CAPTURED_MODEL: "claude-cli/claude-sonnet-4-6" } },
      agents: { entries: { main: {} } },
    });
    await withConfig(raw, async ({ configPath }) => {
      const env = captureEnv(["CONFIG_CAPTURED_MODEL"]);
      const releaseOwner = registerManagedRuntimeConfigWriteOwner(configPath);
      try {
        deleteTestEnvValue("CONFIG_CAPTURED_MODEL");
        const prepared = await readConfigFileSnapshotForWrite();
        expect(prepared.writeOptions.envSnapshotForRestore?.CONFIG_CAPTURED_MODEL).toBe(
          "claude-cli/claude-sonnet-4-6",
        );
        expect(process.env.CONFIG_CAPTURED_MODEL).toBeUndefined();
        await reject(
          set(
            "agents.defaults.model",
            JSON.stringify("${CONFIG_CAPTURED_MODEL}"),
            "--dry-run",
            "--json",
          ),
        );
        // This harness excludes the backend from its catalog. The model must reach
        // that resolver and be refused, not remain unchecked due to missing read-time env.
        expect(JSON.parse(logs.join("\n"))).toMatchObject({
          ok: false,
          refsChecked: 1,
          checks: { resolvabilityComplete: true },
          errors: [expect.objectContaining({ kind: "model" })],
        });
        expect(logs.join("\n")).not.toContain("claude-cli/claude-sonnet-4-6");
        expect(read(configPath)).toBe(raw);
        expect(fs.existsSync(configPath + ".bak")).toBe(false);
        expect(errors).toEqual([]);
      } finally {
        releaseOwner();
        env.restore();
      }
    });
  });

  it("redacts environment-expanded model errors without writing", async () => {
    const raw = JSON.stringify({ agents: { entries: { main: {} } } });
    await withConfig(raw, async ({ configPath }) => {
      await withEnvAsync({ CONFIG_PRIVATE_MODEL: undefined }, async () => {
        const privateValue = "fixture-private-provider/fixture-private-model";
        const authored = "${CONFIG_PRIVATE_MODEL}";
        setTestEnvValue("CONFIG_PRIVATE_MODEL", privateValue);
        await reject(set("agents.defaults.model", authored, "--dry-run"));
        const output = [...logs, ...errors].join("\n");
        expect(output).not.toContain(privateValue);
        expect(output).not.toContain("fixture-private-provider");
        expect(output).not.toContain("fixture-private-model");
        expect(output).toContain("Cannot set model reference");
        expect(read(configPath)).toBe(raw);
        expect(fs.existsSync(configPath + ".bak")).toBe(false);
      });
    });
  });

  it("prints only a no-write dry-run JSON summary for reference values", async () => {
    const raw = JSON.stringify({ agents: { entries: { main: {} } }, browser: { enabled: true } });
    await withConfig(raw, async ({ configPath }) => {
      const privateValue = "/opt/fixture-dry-run-private-value";
      await withEnvAsync({ CONFIG_DRY_RUN_VALUE: privateValue }, async () => {
        await set(
          "browser.executablePath",
          JSON.stringify("$${CONFIG_DRY_RUN_VALUE}"),
          "--dry-run",
          "--json",
        );
        const output = [...logs, ...errors].join("\n");
        expect(output).not.toContain(privateValue);
        expect(output).not.toContain("CONFIG_DRY_RUN_VALUE");
        expect(JSON.parse(logs.join("\n"))).toMatchObject({ ok: true, operations: 1 });
        expect(JSON.parse(logs.join("\n"))).not.toHaveProperty("config");
        expect(read(configPath)).toBe(raw);
        expect(fs.existsSync(configPath + ".bak")).toBe(false);
        expect(errors).toEqual([]);
      });
    });
  });
});

describe("config CLI ordered writer policy", () => {
  it.each([
    { include: false, deleted: 0 },
    { include: true, deleted: 1 },
  ])(
    "preserves ordered writer policy through registered deletion (include=$include, deleted=$deleted)",
    async ({ include, deleted }) => {
      const provider = {
        baseUrl: "http://127.0.0.1:12345",
        api: "openai-completions",
        models: [
          { id: "drop", name: "drop" },
          { id: "edited", name: "$${CONFIG_POLICY_TARGET}" },
          { id: "untouched", name: "$${CONFIG_POLICY_OTHER}" },
        ],
      };
      const raw = JSON.stringify({
        agents: { entries: { main: {} } },
        models: { providers: { example: include ? { $include: "./provider.json" } : provider } },
      });
      await withConfig(raw, async ({ configPath, tempDir }) => {
        const ownedPath = include ? path.join(tempDir, "provider.json") : configPath;
        if (include) {
          fs.writeFileSync(ownedPath, JSON.stringify(provider));
        }
        const before = read(ownedPath);
        await withEnvAsync(
          { CONFIG_POLICY_TARGET: "activated-model", CONFIG_POLICY_OTHER: "unrelated-model" },
          async () => {
            const { runConfigOperations } = await import("./config-cli-runner.js");
            const target = ["models", "providers", "example", "models", "1", "name"];
            const removed = ["models", "providers", "example", "models", String(deleted)];
            const { runtime, errors: writeErrors } = createTestRuntime();
            await runConfigOperations({
              runtime,
              options: {},
              successMode: "patch",
              operations: [
                {
                  inputMode: "json",
                  requestedPath: target,
                  setPath: target,
                  value: "${CONFIG_POLICY_TARGET}",
                },
                {
                  inputMode: "unset",
                  requestedPath: removed,
                  setPath: removed,
                  value: undefined,
                  mutation: "delete",
                },
              ],
            });
            const saved = readJson(ownedPath);
            const models = include ? saved.models : saved.models.providers.example.models;
            expect(models).toEqual([
              deleted === 0
                ? { id: "edited", name: "${CONFIG_POLICY_TARGET}" }
                : provider.models[0],
              provider.models[2],
            ]);
            expect(read(ownedPath + ".bak")).toBe(before);
            expect(writeErrors).toEqual([]);
            setTestEnvValue("CONFIG_POLICY_TARGET", "rotated-model");
            const snapshot = await readConfigFileSnapshot();
            expect(snapshot.sourceConfig.models?.providers?.example?.models[0]?.name).toBe(
              deleted === 0 ? "rotated-model" : "drop",
            );
            const intermediate = read(ownedPath);
            await run("unset", "models.providers.example.models[0]");
            const final = readJson(ownedPath);
            expect(include ? final.models : final.models.providers.example.models).toEqual([
              provider.models[2],
            ]);
            expect(read(ownedPath + ".bak")).toBe(intermediate);
            if (include) {
              expect(read(configPath)).toBe(raw);
            }
            expect(errors).toEqual([]);
          },
        );
      });
    },
  );
});

describe("config cli SecretRef builder schema validation", () => {
  it("rejects an unregistered target in dry-run like a real write", async () => {
    const raw =
      '{"gateway":{"mode":"local"},"secrets":{"providers":{"default":{"source":"env"}}}}\n';
    await withFile("openclaw-config-cli-builder-schema-", raw, async ({ configPath }) => {
      await withEnvAsync({ OPENCLAW_CONFIG_DRY_RUN_TEST_SECRET: "fixture" }, async () => {
        const command = [
          "config",
          "set",
          "auth-profiles:main:profiles.deepseek.key",
          "--ref-provider",
          "default",
          "--ref-source",
          "env",
          "--ref-id",
          "OPENCLAW_CONFIG_DRY_RUN_TEST_SECRET",
        ];
        await expect(invoke([...command, "--dry-run"])).rejects.toThrow("exit 1");
        expect(errors.join("\n")).toContain('Unrecognized key: "auth-profiles:main:profiles"');
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);

        errors.length = 0;
        await expect(invoke(command)).rejects.toThrow("exit 1");
        expect(errors.join("\n")).toContain('Unrecognized key: "auth-profiles:main:profiles"');
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);

        await invoke([
          "config",
          "set",
          "gateway.auth.password",
          "--ref-provider",
          "default",
          "--ref-source",
          "env",
          "--ref-id",
          "OPENCLAW_CONFIG_DRY_RUN_TEST_SECRET",
          "--dry-run",
        ]);
        expect(logs.at(-1)).toContain("Dry run successful");
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
      });
    });
  });
});

describe("config CLI file imports", () => {
  // Windows normalizes trailing spaces, so these require distinct POSIX filenames.
  it.skipIf(process.platform === "win32").each([
    { command: "patch", flag: "--file", siblingLevel: "error" },
    { command: "set", flag: "--batch-file", siblingLevel: "warn" },
  ])(
    "config $command $flag reads the exact quoted filename",
    async ({ command, flag, siblingLevel }) => {
      await withFile(
        "openclaw-config-cli-literal-file-",
        '{"gateway":{"mode":"local"},"logging":{"level":"info"}}',
        async ({ configPath, tempDir }) => {
          const file = path.join(tempDir, "import.json5");
          const contents = (level: string) =>
            JSON.stringify(
              command === "patch"
                ? { logging: { level } }
                : [{ path: "logging.level", value: level }],
            );
          fs.writeFileSync(file, contents(siblingLevel));
          fs.writeFileSync(`${file} `, contents("debug"));

          await invoke(["config", command, flag, `${file} `]);

          expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toMatchObject({
            logging: { level: "debug" },
          });
        },
      );
    },
  );
});

describe("config CLI rejections", () => {
  it("explains rejected settings without saving and accepts their correction", async () => {
    const setting = "channels.discord.guilds.123456789012345678.requireMention";
    const raw =
      '{"channels":{"discord":{"guilds":{"123456789012345678":{"requireMention":true}}}}}\n';
    await withFile("openclaw-config-cli-refusal-", raw, async ({ configPath, tempDir }) => {
      const patchPath = path.join(tempDir, "patch.json");
      fs.writeFileSync(
        patchPath,
        '{"channels":{"discord":{"guilds":{"123456789012345678":{"requireMention":42}}}}}',
      );
      for (const [args, issue] of [
        [["set", setting, "oops"], "requireMention"],
        [["set", "gateway.nonexistentSetting", "true"], "nonexistentSetting"],
        [["patch", "--file", patchPath], "requireMention"],
      ] as const) {
        errors.length = 0;
        await expect(invoke(["config", ...args])).rejects.toMatchObject({
          name: "ExitError",
          code: 1,
        });
        const output = errors.join("\n");
        expect(output).toContain("Config change declined. No settings were saved.");
        expect(output).toContain(issue);
        expect(output).toContain("Correct the setting above and retry.");
        expect(output).toContain("openclaw config schema");
        expect(output).not.toMatch(/Stack:|Debug:|CLI failed|\bat .*\.ts:\d/);
        expect(logs).toEqual([]);
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
      }
      errors.length = 0;
      await invoke(["config", "set", setting, "false"]);
      expect(
        JSON5.parse(fs.readFileSync(configPath, "utf8")).channels.discord.guilds[
          "123456789012345678"
        ].requireMention,
      ).toBe(false);
      expect(errors).toEqual([]);
      expect(logs.join("\n")).toContain("Updated");
    });
  });

  it.each([
    new Error("Config validation failed: unexpected write failure"),
    new ConfigWritePostCommitError({
      configPath: "/tmp/openclaw.json",
      rollbackStatus: "unknown",
      cause: createConfigValidationFailedError([
        { path: "gateway.port", message: "late validation failure" },
      ]),
    }),
  ])("does not relabel operational failures as unsaved settings: %s", async (error) => {
    await withFile("openclaw-config-cli-operational-", "{}", async () => {
      vi.spyOn(configRuntime, "replaceConfigFile").mockRejectedValueOnce(error);
      await expect(invoke(["config", "set", "gateway.port", "19000"])).rejects.toMatchObject({
        name: "ExitError",
        code: 1,
      });
      const output = errors.join("\n");
      expect(output).toContain(error.message);
      expect(output).not.toContain("No settings were saved");
      expect(output).not.toContain("Correct the setting above");
      expect(logs).toEqual([]);
    });
  });
});

const ownerPath = "agents.defaults.sessionStore.agentId";

function fleetConfig(store?: string) {
  return {
    agents: {
      ownership: "explicit",
      defaults: {
        bootstrapMaxChars: 30000,
        sessionStore: { agentId: "discord-main" },
        authInheritance: { agentId: "discord-main" },
        systemAgent: { agentId: "discord-main" },
      },
      entries: {
        "discord-main": {},
        "anthropic-main": {},
        "local-helper": {},
        "xai-main": {},
      },
    },
    ...(store ? { session: { store } } : {}),
  };
}

describe("config CLI session store ownership", () => {
  it("preserves the default store owner across no-op and unrelated sets", async () => {
    const original = fleetConfig();
    const raw = JSON.stringify(original);
    await withConfig(raw, async ({ configPath }) => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      await set("agents.defaults.bootstrapMaxChars", "30000");
      expect(logs.join("\n")).toContain("No change");
      expect(read(configPath)).toBe(raw);

      await set("agents.defaults.bootstrapMaxChars", "30001");
      const after = readJson(configPath);
      expect(after.agents.defaults).toEqual({
        ...original.agents.defaults,
        bootstrapMaxChars: 30001,
      });
      expect(after.session?.store).toBeUndefined();
      await run("get", ownerPath);
      expect(logs.at(-1)?.trim()).toBe("discord-main");
      expect(warning.mock.calls.flat().join("\n")).not.toContain(`Cleared ${ownerPath}`);
    });
  });

  it("clears the copied owner with a warning when reverting to the default store", async () => {
    await withConfig("{}", async ({ configPath, tempDir }) => {
      const original = fleetConfig(path.join(tempDir, "source.sqlite"));
      fs.writeFileSync(configPath, JSON.stringify(original));
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const args = ["config", "unset", "session.store"];
      await invoke([...args, "--dry-run"]);
      expect(warning.mock.calls.flat().join("\n")).not.toContain(`Cleared ${ownerPath}`);
      await invoke(args);
      const saved = readJson(configPath);
      expect(saved.agents.defaults.sessionStore?.agentId).toBeUndefined();
      expect(saved.agents.defaults.authInheritance).toEqual(
        original.agents.defaults.authInheritance,
      );
      expect(saved.agents.defaults.systemAgent).toEqual(original.agents.defaults.systemAgent);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(`Cleared ${ownerPath} because session.store changed`),
      );
    });
  });
});
