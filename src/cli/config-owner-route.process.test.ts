import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { GatewayClient } from "../gateway/client.js";
import { startGatewayServer } from "../gateway/server.js";
import { GATEWAY_TEST_ENV_KEYS } from "../gateway/test-helpers.env.js";
import { acquireGatewayLock, type GatewayLockHandle } from "../infra/gateway-lock.js";
import {
  peekGatewayRestartReason,
  resetGatewayRestartStateForInProcessRestart,
} from "../infra/restart.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureEnv } from "../test-utils/env.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { prepareUserProfileCatalogForTest } from "../test-utils/user-profile-catalog.js";
import { writeFixtureJson } from "./cli-fixtures.test-support.js";
import { runStateOwnerCli as run, stateOwnerEnv } from "./cli-process-fixture.test-support.js";

// One real Gateway owns the state root; CLI children are the shapes the Windows companion
// app runs against its own running Gateway (setup wizard, gateway setup, local AI tray).
const roots = useAutoCleanupTempDirTracker(afterAll);
const token = "synthetic-config-route-token";
const prefixEnv = { SYNTH_ROUTE_PREFIX: "synthetic-prefix" };
const provider = {
  baseUrl: "http://127.0.0.1:18080/v1",
  api: "openai-completions",
  apiKey: "llama-local",
  timeoutSeconds: 300,
  models: [{ id: "local", name: "Local", input: ["text"], contextWindow: 32768, maxTokens: 8192 }],
};

describe("config mutations against a running Gateway", () => {
  let env: NodeJS.ProcessEnv;
  let claim: TestPortClaim;
  let lock: GatewayLockHandle | null;
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let observer: GatewayClient | undefined;
  let observerCloses = 0;
  let releaseProfiles: (() => void) | undefined;
  const restoreEnv = captureEnv([
    ...GATEWAY_TEST_ENV_KEYS,
    "OPENCLAW_HOME",
    "OPENCLAW_PATH_BOOTSTRAPPED",
    ...Object.keys(prefixEnv),
  ]);
  const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
  const readConfig = async () =>
    JSON.parse(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8")) as Record<string, any>;
  const gatewayConfig = async () =>
    (await observer!.request<{ sourceConfig: Record<string, any> }>("config.get", {})).sourceConfig;
  const expectGatewayKeptRunning = () => {
    expect(peekGatewayRestartReason()).toBeUndefined();
    expect(hotReloadRecovery).not.toHaveBeenCalled();
    expect(observerCloses).toBe(0);
  };

  beforeAll(async () => {
    // Canonical paths: the Gateway keys resident state by the identity path the CLI resolves.
    const root = await fs.realpath(roots.make("openclaw-config-owner-route-"));
    claim = await acquireTestPortBlock({ offsets: [0] });
    env = stateOwnerEnv(root, { OPENCLAW_GATEWAY_TOKEN: token, ...prefixEnv });
    await fs.mkdir(env.OPENCLAW_STATE_DIR!, { recursive: true });
    await writeFixtureJson(env.OPENCLAW_CONFIG_PATH!, {
      gateway: {
        mode: "local",
        port: claim.port,
        auth: { mode: "token", token },
        reload: { mode: "hybrid" },
      },
      agents: { entries: { main: {} } },
    });
    // Plain assignment: suite-wide stubs would be reset before each test while this Gateway runs.
    Object.assign(process.env, {
      HOME: env.HOME,
      USERPROFILE: env.USERPROFILE,
      OPENCLAW_HOME: env.OPENCLAW_HOME,
      OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR,
      OPENCLAW_CONFIG_PATH: env.OPENCLAW_CONFIG_PATH,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      ...prefixEnv,
    });
    lock = await acquireGatewayLock({ port: claim.port, allowInTests: true, timeoutMs: 0 });
    expect(lock).not.toBeNull();
    server = await startGatewayServer(claim.port, {
      auth: { mode: "token", token },
      controlUiEnabled: false,
      gatewayStateOwner: lock!,
      hotReloadRecovery,
    });
    await server.startupSettled;
    // Mirrors Gateway boot admission, which the CLI run loop performs around this server.
    releaseProfiles = (await prepareUserProfileCatalogForTest()).release;
    // Stands in for the companion app's wizard connection, which must survive every write.
    const connected = createDeferredCore();
    observer = new GatewayClient({
      url: `ws://127.0.0.1:${claim.port}`,
      token,
      clientName: "gateway-client",
      clientVersion: "1.0.0",
      platform: "test",
      mode: "backend",
      deviceIdentity: null,
      scopes: ["operator.admin"],
      hostDeps: {
        loadDeviceAuthToken: () => null,
        storeDeviceAuthToken: () => {},
        clearDeviceAuthToken: () => {},
      },
      onHelloOk: () => connected.resolve(),
      onConnectError: (error) => connected.reject(error),
      onClose: () => {
        observerCloses += 1;
        connected.reject(new Error("observer closed"));
      },
    });
    observer.start();
    await connected.promise;
  }, 120_000);

  afterAll(async () => {
    await observer?.stopAndWait();
    releaseProfiles?.();
    await server?.close();
    resetGatewayRestartStateForInProcessRestart();
    await closeOpenClawStateDatabaseAsync();
    await lock?.release();
    await claim?.release();
    restoreEnv.restore();
  });

  it("suspends and restores gateway.reload.mode through the Gateway without a restart", async () => {
    const suspend = await run(env, ["config", "set", "gateway.reload.mode", "off"]);
    expect(suspend.code, suspend.stderr).toBe(0);
    expect(suspend.stdout).toContain("Updated gateway.reload.mode. No gateway restart needed.");
    expect((await gatewayConfig()).gateway.reload.mode).toBe("off");
    expectGatewayKeptRunning();

    const restore = await run(env, ["config", "set", "gateway.reload.mode", "hybrid"]);
    expect(restore.code, restore.stderr).toBe(0);
    expect((await readConfig()).gateway.reload.mode).toBe("hybrid");
    expect((await gatewayConfig()).gateway.reload.mode).toBe("hybrid");
    expectGatewayKeptRunning();
  });

  it("persists a write under reload off without restarting, like the offline write", async () => {
    const suspend = await run(env, ["config", "set", "gateway.reload.mode", "off"]);
    expect(suspend.code, suspend.stderr).toBe(0);
    const allow = ["canvas.present"];
    const result = await run(env, [
      "config",
      "set",
      "gateway.nodes.commands.allow",
      JSON.stringify(allow),
      "--strict-json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Updated gateway.nodes.commands.allow. Restart the gateway to apply.",
    );
    expect((await readConfig()).gateway.nodes.commands.allow).toEqual(allow);
    expect((await gatewayConfig()).gateway.nodes.commands.allow).toEqual(allow);
    expectGatewayKeptRunning();

    const restore = await run(env, ["config", "set", "gateway.reload.mode", "hybrid"]);
    expect(restore.code, restore.stderr).toBe(0);
    expectGatewayKeptRunning();
  });

  it("replaces a strict JSON array value", async () => {
    const allow = ["canvas.present", "camera.snap"];
    const result = await run(env, [
      "config",
      "set",
      "gateway.nodes.commands.allow",
      JSON.stringify(allow),
      "--strict-json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    const shrink = await run(env, [
      "config",
      "set",
      "gateway.nodes.commands.allow",
      JSON.stringify(allow.slice(1)),
      "--strict-json",
    ]);
    expect(shrink.code, shrink.stderr).toBe(0);
    expect((await gatewayConfig()).gateway.nodes.commands.allow).toEqual(allow.slice(1));
  });

  it("replaces an object holding arrays with a scalar", async () => {
    const object = await run(env, [
      "config",
      "set",
      "tools.toolSearch",
      JSON.stringify({ include: [{ source: "mcp" }] }),
      "--strict-json",
    ]);
    expect(object.code, object.stderr).toBe(0);
    const scalar = await run(env, ["config", "set", "tools.toolSearch", "false"]);
    expect(scalar.code, scalar.stderr).toBe(0);
    expect((await gatewayConfig()).tools.toolSearch).toBe(false);
  });

  it("previews then applies a batch file, and unsets the written paths", async () => {
    const batchFile = path.join(env.HOME!, "local-ai.batch.json");
    await writeFixtureJson(batchFile, [
      { path: "models.providers.llamacpp", value: provider },
      { path: "agents.defaults.model.primary", value: "llamacpp/local" },
    ]);
    const preview = await run(env, ["config", "set", "--batch-file", batchFile, "--dry-run"]);
    expect(preview.code, preview.stderr).toBe(0);
    expect((await readConfig()).models).toBeUndefined();
    const apply = await run(env, ["config", "set", "--batch-file", batchFile]);
    expect(apply.code, apply.stderr).toBe(0);
    expect(apply.stdout).toContain("Updated 2 config paths.");
    const applied = await gatewayConfig();
    expect(applied.models.providers.llamacpp).toMatchObject({ baseUrl: provider.baseUrl });
    expect(applied.agents.defaults.model.primary).toBe("llamacpp/local");

    for (const unsetPath of ["agents.defaults.model.primary", "models.providers.llamacpp"]) {
      const unset = await run(env, ["config", "unset", unsetPath]);
      expect(unset.code, unset.stderr).toBe(0);
      expect(unset.stdout).toContain(`Removed ${unsetPath}.`);
    }
    const removed = await readConfig();
    expect(removed.models?.providers?.llamacpp).toBeUndefined();
    expect(removed.agents?.defaults?.model?.primary).toBeUndefined();
  });

  // config.patch carries no explicit paths, so the Gateway's writer would keep an escaped
  // literal and clear a supplied session-store owner; both refuse instead of diverging.
  it("refuses changes the Gateway's writer would save differently", async () => {
    const literal = await run(env, [
      "config",
      "set",
      "messages.responsePrefix",
      "$${SYNTH_ROUTE_PREFIX}",
    ]);
    expect(literal.code, literal.stderr).toBe(0);
    const ownerBatch = path.join(env.HOME!, "session-owner.batch.json");
    const writeBatch = (store: string) =>
      fs.writeFile(
        ownerBatch,
        JSON.stringify([
          { path: "session.store", value: store },
          { path: "agents.defaults.sessionStore.agentId", value: "main" },
        ]),
      );
    await writeBatch("~/sessions-a/sessions.json");
    const assign = await run(env, ["config", "set", "--batch-file", ownerBatch]);
    expect(assign.code, assign.stderr).toBe(0);
    const before = await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8");
    expect(JSON.parse(before)).toMatchObject({
      messages: { responsePrefix: "$${SYNTH_ROUTE_PREFIX}" },
      agents: { defaults: { sessionStore: { agentId: "main" } } },
    });

    await writeBatch("~/sessions-b/sessions.json");
    for (const args of [
      ["config", "set", "messages.responsePrefix", "${SYNTH_ROUTE_PREFIX}"],
      ["config", "set", "--batch-file", ownerBatch],
    ]) {
      const result = await run(env, args);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("The running Gateway would save a different result");
      expect(result.stderr).toContain("Nothing was sent and no settings were saved.");
      expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8")).toBe(before);
    }
    expectGatewayKeptRunning();
  });

  it("keeps the missing-path error for an unset of an absent path", async () => {
    const before = await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8");
    const result = await run(env, ["config", "unset", "agents.defaults.model.primary"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "Config path not found: agents.defaults.model.primary. Nothing was changed.",
    );
    expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8")).toBe(before);
  });

  it("refuses a config file other than the one the Gateway writes", async () => {
    const before = await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8");
    const otherPath = path.join(env.HOME!, "other.openclaw.json");
    await fs.writeFile(otherPath, before);
    const result = await run({ ...env, OPENCLAW_CONFIG_PATH: otherPath }, [
      "config",
      "set",
      "gateway.reload.mode",
      "off",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Nothing was sent and no settings were saved.");
    expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8")).toBe(before);
    expect(await fs.readFile(otherPath, "utf8")).toBe(before);
  });

  it.each(["OPENCLAW_CONFIG_READONLY", "OPENCLAW_NIX_MODE"])(
    "keeps immutable config immutable under %s",
    async (key) => {
      const before = await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8");
      const result = await run({ ...env, [key]: "1" }, [
        "config",
        "set",
        "gateway.reload.mode",
        "off",
      ]);
      expect(result.code).toBe(1);
      expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8")).toBe(before);
      expect((await gatewayConfig()).gateway.reload.mode).toBe("hybrid");
    },
  );

  // The Windows companion app runs baseline setup after onboarding, with its Gateway running.
  it("runs baseline setup through the Gateway with the offline result, then as a no-op", async () => {
    const before = await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8");
    const offlineRoot = await fs.realpath(roots.make("openclaw-setup-offline-"));
    const offlineEnv = stateOwnerEnv(offlineRoot, prefixEnv);
    await fs.mkdir(offlineEnv.OPENCLAW_STATE_DIR!, { recursive: true });
    await fs.writeFile(offlineEnv.OPENCLAW_CONFIG_PATH!, before);
    const setup = (runEnv: NodeJS.ProcessEnv, ...extra: string[]) =>
      run(runEnv, ["setup", "--baseline", "--workspace", path.join(runEnv.HOME!, "ws"), ...extra]);
    const comparable = async (runEnv: NodeJS.ProcessEnv) => {
      const { meta: _meta, ...config } = JSON.parse(
        (await fs.readFile(runEnv.OPENCLAW_CONFIG_PATH!, "utf8")).replaceAll(runEnv.HOME!, "~"),
      ) as Record<string, unknown>;
      return config;
    };

    const offline = await setup(offlineEnv);
    expect(offline.code, offline.stderr).toBe(0);
    const routed = await setup(env);
    expect(routed.code, routed.stderr).toBe(0);
    expect(routed.stdout).toContain("set agents.defaults.workspace");
    expect(await comparable(env)).toEqual(await comparable(offlineEnv));
    expect((await gatewayConfig()).agents.defaults.workspace).toBe(path.join(env.HOME!, "ws"));

    const written = await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8");
    const rerun = await setup(env, "--json");
    expect(rerun.code, rerun.stderr).toBe(0);
    expect(JSON.parse(rerun.stdout)).toMatchObject({ ok: true, configStatus: "unchanged" });
    expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8")).toBe(written);

    const skip = await setup(env, "--skip-bootstrap", "--json");
    expect(skip.code, skip.stderr).toBe(0);
    expect(JSON.parse(skip.stdout)).toMatchObject({ ok: true, configStatus: "updated" });
    expect((await gatewayConfig()).agents.defaults.skipBootstrap).toBe(true);
    expectGatewayKeptRunning();
  });

  it("refuses database settings, which stay offline-only", async () => {
    const before = await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8");
    const result = await run(env, ["config", "set", "database.postgres.schemaPrefix", "repaired"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("This command is offline-only. Database settings");
    expect(result.stderr).toContain("stop the Gateway through its service owner");
    expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8")).toBe(before);
    expectGatewayKeptRunning();
  });
});
