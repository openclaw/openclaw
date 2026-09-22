import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConfigFileSnapshot, readConfigFileSnapshotForWrite } from "../config/config.js";
import { registerManagedRuntimeConfigWriteOwner } from "../config/runtime-snapshot.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  createTestRuntime,
  useConfigCliIntegrationHarness,
} from "./config-cli.integration.test-harness.js";

const {
  registeredRuntimeLogs,
  registeredRuntimeErrors,
  runRegisteredConfigCommand,
  withConfigFileHarness,
} = useConfigCliIntegrationHarness();

describe("config CLI explicit reference values", () => {
  it("does not retain config env ownership from a rejected read", async () => {
    await withConfigFileHarness(
      "config-env-rejected-owner-",
      "{}",
      async ({ configPath, tempDir }) => {
        const originalDir = path.join(fs.realpathSync(tempDir), "external-agent");
        const replacementDir = path.join(fs.realpathSync(tempDir), "config-agent");
        const env = captureEnv(["CONFIG_REJECTED_AGENT_DIR"]);
        const vars = { CONFIG_REJECTED_AGENT_DIR: originalDir };
        try {
          deleteTestEnvValue("CONFIG_REJECTED_AGENT_DIR");
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
          await runRegisteredConfigCommand([...args, "--dry-run"]);
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
          await runRegisteredConfigCommand(args);
          expect(
            (await readConfigFileSnapshot()).sourceConfig.agents?.entries?.main?.agentDir,
          ).toBe(originalDir);
          expect(fs.readFileSync(configPath + ".bak", "utf8")).toBe(raw);
          expect(registeredRuntimeErrors).toEqual([]);
        } finally {
          env.restore();
        }
      },
    );
  });

  it("retains equal-valued external environment precedence during config env edits", async () => {
    await withConfigFileHarness(
      "config-env-external-owner-",
      "{}",
      async ({ configPath, tempDir }) => {
        const originalDir = path.join(fs.realpathSync(tempDir), "external-agent");
        const replacementDir = path.join(fs.realpathSync(tempDir), "config-agent");
        const raw = JSON.stringify({
          env: { vars: { CONFIG_EXTERNAL_AGENT_DIR: originalDir } },
          agents: { entries: { main: { agentDir: "${CONFIG_EXTERNAL_AGENT_DIR}" } } },
        });
        fs.writeFileSync(configPath, raw);
        const env = captureEnv(["CONFIG_EXTERNAL_AGENT_DIR"]);
        try {
          setTestEnvValue("CONFIG_EXTERNAL_AGENT_DIR", originalDir);
          const args = [
            "config",
            "set",
            "--batch-json",
            JSON.stringify([
              { path: "env.vars.CONFIG_EXTERNAL_AGENT_DIR", value: replacementDir },
              { path: "agents.entries.main.agentDir", value: "${CONFIG_EXTERNAL_AGENT_DIR}" },
            ]),
          ];
          await runRegisteredConfigCommand([...args, "--dry-run"]);
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
          await runRegisteredConfigCommand(args);
          const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
          expect(saved.env.vars.CONFIG_EXTERNAL_AGENT_DIR).toBe(replacementDir);
          expect(saved.agents.entries.main.agentDir).toBe("${CONFIG_EXTERNAL_AGENT_DIR}");
          expect(
            (await readConfigFileSnapshot()).sourceConfig.agents?.entries?.main?.agentDir,
          ).toBe(originalDir);
          expect(process.env.CONFIG_EXTERNAL_AGENT_DIR).toBe(originalDir);
          expect(fs.readFileSync(configPath + ".bak", "utf8")).toBe(raw);
          expect(registeredRuntimeErrors).toEqual([]);
        } finally {
          env.restore();
        }
      },
    );
  });

  it.each([false, true])(
    "refuses physical owner changes through config-owned environment edits (preview=%s)",
    async (preview) => {
      await withConfigFileHarness(
        "config-env-physical-owner-",
        "{}",
        async ({ configPath, tempDir }) => {
          const originalDir = path.join(fs.realpathSync(tempDir), "original-agent");
          const replacementDir = path.join(fs.realpathSync(tempDir), "replacement-agent");
          const raw = JSON.stringify({
            env: { vars: { CONFIG_EDITED_AGENT_DIR: originalDir } },
            agents: { entries: { main: { agentDir: "${CONFIG_EDITED_AGENT_DIR}" } } },
          });
          fs.writeFileSync(configPath, raw);
          const env = captureEnv(["CONFIG_EDITED_AGENT_DIR"]);
          try {
            deleteTestEnvValue("CONFIG_EDITED_AGENT_DIR");
            await expect(
              runRegisteredConfigCommand([
                "config",
                "set",
                "--batch-json",
                JSON.stringify([
                  { path: "env.vars.CONFIG_EDITED_AGENT_DIR", value: replacementDir },
                  { path: "agents.entries.main.agentDir", value: "${CONFIG_EDITED_AGENT_DIR}" },
                ]),
                ...(preview ? ["--dry-run"] : []),
              ]),
            ).rejects.toMatchObject({ name: "ExitError", code: 1 });
            expect(registeredRuntimeErrors.join("\n")).toContain("inherited auth");
            expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
            expect(fs.existsSync(configPath + ".bak")).toBe(false);
          } finally {
            env.restore();
          }
        },
      );
    },
  );

  it("does not revalidate an untouched model reference during a parent merge preview", async () => {
    const raw = JSON.stringify({
      agents: { entries: { main: {} }, defaults: { model: "${CONFIG_UNTOUCHED_MODEL}" } },
    });
    await withConfigFileHarness("config-dry-run-unchanged-model-", raw, async ({ configPath }) => {
      const env = captureEnv(["CONFIG_UNTOUCHED_MODEL"]);
      try {
        setTestEnvValue("CONFIG_UNTOUCHED_MODEL", "fixture-unavailable-provider/missing-model");
        const args = [
          "config",
          "set",
          "agents.defaults",
          '{"maxConcurrent":3}',
          "--merge",
          "--strict-json",
        ];
        const previewError = await runRegisteredConfigCommand([
          ...args,
          "--dry-run",
          "--json",
        ]).catch((error: unknown) => error);
        expect(
          previewError,
          [...registeredRuntimeLogs, ...registeredRuntimeErrors].join("\n"),
        ).toBeUndefined();
        expect(JSON.parse(registeredRuntimeLogs.join("\n"))).toMatchObject({
          ok: true,
          refsChecked: 0,
        });
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(fs.existsSync(configPath + ".bak")).toBe(false);
        await runRegisteredConfigCommand(args);
        expect(JSON.parse(fs.readFileSync(configPath, "utf8")).agents.defaults).toMatchObject({
          model: "${CONFIG_UNTOUCHED_MODEL}",
          maxConcurrent: 3,
        });
        expect(fs.readFileSync(configPath + ".bak", "utf8")).toBe(raw);
        expect(registeredRuntimeErrors).toEqual([]);
      } finally {
        env.restore();
      }
    });
  });

  it("checks models from the captured managed environment without writing", async () => {
    const raw = JSON.stringify({
      env: { vars: { CONFIG_CAPTURED_MODEL: "claude-cli/claude-sonnet-4-6" } },
      agents: { entries: { main: {} } },
    });
    await withConfigFileHarness("config-dry-run-managed-model-", raw, async ({ configPath }) => {
      const env = captureEnv(["CONFIG_CAPTURED_MODEL"]);
      const releaseOwner = registerManagedRuntimeConfigWriteOwner(configPath);
      try {
        deleteTestEnvValue("CONFIG_CAPTURED_MODEL");
        const prepared = await readConfigFileSnapshotForWrite();
        expect(prepared.writeOptions.envSnapshotForRestore?.CONFIG_CAPTURED_MODEL).toBe(
          "claude-cli/claude-sonnet-4-6",
        );
        expect(process.env.CONFIG_CAPTURED_MODEL).toBeUndefined();
        await expect(
          runRegisteredConfigCommand([
            "config",
            "set",
            "agents.defaults.model",
            JSON.stringify("${CONFIG_CAPTURED_MODEL}"),
            "--dry-run",
            "--json",
          ]),
        ).rejects.toMatchObject({ name: "ExitError", code: 1 });
        // This harness excludes the backend from its catalog. The model must reach
        // that resolver and be refused, not remain unchecked due to missing read-time env.
        expect(JSON.parse(registeredRuntimeLogs.join("\n"))).toMatchObject({
          ok: false,
          refsChecked: 1,
          checks: { resolvabilityComplete: true },
          errors: [expect.objectContaining({ kind: "model" })],
        });
        expect(registeredRuntimeLogs.join("\n")).not.toContain("claude-cli/claude-sonnet-4-6");
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(fs.existsSync(configPath + ".bak")).toBe(false);
        expect(registeredRuntimeErrors).toEqual([]);
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
      await withConfigFileHarness("config-dry-run-model-env-", raw, async ({ configPath }) => {
        const env = captureEnv(["CONFIG_PRIVATE_MODEL"]);
        try {
          const privateValue = "fixture-private-provider/fixture-private-model";
          const authored = "${CONFIG_PRIVATE_MODEL}";
          setTestEnvValue("CONFIG_PRIVATE_MODEL", privateValue);
          await expect(
            runRegisteredConfigCommand([
              "config",
              "set",
              "agents.defaults.model",
              json ? JSON.stringify(authored) : authored,
              "--dry-run",
              ...(json ? ["--json"] : []),
            ]),
          ).rejects.toMatchObject({ name: "ExitError", code: 1 });
          const output = [...registeredRuntimeLogs, ...registeredRuntimeErrors].join("\n");
          expect(output).not.toContain(privateValue);
          expect(output).not.toContain("fixture-private-provider");
          expect(output).not.toContain("fixture-private-model");
          expect(output).toContain("Cannot set model reference");
          if (json) {
            expect(JSON.parse(registeredRuntimeLogs.join("\n"))).toMatchObject({
              ok: false,
              errors: [expect.objectContaining({ kind: "model" })],
            });
          }
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
          expect(fs.existsSync(configPath + ".bak")).toBe(false);
        } finally {
          env.restore();
        }
      });
    },
  );

  it.each([false, true])(
    "activates an escaped reference without unrelated edits (include=%s)",
    async (include) => {
      const browser = { enabled: true, executablePath: "$${CONFIG_ACTIVATION_VALUE}" };
      const raw = JSON.stringify({
        agents: { entries: { main: {} } },
        browser: include ? { $include: "./browser.json" } : browser,
      });
      await withConfigFileHarness(
        "config-reference-activation-",
        raw,
        async ({ configPath, tempDir }) => {
          const ownedPath = include ? path.join(tempDir, "browser.json") : configPath;
          if (include) {
            fs.writeFileSync(ownedPath, JSON.stringify(browser));
          }
          const before = fs.readFileSync(ownedPath, "utf8");
          const env = captureEnv(["CONFIG_ACTIVATION_VALUE"]);
          try {
            setTestEnvValue("CONFIG_ACTIVATION_VALUE", "/opt/activated-browser");
            await runRegisteredConfigCommand([
              "config",
              "set",
              "browser.executablePath",
              "${CONFIG_ACTIVATION_VALUE}",
            ]);
            const saved = JSON.parse(fs.readFileSync(ownedPath, "utf8"));
            expect(include ? saved : saved.browser).toMatchObject({
              executablePath: "${CONFIG_ACTIVATION_VALUE}",
            });
            expect(fs.readFileSync(ownedPath + ".bak", "utf8")).toBe(before);
            expect((await readConfigFileSnapshot()).sourceConfig.browser?.executablePath).toBe(
              "/opt/activated-browser",
            );
            if (include) {
              expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
            }
            expect(registeredRuntimeErrors).toEqual([]);
          } finally {
            env.restore();
          }
        },
      );
    },
  );

  it.each([
    { include: false, parent: false },
    { include: true, parent: false },
    { include: false, parent: true },
    { include: true, parent: true },
  ])(
    "retains authored identity for equal-value assignments (include=$include, parent=$parent)",
    async ({ include, parent }) => {
      const browser = { enabled: true, executablePath: "${CONFIG_REFERENCE_VALUE}" };
      const raw = JSON.stringify({
        agents: { entries: { main: {} } },
        browser: include ? { $include: "./browser.json" } : browser,
      });
      await withConfigFileHarness(
        "config-literal-intent-",
        raw,
        async ({ configPath, tempDir }) => {
          const ownedPath = include ? path.join(tempDir, "browser.json") : configPath;
          if (include) {
            fs.writeFileSync(ownedPath, JSON.stringify(browser));
          }
          const before = fs.readFileSync(ownedPath, "utf8");
          const env = captureEnv(["CONFIG_REFERENCE_VALUE"]);
          try {
            setTestEnvValue("CONFIG_REFERENCE_VALUE", "/opt/browser-original");
            await runRegisteredConfigCommand(
              parent
                ? [
                    "config",
                    "set",
                    "browser",
                    JSON.stringify({ enabled: true, executablePath: "/opt/browser-original" }),
                    "--strict-json",
                  ]
                : ["config", "set", "browser.executablePath", "/opt/browser-original"],
            );
            const saved = JSON.parse(fs.readFileSync(ownedPath, "utf8"));
            expect(include ? saved : saved.browser).toMatchObject({
              executablePath: "${CONFIG_REFERENCE_VALUE}",
            });
            expect(fs.readFileSync(ownedPath, "utf8")).toBe(before);
            expect(fs.existsSync(ownedPath + ".bak")).toBe(false);
            setTestEnvValue("CONFIG_REFERENCE_VALUE", "/opt/browser-rotated");
            expect((await readConfigFileSnapshot()).sourceConfig.browser?.executablePath).toBe(
              "/opt/browser-rotated",
            );
            if (include) {
              expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
            }
            expect(registeredRuntimeErrors).toEqual([]);
          } finally {
            env.restore();
          }
        },
      );
    },
  );

  it.each([
    { json: false, value: "${CONFIG_DRY_RUN_VALUE}" },
    { json: true, value: "${CONFIG_DRY_RUN_VALUE}" },
    { json: false, value: "$${CONFIG_DRY_RUN_VALUE}" },
    { json: true, value: "$${CONFIG_DRY_RUN_VALUE}" },
  ])(
    "prints only a no-write dry-run summary (json=$json, value=$value)",
    async ({ json, value }) => {
      const raw = JSON.stringify({ agents: { entries: { main: {} } }, browser: { enabled: true } });
      await withConfigFileHarness("config-dry-run-reference-", raw, async ({ configPath }) => {
        const env = captureEnv(["CONFIG_DRY_RUN_VALUE"]);
        try {
          const privateValue = "/opt/fixture-dry-run-private-value";
          setTestEnvValue("CONFIG_DRY_RUN_VALUE", privateValue);
          await runRegisteredConfigCommand([
            "config",
            "set",
            "browser.executablePath",
            json ? JSON.stringify(value) : value,
            "--dry-run",
            ...(json ? ["--json"] : []),
          ]);
          const output = [...registeredRuntimeLogs, ...registeredRuntimeErrors].join("\n");
          expect(output).not.toContain(privateValue);
          expect(output).not.toContain("CONFIG_DRY_RUN_VALUE");
          if (json) {
            expect(JSON.parse(registeredRuntimeLogs.join("\n"))).toMatchObject({
              ok: true,
              operations: 1,
            });
            expect(JSON.parse(registeredRuntimeLogs.join("\n"))).not.toHaveProperty("config");
          } else {
            expect(output).toContain("Dry run successful: 1 update(s)");
          }
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
          expect(fs.existsSync(configPath + ".bak")).toBe(false);
          expect(registeredRuntimeErrors).toEqual([]);
        } finally {
          env.restore();
        }
      });
    },
  );
});

describe("config CLI ordered writer policy", () => {
  it.each([
    { include: false, deleted: 0 },
    { include: true, deleted: 0 },
    { include: false, deleted: 1 },
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
      await withConfigFileHarness(
        "config-ordered-policy-",
        raw,
        async ({ configPath, tempDir }) => {
          const ownedPath = include ? path.join(tempDir, "provider.json") : configPath;
          if (include) {
            fs.writeFileSync(ownedPath, JSON.stringify(provider));
          }
          const before = fs.readFileSync(ownedPath, "utf8");
          const env = captureEnv(["CONFIG_POLICY_TARGET", "CONFIG_POLICY_OTHER"]);
          try {
            setTestEnvValue("CONFIG_POLICY_TARGET", "activated-model");
            setTestEnvValue("CONFIG_POLICY_OTHER", "unrelated-model");
            const { runConfigOperations } = await import("./config-cli-runner.js");
            const target = ["models", "providers", "example", "models", "1", "name"];
            const removed = ["models", "providers", "example", "models", String(deleted)];
            const { runtime, errors } = createTestRuntime();
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
            const saved = JSON.parse(fs.readFileSync(ownedPath, "utf8"));
            const models = include ? saved.models : saved.models.providers.example.models;
            expect(models).toEqual([
              deleted === 0
                ? { id: "edited", name: "${CONFIG_POLICY_TARGET}" }
                : provider.models[0],
              provider.models[2],
            ]);
            expect(fs.readFileSync(ownedPath + ".bak", "utf8")).toBe(before);
            expect(errors).toEqual([]);
            setTestEnvValue("CONFIG_POLICY_TARGET", "rotated-model");
            const snapshot = await readConfigFileSnapshot();
            expect(snapshot.sourceConfig.models?.providers?.example?.models[0]?.name).toBe(
              deleted === 0 ? "rotated-model" : "drop",
            );
            const intermediate = fs.readFileSync(ownedPath, "utf8");
            await runRegisteredConfigCommand([
              "config",
              "unset",
              "models.providers.example.models[0]",
            ]);
            const final = JSON.parse(fs.readFileSync(ownedPath, "utf8"));
            expect(include ? final.models : final.models.providers.example.models).toEqual([
              provider.models[2],
            ]);
            expect(fs.readFileSync(ownedPath + ".bak", "utf8")).toBe(intermediate);
            if (include) {
              expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
            }
            expect(registeredRuntimeErrors).toEqual([]);
          } finally {
            env.restore();
          }
        },
      );
    },
  );
});
