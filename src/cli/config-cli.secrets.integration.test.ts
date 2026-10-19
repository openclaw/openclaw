// Config secret integration tests cover final-candidate validation and provider execution.
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  createTestRuntime,
  useConfigCliIntegrationHarness,
} from "./config-cli.integration.test-harness.js";

// Register the harness metadata mock before loading the real config and command modules.
const configRuntime = await import("../config/config.js");
const { runConfigSet, runConfigUnset } = await import("./config-cli.js");
const {
  registeredRuntimeErrors: errors,
  registeredRuntimeLogs: logs,
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

function sourceMismatchConfig(
  options: {
    source?: "env" | "exec";
    id?: string;
    defaults?: boolean;
    gateway?: boolean;
  } = {},
) {
  return `${JSON.stringify(
    {
      ...(options.gateway ? { gateway: { port: 18789 } } : {}),
      channels: {
        discord: {
          enabled: false,
          token: {
            source: options.source ?? "exec",
            provider: "shared",
            id: options.id ?? "discord/token",
          },
        },
      },
      secrets: {
        ...(options.defaults ? { defaults: { env: "shared" } } : {}),
        providers: {
          shared: { source: "file", path: "/tmp/openclaw-unused-secrets.json", mode: "json" },
        },
      },
    },
    null,
    2,
  )}\n`;
}

function createExecDryRunBatch(params: { markerPath: string }) {
  const response = JSON.stringify({
    protocolVersion: 1,
    values: {
      dryrun_id: "ok",
    },
  });
  const script = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(params.markerPath)}, JSON.stringify(process.argv.slice(2)), "utf8");`,
    `process.stdout.write(${JSON.stringify(response)});`,
  ].join("\n");
  const scriptPath = path.join(path.dirname(params.markerPath), "exec-provider.cjs");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  return [
    {
      path: "secrets.providers.runner",
      provider: {
        source: "exec",
        command: scriptPath,
        trustedDirs: [path.dirname(scriptPath)],
        timeoutMs: 60_000,
        noOutputTimeoutMs: 60_000,
      },
    },
    {
      path: "channels.discord.token",
      ref: {
        source: "exec",
        provider: "runner",
        id: "dryrun_id",
      },
    },
  ];
}

async function withExecDryRunConfigHarness(
  prefix: string,
  visit: (params: {
    batchPath: string;
    configPath: string;
    markerPath: string;
    runtime: ReturnType<typeof createTestRuntime>;
  }) => Promise<void>,
) {
  await withFile(
    prefix,
    `${JSON.stringify({ gateway: { port: 18789 } }, null, 2)}\n`,
    async ({ configPath, tempDir }) => {
      const batchPath = path.join(tempDir, "batch.json");
      const markerPath = path.join(tempDir, "marker.txt");
      fs.writeFileSync(
        batchPath,
        `${JSON.stringify(createExecDryRunBatch({ markerPath }), null, 2)}\n`,
        "utf8",
      );
      await visit({ batchPath, configPath, markerPath, runtime: createTestRuntime() });
    },
  );
}

describe("config cli secrets integration", () => {
  it.each([
    { name: "literal", token: "existing-gateway-token", redactedToken: "__OPENCLAW_REDACTED__" },
    {
      name: "store SecretRef",
      token: { source: "store", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" } as const,
      redactedToken: { source: "store", provider: "default", id: "__OPENCLAW_REDACTED__" },
    },
  ])(
    "preserves a $name credential in a redacted get/set round-trip",
    async ({ token, redactedToken }) => {
      const gateway = { mode: "local", port: 18789, auth: { mode: "token", token } };
      await withConfig(JSON.stringify({ gateway }), async ({ configPath }) => {
        await run("get", "gateway", "--json");
        const displayed = JSON.parse(logs.at(-1)!) as NonNullable<OpenClawConfig["gateway"]>;
        expect(displayed.auth?.token).toEqual(redactedToken);

        await set("gateway", JSON.stringify({ ...displayed, port: 19002 }), "--strict-json");

        expect(load(configPath).gateway).toEqual({
          ...gateway,
          port: 19002,
        });
        const before = read(configPath);
        await set("gateway.auth.token", "__OPENCLAW_REDACTED__");
        expect(read(configPath)).toBe(before);
      });
    },
  );

  it("rejects a redacted credential without an original value to preserve", async () => {
    const raw = '{"gateway":{"mode":"local","port":18789}}';
    await withConfig(raw, async ({ configPath }) => {
      await reject(set("gateway.auth.token", "__OPENCLAW_REDACTED__"));

      expect(read(configPath)).toBe(raw);
      expect(errors.join("\n")).toContain("gateway.auth.token");
    });
  });

  it.skipIf(process.platform === "win32")(
    "preserves literal exec args from the config builder through provider invocation",
    async () => {
      await withConfig("{}\n", async ({ configPath, tempDir }) => {
        const markerPath = path.join(tempDir, "argv.json");
        const batch = createExecDryRunBatch({ markerPath });
        const command = path.join(tempDir, "exec-provider.cjs");
        const args = [
          "",
          "   ",
          "  label  ",
          "\t\r\n\v\f",
          "\u00a0\ufefflabel\ufeff\u00a0",
          "inside \t space",
          "\x01control\x7f",
          "--literal-option",
          "x".repeat(1024),
        ];
        while (args.length < 128) {
          args.push(`arg-${args.length}`);
        }
        await set(
          "secrets.providers.runner",
          "--provider-source",
          "exec",
          "--provider-command",
          command,
          "--provider-trusted-dir",
          tempDir,
          "--provider-timeout-ms",
          "60000",
          "--provider-no-output-timeout-ms",
          "60000",
          ...args.flatMap((arg) => ["--provider-arg", arg]),
        );
        const persisted = read(configPath);
        expect(fs.existsSync(markerPath)).toBe(false);
        const output = createTestRuntime();

        await runConfigSet({
          cliOptions: {
            batchJson: JSON.stringify(batch.slice(1)),
            dryRun: true,
            allowExec: true,
            json: true,
          },
          runtime: output.runtime,
        });

        expect(errors).toEqual([]);
        expect(output.errors).toEqual([]);
        expect(JSON.parse(output.logs.join("\n"))).toMatchObject({
          ok: true,
          operations: 1,
          refsChecked: 1,
          skippedExecRefs: 0,
          checks: { schema: false, resolvability: true, resolvabilityComplete: true },
        });
        expect(read(configPath)).toBe(persisted);
        expect(readJson(markerPath)).toEqual(args);
        expect(JSON5.parse(persisted).secrets.providers.runner.args).toEqual(args);
      });
    },
  );
  it.each(["agents.defaults", "agents.entries.ops"])(
    "validates SecretRefs after normalizing model keys in %s",
    async (agentPath) => {
      const raw = '{ secrets: { providers: { default: { source: "env" } } } }\n';
      await withConfig(raw, async ({ configPath }) => {
        const envSnapshot = captureEnv(["MISSING_TEST_SECRET"]);
        try {
          deleteTestEnvValue("MISSING_TEST_SECRET");
          const output = createTestRuntime();

          await expect(
            runConfigSet({
              path: `${agentPath}.models["google/gemini-3-flash"].params.authorization`,
              value: JSON.stringify({
                source: "env",
                provider: "default",
                id: "MISSING_TEST_SECRET",
              }),
              cliOptions: { strictJson: true, dryRun: true, json: true },
              runtime: output.runtime,
            }),
          ).rejects.toThrow("__exit__:1");

          expect(read(configPath)).toBe(raw);
          expect(JSON.parse(output.logs.join("\n"))).toMatchObject({
            ok: false,
            refsChecked: 1,
            errors: [{ kind: "resolvability", ref: "env:default:MISSING_TEST_SECRET" }],
          });
        } finally {
          envSnapshot.restore();
        }
      });
    },
  );

  it("keeps model provider ids separate from SecretRef provider aliases", async () => {
    await withConfig("{}\n", async ({ configPath, tempDir }) => {
      const raw = JSON.stringify({
        models: {
          providers: {
            openai: { baseUrl: "https://example.invalid/v1", models: [] },
          },
        },
        secrets: {
          providers: {
            openai: { source: "exec", command: path.join(tempDir, "missing-helper") },
          },
        },
      });
      fs.writeFileSync(configPath, raw);
      const envSnapshot = captureEnv(["MODEL_API_KEY"]);
      try {
        setTestEnvValue("MODEL_API_KEY", "test-model-key");
        const output = createTestRuntime();

        await runConfigSet({
          path: "models.providers.openai.apiKey",
          cliOptions: {
            refProvider: "default",
            refSource: "env",
            refId: "MODEL_API_KEY",
            dryRun: true,
            json: true,
          },
          runtime: output.runtime,
        });

        expect(read(configPath)).toBe(raw);
        expect(output.errors).toEqual([]);
        expect(JSON.parse(output.logs.join("\n"))).toMatchObject({ ok: true, refsChecked: 1 });
      } finally {
        envSnapshot.restore();
      }
    });
  });

  it.each([
    {
      name: "unset",
      expectedSource: "env",
      run: (runtime: ReturnType<typeof createTestRuntime>["runtime"]) =>
        runConfigUnset({ path: "secrets.defaults.env", runtime }),
    },
  ])("rejects impossible provider/source refs during real config $name", async (testCase) => {
    const raw = sourceMismatchConfig({ source: "env", id: "DISCORD_TEST_TOKEN", defaults: true });
    await withConfig(raw, async ({ configPath }) => {
      const output = createTestRuntime();

      await expect(testCase.run(output.runtime)).rejects.toThrow("__exit__:1");

      expect(read(configPath)).toBe(raw);
      expect(output.errors.join("\n")).toContain(
        `provider "shared" has source "file" but ref requests "${testCase.expectedSource}"`,
      );
    });
  });

  it("rejects impossible provider/source refs during real config validate", async () => {
    const refId = "DISCORD_TEST_TOKEN";
    await withConfig(sourceMismatchConfig({ id: refId }), async () => {
      const snapshot = await configRuntime.readConfigFileSnapshot({ observe: false });
      expect(snapshot.valid).toBe(true);
      expect(snapshot.issues).toStrictEqual([]);

      await expect(run("validate")).rejects.toMatchObject({
        name: "ExitError",
        code: 1,
      });

      expect(errors.join("\n")).toContain(
        'Secret provider "shared" has source "file" but ref requests "exec"',
      );
      expect(errors.join("\n")).not.toContain(refId);
    });
  });

  it.each([
    {
      name: "setting an authored value to itself",
      run: (runtime: ReturnType<typeof createTestRuntime>["runtime"]) =>
        runConfigSet({
          path: "gateway.port",
          value: "18789",
          cliOptions: { strictJson: true },
          runtime,
        }),
    },
  ])("strictly validates an existing mismatch when $name is a no-op", async (testCase) => {
    const raw = sourceMismatchConfig({ gateway: true });
    await withConfig(raw, async ({ configPath }) => {
      const output = createTestRuntime();

      await expect(testCase.run(output.runtime)).rejects.toThrow("__exit__:1");

      expect(read(configPath)).toBe(raw);
      expect(output.logs).not.toContain("No change");
      expect(output.errors.join("\n")).toContain(
        'provider "shared" has source "file" but ref requests "exec"',
      );
    });
  });

  it("skips exec provider execution during dry-run by default", async () => {
    await withExecDryRunConfigHarness("openclaw-config-cli-int-exec-skip-", async (params) => {
      const before = read(params.configPath);
      await runConfigSet({
        cliOptions: {
          batchFile: params.batchPath,
          dryRun: true,
          json: true,
        },
        runtime: params.runtime.runtime,
      });
      const after = read(params.configPath);

      expect(after).toBe(before);
      expect(fs.existsSync(params.markerPath)).toBe(false);
      expect(JSON.parse(params.runtime.logs.join("\n"))).toMatchObject({
        ok: true,
        refsChecked: 0,
        skippedExecRefs: 1,
        checks: { schema: false, resolvability: true, resolvabilityComplete: false },
      });
    });
  });

  it("validates only the final candidate after a leaf overwrites an exec ref", async () => {
    await withConfig("{ gateway: { port: 18789 } }\n", async ({ configPath, tempDir }) => {
      const provider = { source: "exec", command: path.join(tempDir, "missing-helper") };
      const secrets = { providers: { runner: provider, dormant: provider } };
      const raw = JSON.stringify({ gateway: { port: 18789 }, secrets });
      fs.writeFileSync(configPath, raw);
      const batch = [
        {
          path: "channels.discord.token",
          ref: { source: "exec", provider: "runner", id: "discarded" },
        },
        { path: "channels.discord.token", value: "replacement-token" },
      ];
      const output = createTestRuntime();

      await runConfigSet({
        cliOptions: { batchJson: JSON.stringify(batch) },
        runtime: output.runtime,
      });

      expect(output.errors).toEqual([]);
      expect(load(configPath)).toMatchObject({
        channels: { discord: { token: "replacement-token" } },
        secrets,
      });
    });
  });

  it.each([false])(
    "still rejects an unsafe exec ref assigned last in a batch (dry run: %s)",
    async (dryRun) => {
      await withConfig("{ gateway: { port: 18789 } }\n", async ({ configPath, tempDir }) => {
        const raw = JSON.stringify({
          secrets: {
            providers: {
              runner: { source: "exec", command: path.join(tempDir, "missing-helper") },
            },
          },
        });
        fs.writeFileSync(configPath, raw);
        const output = createTestRuntime();

        await expect(
          runConfigSet({
            cliOptions: {
              batchJson: JSON.stringify([
                { path: "channels.discord.token", value: "superseded-token" },
                {
                  path: "channels.discord.token",
                  ref: { source: "exec", provider: "runner", id: "retained" },
                },
              ]),
              dryRun,
            },
            runtime: output.runtime,
          }),
        ).rejects.toThrow("__exit__:1");

        expect(read(configPath)).toBe(raw);
        expect(output.errors.join("\n")).toContain("secrets.providers.runner.command");
        expect(output.errors.join("\n")).toContain("is not readable");
      });
    },
  );

  it("does not execute an overwritten exec ref during an --allow-exec batch dry-run", async () => {
    await withConfig("{ gateway: { port: 18789 } }\n", async ({ configPath, tempDir }) => {
      const markerPath = path.join(tempDir, "marker.txt");
      const batch = [
        ...createExecDryRunBatch({ markerPath }),
        { path: "channels.discord.token", value: "replacement-token" },
      ];
      const raw = read(configPath);
      const output = createTestRuntime();

      await runConfigSet({
        cliOptions: {
          batchJson: JSON.stringify(batch),
          dryRun: true,
          allowExec: true,
          json: true,
        },
        runtime: output.runtime,
      });

      expect(fs.existsSync(markerPath)).toBe(false);
      expect(read(configPath)).toBe(raw);
      expect(output.errors).toEqual([]);
      expect(JSON.parse(output.logs.join("\n"))).toMatchObject({
        ok: true,
        refsChecked: 0,
        skippedExecRefs: 0,
      });
    });
  });
});
