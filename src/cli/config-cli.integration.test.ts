// Config CLI integration tests cover end-to-end config command reads and writes.
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it, vi } from "vitest";
import {
  createTestRuntime,
  useConfigCliIntegrationHarness,
} from "./config-cli.integration.test-harness.js";

// Register the harness metadata mock before loading the real config and command modules.
const configRuntime = await import("../config/config.js");
const { clearConfigCache } = configRuntime;
const { formatConfigIssueLines } = await import("../config/issue-format.js");
const { REDACTED_SENTINEL } = await import("../config/redact-snapshot.js");
const runtimeSchema = await import("../config/runtime-schema.js");
const { runConfigGet, runConfigPatch, runConfigSet, runConfigUnset } =
  await import("./config-cli.js");
const {
  registeredRuntimeLogs,
  registeredRuntimeErrors,
  runRegisteredConfigCommand,
  withConfigFileHarness,
} = useConfigCliIntegrationHarness();

function installRuntimeSchemaReadHook(hook: () => void | Promise<void>): void {
  const readSchema = runtimeSchema.readBestEffortRuntimeConfigSchema;
  vi.spyOn(runtimeSchema, "readBestEffortRuntimeConfigSchema").mockImplementation(async () => {
    const result = await readSchema();
    await hook();
    return result;
  });
}

describe("config cli integration", () => {
  it("renders actionable paths for real dotted model-key validation failures", async () => {
    const configForAlias = (alias: string | number) => ({
      agents: {
        entries: { main: {} },
        defaults: { models: { "fixture/model.v1": { alias } } },
      },
    });
    const raw = `${JSON.stringify(configForAlias(42), null, 2)}\n`;
    const displayPath = 'agents.defaults.models["fixture/model.v1"].alias';
    const issuePath = "agents.defaults.models.fixture/model.v1.alias";

    await withConfigFileHarness(
      "openclaw-config-cli-dotted-diagnostic-",
      raw,
      async ({ configPath }) => {
        const snapshot = await configRuntime.readConfigFileSnapshot({ observe: false });
        expect(snapshot.valid).toBe(false);
        expect(snapshot.issues).toHaveLength(1);
        expect(snapshot.issues[0]).toMatchObject({
          path: issuePath,
          pathSegments: ["agents", "defaults", "models", "fixture/model.v1", "alias"],
          message: expect.stringContaining("expected string"),
        });

        for (const args of [
          ["config", "validate"],
          ["config", "get", displayPath],
        ]) {
          registeredRuntimeErrors.length = 0;
          await expect(runRegisteredConfigCommand(args)).rejects.toMatchObject({
            name: "ExitError",
            code: 1,
          });
          const diagnostic = registeredRuntimeErrors.join("\n");
          expect(diagnostic).toContain(`openclaw.json:9 — ${displayPath}:`);
          expect(diagnostic).toContain("expected string");
          expect(diagnostic).not.toContain(`${issuePath}:`);
          expect(registeredRuntimeLogs).toEqual([]);
        }

        registeredRuntimeErrors.length = 0;
        await expect(
          runRegisteredConfigCommand(["config", "validate", "--json"]),
        ).rejects.toMatchObject({ name: "ExitError", code: 1 });
        expect(registeredRuntimeErrors).toEqual([]);
        expect(registeredRuntimeLogs).toHaveLength(1);
        expect(JSON.parse(registeredRuntimeLogs[0] ?? "")).toMatchObject({
          valid: false,
          path: configPath,
          issues: [{ path: issuePath, message: expect.stringContaining("expected string") }],
        });
        expect(registeredRuntimeLogs[0]).not.toContain("pathSegments");
        expect(formatConfigIssueLines(snapshot.issues, "")).toEqual([
          expect.stringContaining(`${displayPath}:`),
        ]);
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
      },
    );

    registeredRuntimeLogs.length = 0;
    const validRaw = `${JSON.stringify(configForAlias("qa"), null, 2)}\n`;
    await withConfigFileHarness(
      "openclaw-config-cli-dotted-lookup-",
      validRaw,
      async ({ configPath }) => {
        await runRegisteredConfigCommand(["config", "get", displayPath, "--json"]);
        expect(registeredRuntimeLogs).toEqual(['"qa"']);
        expect(registeredRuntimeErrors).toEqual([]);
        expect(fs.readFileSync(configPath, "utf8")).toBe(validRaw);
      },
    );
  });

  it("classifies real unset model metadata without losing authored values", async () => {
    const providerId = "qa-config-absence";
    const providerPath = `models.providers.${providerId}`;
    const modelPath = `${providerPath}.models[0]`;
    const syntheticSecret = "qa-config-get-redaction-marker";
    const raw = `${JSON.stringify(
      {
        agents: { entries: { main: {} } },
        models: {
          providers: {
            [providerId]: {
              baseUrl: "https://provider.example.invalid/v1",
              api: "openai-completions",
              apiKey: syntheticSecret,
              models: [
                {
                  id: "qa-model",
                  name: "QA Model",
                  params: { qaNull: null, qaFalse: false, qaZero: 0, qaEmpty: "" },
                },
                {
                  id: "qa-sized-model",
                  name: "QA Sized Model",
                  contextWindow: 32768,
                  contextTokens: 16384,
                },
              ],
            },
          },
        },
      },
      null,
      2,
    )}\n`;

    await withConfigFileHarness("openclaw-config-cli-unset-model-", raw, async ({ configPath }) => {
      const snapshot = await configRuntime.readConfigFileSnapshot({ observe: false });
      expect(snapshot.valid).toBe(true);
      expect(snapshot.issues).toEqual([]);
      const authored = snapshot.sourceConfig.models?.providers?.[providerId]?.models[0];
      const materialized = snapshot.config.models?.providers?.[providerId]?.models[0];
      if (!authored || !materialized) {
        throw new Error("Expected the authored and materialized model fixture");
      }
      for (const field of ["contextWindow", "contextTokens"] as const) {
        expect(Object.hasOwn(authored, field)).toBe(false);
        expect(materialized[field]).toBeUndefined();
      }
      expect(materialized.reasoning).toBe(false);

      const get = (getterPath: string, json: boolean) => {
        registeredRuntimeLogs.length = 0;
        registeredRuntimeErrors.length = 0;
        return runRegisteredConfigCommand([
          "config",
          "get",
          getterPath,
          ...(json ? ["--json"] : []),
        ]);
      };
      await get(modelPath, true);
      expect(registeredRuntimeErrors).toEqual([]);
      expect(registeredRuntimeLogs).toHaveLength(1);
      const modelJson = JSON.parse(registeredRuntimeLogs[0] ?? "");
      expect(modelJson).toMatchObject({ id: "qa-model", reasoning: false });
      expect(modelJson).not.toHaveProperty("contextWindow");
      expect(modelJson).not.toHaveProperty("contextTokens");

      const failures = [
        {
          field: "contextWindow",
          prefix: "Config path is valid but unset",
          remedy: "openclaw config set",
        },
        {
          field: "contextTokens",
          prefix: "Config path is valid but unset",
          remedy: "openclaw config set",
        },
        {
          field: "notAConfigField",
          prefix: "Unknown config path",
          remedy: "openclaw config schema",
        },
      ];
      for (const { field, prefix, remedy } of failures) {
        const getterPath = `${modelPath}.${field}`;
        for (const json of [false, true]) {
          await expect(get(getterPath, json)).rejects.toMatchObject({
            name: "ExitError",
            code: 1,
          });
          let message: string;
          if (json) {
            expect(registeredRuntimeErrors).toEqual([]);
            expect(registeredRuntimeLogs).toHaveLength(1);
            const failure = JSON.parse(registeredRuntimeLogs[0] ?? "");
            expect(failure).toEqual({
              ok: false,
              error: { type: "cli_error", message: expect.any(String) },
            });
            message = failure.error.message;
          } else {
            expect(registeredRuntimeLogs).toEqual([]);
            expect(registeredRuntimeErrors).toHaveLength(1);
            message = registeredRuntimeErrors[0] ?? "";
          }
          expect(message).toContain(`${prefix}: ${getterPath}.`);
          expect(message).toContain(remedy);
          expect(message).not.toContain(syntheticSecret);
        }
      }

      const values = [
        { path: `${modelPath}.params.qaNull`, value: null, text: "null" },
        { path: `${modelPath}.params.qaFalse`, value: false, text: "false\n" },
        { path: `${modelPath}.params.qaZero`, value: 0, text: "0\n" },
        { path: `${modelPath}.params.qaEmpty`, value: "", text: "\n" },
        { path: `${providerPath}.models[1].contextWindow`, value: 32768, text: "32768\n" },
        { path: `${providerPath}.models[1].contextTokens`, value: 16384, text: "16384\n" },
        {
          path: `${providerPath}.apiKey`,
          value: REDACTED_SENTINEL,
          text: `${REDACTED_SENTINEL}\n`,
        },
      ];
      for (const { path: getterPath, value, text } of values) {
        for (const json of [false, true]) {
          await get(getterPath, json);
          expect(registeredRuntimeErrors).toEqual([]);
          expect(registeredRuntimeLogs).toHaveLength(1);
          if (json) {
            expect(JSON.parse(registeredRuntimeLogs[0] ?? "")).toEqual(value);
          } else {
            expect(registeredRuntimeLogs).toEqual([text]);
          }
          expect(registeredRuntimeLogs.join("\n")).not.toContain(syntheticSecret);
        }
      }
      await get(providerPath, true);
      expect(JSON.parse(registeredRuntimeLogs[0] ?? "")).toMatchObject({
        apiKey: REDACTED_SENTINEL,
      });
      expect(registeredRuntimeLogs.join("\n")).not.toContain(syntheticSecret);
      expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
    });
  });

  it("redacts SecretRef ids and plugin-only sensitive fields in JSON/text order", async () => {
    const secretRefId = "CONFIG_GET_TEST_TOKEN";
    const schemaOnlySecrets = ["first-private-route", "second-private-route"];
    await withConfigFileHarness(
      "openclaw-config-cli-get-redaction-",
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
    await withConfigFileHarness(
      "openclaw-config-cli-get-fail-closed-",
      "{ gateway: { port: 19001 } }\n",
      async () => {
        await testCase.installFailure();
        const output = createTestRuntime();

        await expect(
          runConfigGet({ path: "gateway.port", runtime: output.runtime }),
        ).rejects.toThrow("__exit__:1");

        expect(output.logs).toStrictEqual([]);
        expect(output.errors.join("\n")).toContain(testCase.expectedError);
        expect(output.errors.join("\n")).not.toContain("19001");
      },
    );
  });

  it.each(["root", "agent"])(
    "repairs a stale deployment patch at %s scope without changing policy",
    async (scope) => {
      const configForExec = (exec: Record<string, string>) =>
        scope === "root"
          ? { tools: { exec } }
          : { agents: { entries: { worker: { tools: { exec } } } } };
      const migrated = configForExec({ mode: "ask" });
      const migratedRaw = JSON.stringify(migrated) + "\n";
      await withConfigFileHarness(
        "openclaw-config-cli-patch-exec-mode-migrated-",
        migratedRaw,
        async ({ configPath, tempDir }) => {
          const patchPath = path.join(tempDir, "patch.json5");
          fs.writeFileSync(
            patchPath,
            JSON.stringify(configForExec({ security: "allowlist", ask: "on-miss" })),
          );
          const output = createTestRuntime();

          await expect(
            runConfigPatch({ cliOptions: { file: patchPath }, runtime: output.runtime }),
          ).rejects.toThrow("__exit__:1");

          expect(fs.readFileSync(configPath, "utf8")).toBe(migratedRaw);
          const errors = output.errors.join("\n");
          expect(errors).toContain(
            scope === "root" ? "tools.exec.mode:" : "agents.entries.worker.tools.exec.mode:",
          );
          expect(errors).toContain('Replace security/ask with mode="ask"');
          expect(errors).toContain("at this scope");

          fs.writeFileSync(
            patchPath,
            JSON.stringify({ ...migrated, messages: { ackReaction: "✅" } }),
          );
          await runConfigPatch({ cliOptions: { file: patchPath }, runtime: output.runtime });
          expect(JSON5.parse(fs.readFileSync(configPath, "utf8"))).toMatchObject({
            ...migrated,
            messages: { ackReaction: "✅" },
          });
        },
      );
    },
  );

  it("conflicts when a top-level include changes after config set starts", async () => {
    await withConfigFileHarness(
      "openclaw-config-cli-include-conflict-",
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

        expect(fs.readFileSync(configPath, "utf8")).toBe(
          '{ gateway: { $include: "./gateway.json5" } }\n',
        );
        expect(fs.readFileSync(includePath, "utf8")).toBe(concurrentRaw);
        expect(output.errors.join("\n")).toContain("included config changed since last load");
      },
    );
  });

  it("preserves exact JSON5 bytes when setting an authored value to itself", async () => {
    const raw =
      '{\n  // preserve this comment and order\n  gateway: { port: 18789 },\n  logging: { level: "info" },\n}\n';
    await withConfigFileHarness("openclaw-config-cli-noop-", raw, async ({ configPath }) => {
      const output = createTestRuntime();

      await runConfigSet({
        path: "gateway.port",
        value: "18789",
        cliOptions: { strictJson: true },
        runtime: output.runtime,
      });

      expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
      expect(output.errors).toStrictEqual([]);
      expect(output.logs).toStrictEqual(["No change"]);
    });
  });

  it("accepts absent and exact authored expectations", async () => {
    await withConfigFileHarness(
      "openclaw-config-cli-conditional-success-",
      "{ gateway: { port: 18789 } }\n",
      async ({ configPath }) => {
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
        expect(JSON5.parse(fs.readFileSync(configPath, "utf8"))).toMatchObject({
          gateway: { bind: "loopback", port: 19001 },
        });
      },
    );
  });

  it("rejects a conditional set when the authored value changed before CLI load", async () => {
    await withConfigFileHarness(
      "openclaw-config-cli-conditional-preload-conflict-",
      "{ gateway: { port: 19002 } }\n",
      async ({ configPath }) => {
        const before = fs.readFileSync(configPath, "utf8");
        const output = createTestRuntime();

        await expect(
          runConfigSet({
            path: "gateway.port",
            value: "19001",
            cliOptions: { strictJson: true, expectCurrentJson: "18789" },
            runtime: output.runtime,
          }),
        ).rejects.toThrow("__exit__:1");

        expect(fs.readFileSync(configPath, "utf8")).toBe(before);
        expect(output.logs).toStrictEqual([]);
        expect(output.errors.join("\n")).toContain(
          "conditional config set expectation did not match the authored config",
        );
        expect(output.errors.join("\n")).not.toContain("18789");
        expect(output.errors.join("\n")).not.toContain("19002");
      },
    );
  });

  it("keeps the snapshot hash guard after a matching conditional preflight", async () => {
    await withConfigFileHarness(
      "openclaw-config-cli-conditional-postload-race-",
      "{ gateway: { port: 18789 } }\n",
      async ({ configPath }) => {
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

        expect(fs.readFileSync(configPath, "utf8")).toBe(concurrentRaw);
        expect(output.logs).toStrictEqual([]);
        expect(output.errors.join("\n")).toContain("config changed since last load");
        expect(output.errors.join("\n")).not.toContain("18789");
        expect(output.errors.join("\n")).not.toContain("19002");
      },
    );
  });

  it("preserves exact JSON5 bytes while rejecting an absent authored unset", async () => {
    const raw =
      '{\n  // preserve this comment and order\n  gateway: { port: 18789 },\n  logging: { level: "info" },\n}\n';
    await withConfigFileHarness(
      "openclaw-config-cli-missing-unset-",
      raw,
      async ({ configPath }) => {
        const output = createTestRuntime();

        await expect(
          runConfigUnset({ path: "gateway.bind", runtime: output.runtime }),
        ).rejects.toThrow("__exit__:1");

        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(output.logs).toStrictEqual([]);
        expect(output.errors.join("\n")).toContain(
          "Config path not found: gateway.bind. Nothing was changed. Run openclaw config get <path> first if you are unsure of the path.",
        );
      },
    );
  });

  it("writes an absent key even when its value equals the resolved default", async () => {
    const raw = "{\n  // the default is not authored yet\n  gateway: {},\n}\n";
    await withConfigFileHarness(
      "openclaw-config-cli-default-equal-write-",
      raw,
      async ({ configPath }) => {
        const output = createTestRuntime();

        await runConfigSet({
          path: "gateway.port",
          value: "18789",
          cliOptions: { strictJson: true },
          runtime: output.runtime,
        });

        const after = fs.readFileSync(configPath, "utf8");
        expect(after).not.toBe(raw);
        expect(JSON5.parse(after)).toMatchObject({ gateway: { port: 18789 } });
        expect(output.logs.join("\n")).not.toContain("No change");
      },
    );
  });

  it("accepts plugin hook conversation-access policy via config set", async () => {
    await withConfigFileHarness(
      "openclaw-config-cli-plugin-hooks-",
      "{ gateway: { port: 18789 } }\n",
      async ({ configPath }) => {
        const output = createTestRuntime();
        await runConfigSet({
          path: "plugins.entries.openclaw-mem0.hooks.allowConversationAccess",
          value: "true",
          cliOptions: {},
          runtime: output.runtime,
        });

        expect(output.errors).toStrictEqual([]);
        const afterWrite = JSON5.parse(fs.readFileSync(configPath, "utf8"));
        expect(afterWrite.plugins?.entries?.["openclaw-mem0"]?.hooks).toEqual({
          allowConversationAccess: true,
        });
      },
    );
  });
});
