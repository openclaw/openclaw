import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConfigFileSnapshot, readConfigFileSnapshotForWrite } from "../config/config.js";
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

  it.each([false, true])(
    "redacts environment-expanded model errors without writing (json=%s)",
    async (json) => {
      const raw = JSON.stringify({ agents: { entries: { main: {} } } });
      await withConfig(raw, async ({ configPath }) => {
        await withEnvAsync({ CONFIG_PRIVATE_MODEL: undefined }, async () => {
          const privateValue = "fixture-private-provider/fixture-private-model";
          const authored = "${CONFIG_PRIVATE_MODEL}";
          setTestEnvValue("CONFIG_PRIVATE_MODEL", privateValue);
          await reject(
            set(
              "agents.defaults.model",
              json ? JSON.stringify(authored) : authored,
              "--dry-run",
              ...(json ? ["--json"] : []),
            ),
          );
          const output = [...logs, ...errors].join("\n");
          expect(output).not.toContain(privateValue);
          expect(output).not.toContain("fixture-private-provider");
          expect(output).not.toContain("fixture-private-model");
          expect(output).toContain("Cannot set model reference");
          if (json) {
            expect(JSON.parse(logs.join("\n"))).toMatchObject({
              ok: false,
              errors: [expect.objectContaining({ kind: "model" })],
            });
          }
          expect(read(configPath)).toBe(raw);
          expect(fs.existsSync(configPath + ".bak")).toBe(false);
        });
      });
    },
  );

  it("activates an included escaped reference without unrelated edits", async () => {
    const browser = { enabled: true, executablePath: "$${CONFIG_ACTIVATION_VALUE}" };
    const raw = JSON.stringify({
      agents: { entries: { main: {} } },
      browser: { $include: "./browser.json" },
    });
    await withConfig(raw, async ({ configPath, tempDir }) => {
      const ownedPath = path.join(tempDir, "browser.json");
      fs.writeFileSync(ownedPath, JSON.stringify(browser));
      const before = read(ownedPath);
      await withEnvAsync({ CONFIG_ACTIVATION_VALUE: "/opt/activated-browser" }, async () => {
        await set("browser.executablePath", "${CONFIG_ACTIVATION_VALUE}");
        const saved = readJson(ownedPath);
        expect(saved).toMatchObject({
          executablePath: "${CONFIG_ACTIVATION_VALUE}",
        });
        expect(read(ownedPath + ".bak")).toBe(before);
        expect((await readConfigFileSnapshot()).sourceConfig.browser?.executablePath).toBe(
          "/opt/activated-browser",
        );
        expect(read(configPath)).toBe(raw);
        expect(errors).toEqual([]);
      });
    });
  });

  it("retains included reference identity for an equal-value parent assignment", async () => {
    const browser = { enabled: true, executablePath: "${CONFIG_REFERENCE_VALUE}" };
    const raw = JSON.stringify({
      agents: { entries: { main: {} } },
      browser: { $include: "./browser.json" },
    });
    await withConfig(raw, async ({ configPath, tempDir }) => {
      const ownedPath = path.join(tempDir, "browser.json");
      fs.writeFileSync(ownedPath, JSON.stringify(browser));
      const before = read(ownedPath);
      await withEnvAsync({ CONFIG_REFERENCE_VALUE: "/opt/browser-original" }, async () => {
        await set(
          "browser",
          JSON.stringify({ enabled: true, executablePath: "/opt/browser-original" }),
          "--strict-json",
        );
        const saved = readJson(ownedPath);
        expect(saved).toMatchObject({
          executablePath: "${CONFIG_REFERENCE_VALUE}",
        });
        expect(read(ownedPath)).toBe(before);
        expect(fs.existsSync(ownedPath + ".bak")).toBe(false);
        setTestEnvValue("CONFIG_REFERENCE_VALUE", "/opt/browser-rotated");
        expect((await readConfigFileSnapshot()).sourceConfig.browser?.executablePath).toBe(
          "/opt/browser-rotated",
        );
        expect(read(configPath)).toBe(raw);
        expect(errors).toEqual([]);
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
