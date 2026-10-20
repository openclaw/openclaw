import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import { withRuntimePreload } from "../../test/helpers/runtime-preload.js";
import {
  readOriginDeviceTokenReadOnlyForTest,
  seedOriginDeviceToken,
} from "../infra/device-auth-store.test-support.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";
import {
  prepareGatewayCliFixture,
  prepareSharedStateReadArtifacts,
  runIsolatedGatewayCli,
  snapshotDirectoryContents,
  snapshotSharedStateArtifacts,
  tempDirs,
  UNREACHABLE_GATEWAY_URL,
} from "./gateway-backed-exit.process.test-support.js";
import {
  EMPTY_STABILITY_SNAPSHOT,
  expectCliResult,
  startAgentTurnGateway,
  startCliReadGateway,
  startCronLookupMissGateway,
  startGatewayStabilityRpcServer,
  startNodePairingGateway,
} from "./gateway-backed-exit.test-helpers.js";

// Measure socket release from the complete payload, excluding cold startup.
const ONE_SHOT_EXIT_BUDGET_MS = 5_000;
const TEST_TOKEN = "test-token";
const cliEntrypoint = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli);

async function remoteFixture(root: string, remote: { url: string; token?: string }) {
  return { root, ...(await prepareGatewayCliFixture(root, { mode: "remote", remote })) };
}

function seedDeviceAuth(root: string, stateDir: string, url: string, token: string) {
  const env = { ...process.env, HOME: root, OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: stateDir };
  openOpenClawStateDatabase({ env });
  const identity = loadOrCreateDeviceIdentity({ env });
  seedOriginDeviceToken({
    gatewayScope: gatewayOriginScope(url),
    deviceId: identity.deviceId,
    role: "operator",
    token,
    scopes: ["operator.admin"],
    env,
  });
  closeOpenClawStateDatabaseForTest();
  prepareSharedStateReadArtifacts(stateDir);
  return { identity, env };
}

const statusArgs = (url: string, token: string) => [
  "gateway",
  "status",
  "--url",
  url,
  "--token",
  token,
  "--require-rpc",
  "--json",
  "--timeout",
  "2000",
];

function expectGuidance(stderr: string, message: string) {
  expect(stderr).toContain(message);
  expect(stderr).not.toMatch(
    /The CLI command failed|Could not start the CLI|OPENCLAW_DEBUG|Stack:|openclaw doctor/u,
  );
}

it.each([
  { status: "ok" as const, text: "pong", exitCode: 0 },
  { status: "error" as const, text: "provider failed", exitCode: 1 },
])("exits $exitCode after an agent turn reports $status", async ({ status, text, exitCode }) => {
  const root = tempDirs.make(`openclaw-agent-turn-${status}-`);
  const gateway = await startAgentTurnGateway({ status, text });
  const fixture = await remoteFixture(root, { url: gateway.url, token: gateway.token });

  const result = await runIsolatedGatewayCli({
    args: ["agent", "--agent", "main", "--message", "ping", "--json"],
    ...fixture,
  });

  expect(expectCliResult(result, exitCode)).toMatchObject({
    status,
    summary: status === "ok" ? "completed" : "failed",
    result: { payloads: [{ text }] },
  });
});

it("lists nodes with an explicit positive timeout", async () => {
  const root = tempDirs.make("openclaw-nodes-timeout-");
  const gateway = await startNodePairingGateway({ token: TEST_TOKEN });
  const fixture = await remoteFixture(root, { url: gateway.url, token: TEST_TOKEN });

  const result = await runIsolatedGatewayCli({
    args: ["nodes", "list", "--timeout", "10000", "--json"],
    ...fixture,
  });

  expect(expectCliResult(result)).toMatchObject({
    pending: [{ requestId: "request-1", nodeId: "node-1" }],
    paired: [],
  });
  expect(gateway.connectionCount).toBeGreaterThan(0);
  expect(gateway.calls).toEqual(["node.pair.list", "node.list"]);
});

it.each([
  {
    label: "node approval",
    start: startNodePairingGateway,
    snapshot: snapshotDirectoryContents,
    args: ["nodes", "approve", "request-1", "--json"],
    result: { approved: true },
    calls: ["node.pair.list", "node.pair.approve"],
  },
  {
    label: "stability RPC",
    start: startGatewayStabilityRpcServer,
    snapshot: snapshotSharedStateArtifacts,
    args: ["gateway", "call", "diagnostics.stability", "--json"],
    result: EMPTY_STABILITY_SNAPSHOT,
    calls: ["diagnostics.stability"],
  },
])("uses stored auth for $label without persisting hello-issued tokens or state", async (test) => {
  const root = tempDirs.make("openclaw-stored-auth-");
  const storedToken = "stored-device-token";
  const gateway: { url: string; calls: string[]; authInputs?: unknown[] } = await test.start(
    { deviceToken: storedToken },
    "issued-device-token",
  );
  const fixture = await remoteFixture(root, { url: gateway.url });
  const { stateDir } = fixture;
  const { identity, env } = seedDeviceAuth(root, stateDir, gateway.url, storedToken);
  const before = await test.snapshot(stateDir);
  const result = await runIsolatedGatewayCli({ args: test.args, ...fixture });
  expect(expectCliResult(result)).toEqual(test.result);
  expect(gateway.calls).toEqual(test.calls);
  if (test.label === "stability RPC") {
    expect(gateway.authInputs).toEqual([{ deviceToken: storedToken }]);
  }
  expect(
    readOriginDeviceTokenReadOnlyForTest({
      gatewayScope: gatewayOriginScope(gateway.url),
      deviceId: identity.deviceId,
      role: "operator",
      env,
    })?.token,
  ).toBe(storedToken);
  expect(await test.snapshot(stateDir)).toEqual(before);
});

it("requires a reachable status RPC without changing seeded shared state", async () => {
  const root = tempDirs.make("openclaw-gateway-status-seeded-");
  const token = "configured-token";
  const gateway = await startGatewayStabilityRpcServer({ token }, "issued-device-token");
  const fixture = await remoteFixture(root, { url: gateway.url, token });
  const { stateDir } = fixture;
  seedDeviceAuth(root, stateDir, gateway.url, token);
  const before = await snapshotSharedStateArtifacts(stateDir);
  expect(Object.keys(before).includes("openclaw.sqlite")).toBe(true);

  const result = await runIsolatedGatewayCli({
    args: statusArgs(gateway.url, token),
    ...fixture,
  });

  expect(expectCliResult(result)).toMatchObject({
    rpc: { ok: true, kind: "read" },
  });
  expect(gateway.calls).toEqual(["status"]);
  expect(await snapshotSharedStateArtifacts(stateDir)).toEqual(before);
});

it.runIf(process.platform !== "win32")(
  "runs gateway status through one OpenClaw entry process",
  async () => {
    const root = tempDirs.make("openclaw-gateway-status-entry-process-");
    const pidLogPath = path.join(root, "entry-pids");
    const preloadPath = path.join(root, "track-entry-pid.mjs");
    const token = "configured-token";
    const gateway = await startGatewayStabilityRpcServer({ token }, "issued-device-token");
    const fixture = await remoteFixture(root, { url: gateway.url, token });
    const { stateDir } = fixture;
    expect(await snapshotSharedStateArtifacts(stateDir)).toEqual({});
    await fs.writeFile(
      preloadPath,
      [
        'import fs from "node:fs";',
        'const entry = process.argv[1]?.replaceAll("\\\\", "/");',
        `if (entry === ${JSON.stringify(fileURLToPath(cliEntrypoint).replaceAll("\\", "/"))}) {`,
        "  fs.appendFileSync(process.env.OPENCLAW_ENTRY_PID_LOG, `${process.pid}\\n`);",
        "}",
        "",
      ].join("\n"),
    );

    const result = await runIsolatedGatewayCli({
      args: statusArgs(gateway.url, token),
      ...fixture,
      env: {
        ...withRuntimePreload({}, preloadPath),
        OPENCLAW_ENTRY_PID_LOG: pidLogPath,
        OPENCLAW_NODE_EXTRA_CA_CERTS_READY: "1",
        OPENCLAW_NODE_OPTIONS_READY: undefined,
        OPENCLAW_NO_RESPAWN: undefined,
      },
    });

    expect(expectCliResult(result)).toMatchObject({
      rpc: { ok: true, kind: "read" },
    });
    const entryPids = (await fs.readFile(pidLogPath, "utf8")).trim().split(/\s+/u);
    expect(new Set(entryPids).size).toBe(1);
    expect(await snapshotSharedStateArtifacts(stateDir)).toEqual({});
  },
);

it("rejects invalid remote config before a node pairing mutation without opening state", async () => {
  const root = tempDirs.make("openclaw-node-pairing-invalid-config-");
  const gateway = await startNodePairingGateway({ token: "test-token" });
  const { stateDir, configPath } = await prepareGatewayCliFixture(root, {
    mode: "remtoe",
    remote: { url: gateway.url, token: "test-token" },
  });

  const result = await runIsolatedGatewayCli({
    args: ["nodes", "approve", "request-1", "--json"],
    root,
    stateDir,
    configPath,
  });

  expect(result).toMatchObject({ code: 1, signal: null });
  expect(JSON.parse(result.stdout)).toEqual({
    ok: false,
    error: {
      type: "cli_error",
      message: expect.stringContaining("OpenClaw config is invalid:"),
    },
    repairHint: "Run `openclaw doctor --fix` to repair, then retry.",
    issues: [
      {
        path: "gateway.mode",
        message: expect.stringContaining("Invalid input"),
        allowedValues: ["local", "remote"],
      },
    ],
  });
  expect(result.stderr).toContain("OpenClaw config is invalid");
  expect(result.stderr).toContain("gateway.mode");
  expect(gateway.calls).toEqual([]);
  await expect(fs.stat(path.join(stateDir, "state", "openclaw.sqlite"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("exits promptly after cron list emits complete output", async () => {
  const root = tempDirs.make("openclaw-gateway-cli-exit-");
  const caTriggerPath = path.join(root, "load-default-ca.mjs");
  const gateway = await startCliReadGateway(TEST_TOKEN);
  const { stateDir, configPath } = await remoteFixture(root, {
    url: gateway.url,
    token: TEST_TOKEN,
  });
  await fs.writeFile(
    caTriggerPath,
    `if (process.env.OPENCLAW_NODE_OPTIONS_READY === "1") {
  const { getCACertificates } = await import("node:tls");
  getCACertificates("default");
}
`,
  );

  // A parseable JSON buffer starts the socket-release budget.
  let completeOutputAt: number | undefined;
  const result = await runCliProcessChild({
    nodeArgs: [
      ...resolveRuntimeWorkerArgv(cliEntrypoint).slice(0, -1),
      "--import",
      pathToFileURL(caTriggerPath).href,
      fileURLToPath(cliEntrypoint),
      "cron",
      "list",
      "--json",
    ],
    env: {
      ...process.env,
      HOME: root,
      // Exercise NODE_OPTIONS respawn without stacking the compile-cache respawn;
      // entry.compile-cache owns the latter contract.
      NODE_DISABLE_COMPILE_CACHE: "1",
      NODE_ENV: undefined,
      NODE_OPTIONS: undefined,
      NODE_USE_SYSTEM_CA: "1",
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_NODE_OPTIONS_READY: undefined,
      OPENCLAW_STATE_DIR: stateDir,
      VITEST: undefined,
    },
    onStdout: (stdout) => {
      if (completeOutputAt !== undefined) {
        return;
      }
      try {
        JSON.parse(stdout);
      } catch {
        return;
      }
      completeOutputAt = Date.now();
    },
  });
  const exitedAt = Date.now();

  expect(expectCliResult(result)).toMatchObject({ jobs: [], total: 0 });
  expect(completeOutputAt).toEqual(expect.any(Number));
  expect(exitedAt - (completeOutputAt ?? 0)).toBeLessThanOrEqual(ONE_SHOT_EXIT_BUDGET_MS);
});

it("renders a devices list URL override without explicit credentials as expected guidance, not a crash", async () => {
  const root = tempDirs.make("openclaw-devices-list-explicit-auth-");
  // Reject before connect: configured credentials must never reach a caller-supplied URL.
  const { stateDir, configPath } = await prepareGatewayCliFixture(root, {
    mode: "local",
    auth: { mode: "token", token: "configured-token" },
  });

  const result = await runIsolatedGatewayCli({
    args: ["devices", "list", "--url", UNREACHABLE_GATEWAY_URL, "--timeout", "250"],
    root,
    stateDir,
    configPath,
  });

  expect(result).toMatchObject({ code: 1, signal: null, stdout: "" });
  // The shared console redaction masks the word after "--password"; assert around it.
  expect(result.stderr).toContain("Fix: pass --token or --password");
  expect(result.stderr).toContain("--url (or gatewayToken in tools).");
  expect(result.stderr).toContain("remove --url to use the configured target.");
  expect(result.stderr).toContain(`Config: ${configPath}`);
  expectGuidance(result.stderr, "gateway url override requires explicit credentials");
});

it("renders a machine-mode cron lookup miss as expected guidance, not a crash", async () => {
  const root = tempDirs.make("openclaw-cron-lookup-miss-machine-");
  const gateway = await startCronLookupMissGateway(TEST_TOKEN, "missing-job");
  const fixture = await remoteFixture(root, { url: gateway.url, token: TEST_TOKEN });
  const result = await runIsolatedGatewayCli({
    ...fixture,
    args: ["cron", "show", "missing-job", "--json"],
  });

  const message =
    "Automation not found: missing-job. Run `openclaw cron list` to see recent automation ids.";
  expect(result).toMatchObject({ code: 1, signal: null });
  expect(JSON.parse(result.stdout)).toEqual({
    ok: false,
    error: { type: "cli_error", message },
  });
  expectGuidance(result.stderr, message);
  expect(gateway.calls).toEqual(["cron.get", "cron.list"]);
});
