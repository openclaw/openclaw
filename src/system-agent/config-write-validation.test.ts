import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSystemAgentTool } from "../agents/tools/system-agent-tool.js";
import * as configRuntime from "../config/config.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import {
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeSecretStoreEntryForConfigRefInDatabase } from "../secrets/store/secret-store-config-ref.kernel.js";
import * as secretStore from "../secrets/store/secret-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { SystemAgentOperationExitError } from "./operations-execution-helpers.js";
import { executeSystemAgentOperation, type SystemAgentCommandDeps } from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  vi.restoreAllMocks();
  setRuntimeConfigSnapshotRefreshHandler(null);
  await closeOpenClawStateDatabaseAsync();
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

async function prepareConfig(raw = "{}\n") {
  const stateDir = tempDirs.make("openclaw-config-write-");
  const configPath = path.join(stateDir, "openclaw.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  await fs.writeFile(configPath, raw);
  return configPath;
}

describe("createSystemAgentTool.execute config writes", () => {
  it.each([
    ["agents.defaults.models.fixture/primary.agentRuntime.id", "openclaw"],
    ["agents.defaults.model.primary", "fixture/primary"],
    ["models.providers.fixture.baseUrl", "https://example.invalid/v1"],
    ["env.vars.FIXTURE_SETTING", "fixture-value"],
    ["plugins.entries.fixture.enabled", "true"],
  ])("offers approval without writing %s", async (configKey, value) => {
    const configPath = await prepareConfig();
    const result = await createSystemAgentTool({ surface: "cli" }).execute("proposal", {
      action: "config_set",
      path: configKey,
      value,
    });
    expect(result.details).toMatchObject({ needsApproval: true });
    expect(await fs.readFile(configPath, "utf8")).toBe("{}\n");
  });
});

describe("executeSystemAgentOperation approved config writes", () => {
  it.each([
    {
      configKey: "agents.defaults.models.fixture/primary.agentRuntime.id",
      value: "openclaw",
      saved: {
        agents: {
          defaults: { models: { "fixture/primary": { agentRuntime: { id: "openclaw" } } } },
        },
      },
    },
    {
      configKey: "tools.exec.notifyOnExit",
      value: "false",
      saved: { tools: { exec: { notifyOnExit: false } } },
    },
  ])(
    "saves $configKey through the real writer without a live probe",
    async ({ configKey, value, saved }) => {
      const configPath = await prepareConfig(
        JSON.stringify({ agents: { defaults: { model: { primary: "fixture/primary" } } } }),
      );
      const { runtime, lines } = createSystemAgentTestRuntime();
      const verifyInferenceConfig = vi.fn<
        NonNullable<SystemAgentCommandDeps["verifyInferenceConfig"]>
      >(async () => {
        throw new Error("Unexpected config-write inference probe");
      });
      await expect(
        executeSystemAgentOperation({ kind: "config-set", path: configKey, value }, runtime, {
          approved: true,
          deps: { verifyInferenceConfig },
        }),
      ).resolves.toMatchObject({ applied: true });
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject(saved);
      expect(verifyInferenceConfig).not.toHaveBeenCalled();
      expect(lines).toContain("[openclaw] done: config.set");
    },
  );

  it("captures the real schema error and leaves the file unchanged", async () => {
    const raw = JSON.stringify({ gateway: { port: 18789 } });
    const configPath = await prepareConfig(raw);
    const { runtime, lines } = createSystemAgentTestRuntime();
    await expect(
      executeSystemAgentOperation(
        { kind: "config-set", path: "gateway.port", value: "banana" },
        runtime,
        { approved: true },
      ),
    ).rejects.toBeInstanceOf(SystemAgentOperationExitError);
    expect(lines.join("\n")).toContain(
      "gateway.port: Invalid input: expected number, received string",
    );
    expect(await fs.readFile(configPath, "utf8")).toBe(raw);
  });

  it("keeps the writer's authority check after config validation", async () => {
    const configPath = await prepareConfig();
    const { runtime, lines } = createSystemAgentTestRuntime();
    const beforePersistentApply = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("approving run closed");
      });
    await expect(
      executeSystemAgentOperation(
        { kind: "config-set", path: "tools.exec.notifyOnExit", value: "false" },
        runtime,
        { approved: true, beforePersistentApply },
      ),
    ).rejects.toBeInstanceOf(SystemAgentOperationExitError);
    expect(lines.join("\n")).toContain("approving run closed");
    expect(await fs.readFile(configPath, "utf8")).toBe("{}\n");
  });

  it.each(["env", "file"] as const)(
    "uses canonical SecretRef validation with an %s provider",
    async (source) => {
      const raw = JSON.stringify({
        secrets: {
          providers: {
            fixture:
              source === "env"
                ? { source }
                : { source, path: "/tmp/unused-fixture-secrets.json", mode: "json" },
          },
        },
      });
      const configPath = await prepareConfig(raw);
      const { runtime, lines } = createSystemAgentTestRuntime();
      const operation = executeSystemAgentOperation(
        {
          kind: "config-set-ref",
          path: "gateway.auth.token",
          source: "env",
          provider: "fixture",
          id: "FIXTURE_API_KEY",
        },
        runtime,
        { approved: true },
      );
      if (source === "env") {
        await expect(operation).resolves.toMatchObject({ applied: true });
        expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
          gateway: {
            auth: { token: { source: "env", provider: "fixture", id: "FIXTURE_API_KEY" } },
          },
        });
      } else {
        await expect(operation).rejects.toBeInstanceOf(SystemAgentOperationExitError);
        expect(lines.join("\n")).toContain(
          'provider "fixture" has source "file" but ref requests "env"',
        );
        expect(await fs.readFile(configPath, "utf8")).toBe(raw);
      }
    },
  );
});

// This unit lane has no worker broker. Keep the real insert-only SQLite kernel;
// only transport admission is inline. The config CLI and postcommit writer are real.
describe("chat secret config-write recovery", () => {
  const secret = "synthetic-chat-secret";
  const team = { kind: "team" } as const;

  async function prepareSecretConfig() {
    const initial: OpenClawConfig = { gateway: { mode: "local", port: 18789 } };
    const configPath = await prepareConfig(JSON.stringify(initial));
    vi.spyOn(secretStore, "writeSecretStoreEntryForConfigRef").mockImplementation(
      async (params) => {
        return writeSecretStoreEntryForConfigRefInDatabase(
          { baseName: params.baseName, value: params.value, writer: params.updatedBy, now: 1 },
          undefined,
          () => params.assertCurrent?.(),
        ).name;
      },
    );
    setRuntimeConfigSnapshot(initial, initial);
    return configPath;
  }

  async function captureFailure(configKey = "gateway.auth.token") {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const failure = await executeSystemAgentOperation(
      { kind: "config-set-ref", path: configKey, source: "store", id: "CHAT_TOKEN", secret },
      runtime,
      { approved: true },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("expected failed config operation");
    }
    const entries = secretStore.listSecretStoreEntries({ scope: team, includeDeleted: true });
    expect(entries).toHaveLength(1);
    const name = entries[0]!.name;
    expect(secretStore.readSecretStoreValue({ scope: team, name })).toEqual({
      ok: true,
      value: secret,
    });
    expect(failure.message).toContain(`Saved the secret as ${name}`);
    expect(failure.message).toContain("The entry was kept");
    expect(failure.message).not.toContain("store rm");
    expect(failure.message).not.toContain("unreferenced");
    expect(failure.message).not.toContain(secret);
    expect(lines.join("\n")).not.toContain(secret);
    expect(lines).not.toContain("[openclaw] done: config.setRef");
    return { failure, name };
  }

  it("retains the entry after a real precommit schema refusal", async () => {
    const configPath = await prepareSecretConfig();
    const before = await fs.readFile(configPath, "utf8");
    const { failure } = await captureFailure("gateway.port");
    expect(failure.message).toContain("did not reference the saved entry");
    expect(failure.message).toContain("Config validation failed");
    expect(failure.cause).not.toBeInstanceOf(ConfigWritePostCommitError);
    expect(await fs.readFile(configPath, "utf8")).toBe(before);
  });

  it.each(["retained", "restored", "shared", "invalid-read", "failed-read"] as const)(
    "reconciles %s state after a real postcommit refresh fault",
    async (state) => {
      const configPath = await prepareSecretConfig();
      let committed: OpenClawConfig | undefined;
      setRuntimeConfigSnapshotRefreshHandler({
        refresh: async () => {
          committed = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
          expect(committed.gateway?.auth?.token).toMatchObject({ source: "store" });
          if (state !== "restored") {
            // An external edit after commit prevents rollback from overwriting
            // the newer owner, including a consumer adopting our new entry.
            const concurrent = structuredClone(committed);
            concurrent.gateway = { ...concurrent.gateway, port: 19002 };
            if (state === "shared") {
              concurrent.gateway.remote = { token: concurrent.gateway.auth?.token };
              delete concurrent.gateway.auth?.token;
            }
            await fs.writeFile(
              configPath,
              state === "invalid-read" ? "{" : JSON.stringify(concurrent),
            );
          }
          if (state === "failed-read") {
            vi.spyOn(configRuntime, "readConfigFileSnapshot").mockRejectedValueOnce(
              new Error("synthetic recovery read failure"),
            );
          }
          throw new Error("synthetic runtime refresh failure");
        },
      });
      const { failure, name } = await captureFailure();
      expect(committed).toBeDefined();
      expect(failure.cause).toBeInstanceOf(ConfigWritePostCommitError);
      expect(failure.cause).toMatchObject({
        rollbackStatus: state === "restored" ? "restored" : "not-restored",
      });
      if (state === "invalid-read" || state === "failed-read") {
        expect(failure.message).toContain("Could not establish whether");
        expect(failure.message).not.toContain("did not reference");
      } else if (state === "retained") {
        expect(failure.message).toContain("gateway.auth.token referenced the saved entry");
        expect(failure.message).not.toContain("could not point");
      } else {
        expect(failure.message).toContain("gateway.auth.token did not reference the saved entry");
      }
      expect(failure.message).toContain("other config keys or auth profiles may use it");
      if (state !== "invalid-read") {
        const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
        const ref = { source: "store", provider: "default", id: name };
        if (state === "shared") {
          expect(saved.gateway?.remote?.token).toEqual(ref);
          expect(saved.gateway?.auth?.token).toBeUndefined();
        } else if (state === "restored") {
          expect(saved.gateway?.auth?.token).toBeUndefined();
        } else {
          expect(saved.gateway?.auth?.token).toEqual(ref);
        }
      }
    },
  );
});
