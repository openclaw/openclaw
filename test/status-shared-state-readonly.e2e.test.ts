// Status shared-state E2E tests enforce the CLI/Gateway SQLite ownership boundary.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished } from "vitest";
import { seedInstalledPluginIndex } from "../src/plugins/test-helpers/installed-plugin-index.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../src/state/openclaw-state-db-contract.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const DEGRADED_PLUGIN_ID = "status-degraded-plugin";
async function createInstance(options: Parameters<typeof createOpenClawTestInstance>[0]) {
  const instance = await createOpenClawTestInstance(options);
  onTestFinished(() => instance.cleanup());
  return instance;
}

function expectHealthy(result: { code: number | null; stderr: string; stdout: string }) {
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    degradedSecretOwners: [],
    degradedPlugins: [],
  });
}

function createUnavailablePluginFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-status-degraded-plugin-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const writeJson = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  writeJson("package.json", {
    name: DEGRADED_PLUGIN_ID,
    version: "1.0.0",
    type: "module",
    main: "./missing-main.js",
    openclaw: { extensions: ["./index.js"] },
    peerDependencies: { openclaw: ">=2026.1.1" },
  });
  writeJson("openclaw.plugin.json", {
    id: DEGRADED_PLUGIN_ID,
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  });
  fs.writeFileSync(path.join(root, "index.js"), "export default { register() {} };\n");
  return root;
}

describe("status shared-state ownership", () => {
  it("projects Gateway-owned runtime degradation across status processes", async () => {
    const pluginRoot = createUnavailablePluginFixture();
    const missingSecret = {
      source: "env" as const,
      provider: "default",
      id: "STATUS_E2E_MISSING_SECRET",
    };
    const instance = await createInstance({
      name: "status-runtime-degradation",
      env: {
        STATUS_E2E_MISSING_SECRET: undefined,
        VITEST: undefined,
        VITEST_POOL_ID: undefined,
        VITEST_WORKER_ID: undefined,
      },
      config: {
        tts: { providers: { elevenlabs: { apiKey: missingSecret } } },
        plugins: {
          enabled: true,
          allow: [DEGRADED_PLUGIN_ID],
          load: { paths: [pluginRoot] },
          entries: { [DEGRADED_PLUGIN_ID]: { enabled: true } },
        },
      },
    });
    await seedInstalledPluginIndex(
      {
        [DEGRADED_PLUGIN_ID]: {
          source: "npm",
          spec: DEGRADED_PLUGIN_ID,
          installPath: pluginRoot,
        },
      },
      { env: instance.env },
    );
    await instance.startGateway();

    const rpc = await instance.cli(["gateway", "call", "status", "--json"]);
    expect(rpc.code, rpc.stderr).toBe(0);
    const gatewayStatus = JSON.parse(rpc.stdout) as {
      degradedSecretOwners: unknown[];
      degradedPlugins: unknown[];
    };
    expect(gatewayStatus.degradedSecretOwners).toEqual([
      expect.objectContaining({
        ownerKind: "capability",
        ownerId: "tts",
        paths: ["tts.providers.elevenlabs.apiKey"],
        reason: "secret reference was not found",
      }),
    ]);
    expect(gatewayStatus.degradedPlugins).toEqual([
      expect.objectContaining({
        pluginId: DEGRADED_PLUGIN_ID,
        state: "configured-unavailable",
        diagnostic: expect.objectContaining({ reason: "missing-openclaw-peer-link" }),
      }),
    ]);

    for (const args of [["status"], ["status", "--all"], ["status", "--json"]]) {
      const status = await instance.cli(args, { timeoutMs: 60_000 });
      expect(status.code, status.stderr).toBe(0);
      if (args.includes("--json")) {
        const payload = JSON.parse(status.stdout) as typeof gatewayStatus;
        expect(payload.degradedSecretOwners).toEqual(gatewayStatus.degradedSecretOwners);
        expect(payload.degradedPlugins).toEqual(gatewayStatus.degradedPlugins);
      } else {
        expect(status.stdout).toContain("Degraded secrets");
        expect(status.stdout).toContain("capability:tts");
        expect(status.stdout).toContain("Degraded plugins");
        expect(status.stdout).toContain(DEGRADED_PLUGIN_ID);
      }
      expect(`${status.stdout}\n${status.stderr}`).not.toContain("STATUS_E2E_MISSING_SECRET");
      expect(`${status.stdout}\n${status.stderr}`).not.toContain(pluginRoot);
    }

    const logs = instance.logs();
    expect(logs).toContain("Secret owner capability:tts is configured-unavailable");
    expect(logs).toContain(`Plugin "${DEGRADED_PLUGIN_ID}"`);
    expect(logs).not.toContain("STATUS_E2E_MISSING_SECRET");
  }, 120_000);

  it("keeps healthy and unreachable Gateway degradation summaries empty", async () => {
    const instance = await createInstance({
      name: "status-runtime-healthy",
      reserveIdlePort: false,
    });
    await instance.startGateway();
    expectHealthy(await instance.cli(["status", "--json"]));

    await instance.stopGateway();
    expectHealthy(await instance.cli(["status", "--json"]));
  }, 120_000);

  it.each([
    { name: "text status", args: ["status"] },
    { name: "JSON status", args: ["status", "--json"] },
    { name: "all status", args: ["status", "--all"] },
    { name: "channel probe", args: ["channels", "status", "--probe", "--json"] },
  ])(
    "does not create shared state during $name",
    async ({ name, args }) => {
      const instance = await createInstance({
        name: `status-read-only-${name.replaceAll(" ", "-")}`,
        reserveIdlePort: false,
      });
      const databasePath = path.join(instance.stateDir, "state", "openclaw.sqlite");
      expect(fs.existsSync(databasePath)).toBe(false);

      const status = await instance.cli(args);

      expect(status.code, status.stderr).toBe(0);
      if (args[0] === "status" && args.includes("--json")) {
        expect(JSON.parse(status.stdout)).not.toHaveProperty("tasks");
      }
      expect(fs.existsSync(databasePath)).toBe(false);
    },
    120_000,
  );

  it("reads status while the Gateway owns state and another writer is active", async () => {
    const instance = await createInstance({ name: "status-read-only-live-gateway" });
    const databasePath = path.join(instance.stateDir, "state", "openclaw.sqlite");
    await instance.startGateway();
    // The Gateway still writes after readiness, so wait for its write lock like product writers do.
    using writer = new DatabaseSync(databasePath, { timeout: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS });
    // A read-only status path can overlap this writer. Writable schema/bootstrap work cannot.
    writer.exec("BEGIN IMMEDIATE");

    const status = await instance.cli(["status", "--json"], { timeoutMs: 15_000 });

    expectHealthy(status);
    expect(instance.child?.exitCode).toBeNull();

    writer.exec("ROLLBACK");
    writer.close();
    await instance.stopGateway();

    using verifier = new DatabaseSync(databasePath, { readOnly: true });
    expect(verifier.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
  }, 120_000);
});
