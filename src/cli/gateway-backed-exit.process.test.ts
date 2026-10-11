// Process coverage for one-shot Gateway CLI output followed by clean exit.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import { withRuntimePreload } from "../../test/helpers/runtime-preload.js";
import {
  readOriginDeviceTokenReadOnlyForTest,
  seedOriginDeviceToken,
} from "../infra/device-auth-store.test-support.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";
import {
  prepareGatewayCliFixture,
  prepareSharedStateReadArtifacts,
  prepareUnreachableGatewayCliFixture,
  runIsolatedGatewayCli,
  snapshotDirectoryContents,
  snapshotSharedStateArtifacts,
  tempDirs,
  UNREACHABLE_GATEWAY_URL,
} from "./gateway-backed-exit.process.test-support.js";
import {
  EMPTY_STABILITY_SNAPSHOT,
  startAgentTurnGateway,
  startCliReadGateway,
  startCronLookupMissGateway,
  startGatewayStabilityRpcServer,
  startNodePairingGateway,
} from "./gateway-backed-exit.test-helpers.js";

// A one-shot command must release its Gateway socket once its output is complete.
// The clock starts at the complete payload, so cold startup never enters this budget.
const ONE_SHOT_EXIT_BUDGET_MS = 5_000;
const cliEntrypoint = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli);

describe("gateway-backed CLI process exit", () => {
  it.each([
    { status: "ok" as const, text: "pong", exitCode: 0 },
    { status: "error" as const, text: "provider failed", exitCode: 1 },
  ])("exits $exitCode after an agent turn reports $status", async ({ status, text, exitCode }) => {
    const root = tempDirs.make(`openclaw-agent-turn-${status}-`);
    const gateway = await startAgentTurnGateway({ status, text });
    const { stateDir, configPath } = await prepareGatewayCliFixture(root, {
      mode: "remote",
      remote: { url: gateway.url, token: gateway.token },
    });

    const result = await runIsolatedGatewayCli({
      args: ["agent", "--agent", "main", "--message", "ping", "--json"],
      root,
      stateDir,
      configPath,
    });

    expect(result, result.stderr).toMatchObject({ code: exitCode, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status,
      summary: status === "ok" ? "completed" : "failed",
      result: { payloads: [{ text }] },
    });
  });

  it("lists nodes with an explicit positive timeout", async () => {
    const root = tempDirs.make("openclaw-nodes-timeout-");
    const token = "test-token";
    const gateway = await startNodePairingGateway({ token });
    const { stateDir, configPath } = await prepareGatewayCliFixture(root, {
      mode: "remote",
      remote: { url: gateway.url, token },
    });

    const result = await runIsolatedGatewayCli({
      args: ["nodes", "list", "--timeout", "10000", "--json"],
      root,
      stateDir,
      configPath,
    });

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      pending: [{ requestId: "request-1", nodeId: "node-1" }],
      paired: [],
    });
    expect(gateway.connectionCount).toBeGreaterThan(0);
    expect(gateway.calls).toEqual(["node.pair.list", "node.list"]);
  });

  it("uses existing device auth without persisting a hello-issued token or coordinator state", async () => {
    const root = tempDirs.make("openclaw-node-pairing-stored-auth-");
    const storedToken = "stored-device-token";
    const gateway = await startNodePairingGateway(
      { deviceToken: storedToken },
      "issued-device-token",
    );
    const { stateDir, configPath } = await prepareGatewayCliFixture(root, {
      mode: "remote",
      remote: { url: gateway.url },
    });
    const stateEnv = {
      ...process.env,
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const identity = loadOrCreateDeviceIdentity({ env: stateEnv });
    seedOriginDeviceToken({
      gatewayScope: gatewayOriginScope(gateway.url),
      deviceId: identity.deviceId,
      role: "operator",
      token: storedToken,
      scopes: ["operator.admin"],
      env: stateEnv,
    });
    closeOpenClawStateDatabaseForTest();
    prepareSharedStateReadArtifacts(stateDir);
    const before = await snapshotDirectoryContents(stateDir);

    const result = await runIsolatedGatewayCli({
      args: ["nodes", "approve", "request-1", "--json"],
      root,
      stateDir,
      configPath,
    });

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({ approved: true });
    expect(gateway.calls).toEqual(["node.pair.list", "node.pair.approve"]);
    expect(await snapshotDirectoryContents(stateDir)).toEqual(before);
    expect(
      readOriginDeviceTokenReadOnlyForTest({
        gatewayScope: gatewayOriginScope(gateway.url),
        deviceId: identity.deviceId,
        role: "operator",
        env: stateEnv,
      })?.token,
    ).toBe(storedToken);
  });

  it("calls a reachable Gateway with stored auth without changing shared state", async () => {
    const root = tempDirs.make("openclaw-gateway-call-stored-auth-");
    const storedToken = "stored-device-token";
    const gateway = await startGatewayStabilityRpcServer(
      { deviceToken: storedToken },
      "issued-device-token",
    );
    const { stateDir, configPath } = await prepareGatewayCliFixture(root, {
      mode: "remote",
      remote: { url: gateway.url },
    });
    const stateEnv = {
      ...process.env,
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const identity = loadOrCreateDeviceIdentity({ env: stateEnv });
    seedOriginDeviceToken({
      gatewayScope: gatewayOriginScope(gateway.url),
      deviceId: identity.deviceId,
      role: "operator",
      token: storedToken,
      scopes: ["operator.admin"],
      env: stateEnv,
    });
    closeOpenClawStateDatabaseForTest();
    prepareSharedStateReadArtifacts(stateDir);
    const before = await snapshotSharedStateArtifacts(stateDir);

    const result = await runIsolatedGatewayCli({
      args: ["gateway", "call", "diagnostics.stability", "--json"],
      root,
      stateDir,
      configPath,
    });

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(EMPTY_STABILITY_SNAPSHOT);
    expect(gateway.authInputs).toEqual([{ deviceToken: storedToken }]);
    expect(gateway.calls).toEqual(["diagnostics.stability"]);
    expect(
      readOriginDeviceTokenReadOnlyForTest({
        gatewayScope: gatewayOriginScope(gateway.url),
        deviceId: identity.deviceId,
        role: "operator",
        env: stateEnv,
      })?.token,
    ).toBe(storedToken);
    expect(await snapshotSharedStateArtifacts(stateDir)).toEqual(before);
  });

  it.each([{ label: "seeded", seeded: true }])(
    "requires a reachable status RPC without changing $label shared state",
    async ({ label, seeded }) => {
      const root = tempDirs.make(`openclaw-gateway-status-${label}-`);
      const token = "configured-token";
      const gateway = await startGatewayStabilityRpcServer({ token }, "issued-device-token");
      const { stateDir, configPath } = await prepareGatewayCliFixture(root, {
        mode: "remote",
        remote: { url: gateway.url, token },
      });
      const stateEnv = {
        ...process.env,
        HOME: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: stateDir,
      };
      if (seeded) {
        const identity = loadOrCreateDeviceIdentity({ env: stateEnv });
        seedOriginDeviceToken({
          gatewayScope: gatewayOriginScope(gateway.url),
          deviceId: identity.deviceId,
          role: "operator",
          token,
          scopes: ["operator.admin"],
          env: stateEnv,
        });
        closeOpenClawStateDatabaseForTest();
        prepareSharedStateReadArtifacts(stateDir);
      }
      const before = await snapshotSharedStateArtifacts(stateDir);
      expect(Object.keys(before).includes("openclaw.sqlite")).toBe(seeded);

      const result = await runIsolatedGatewayCli({
        args: [
          "gateway",
          "status",
          "--url",
          gateway.url,
          "--token",
          token,
          "--require-rpc",
          "--json",
          "--timeout",
          "2000",
        ],
        root,
        stateDir,
        configPath,
      });

      expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        rpc: { ok: true, kind: "read" },
      });
      expect(gateway.calls).toEqual(["status"]);
      expect(await snapshotSharedStateArtifacts(stateDir)).toEqual(before);
    },
  );

  it.runIf(process.platform !== "win32")(
    "runs gateway status through one OpenClaw entry process",
    async () => {
      const root = tempDirs.make("openclaw-gateway-status-entry-process-");
      const pidLogPath = path.join(root, "entry-pids");
      const preloadPath = path.join(root, "track-entry-pid.mjs");
      const token = "configured-token";
      const gateway = await startGatewayStabilityRpcServer({ token }, "issued-device-token");
      const { stateDir, configPath } = await prepareGatewayCliFixture(root, {
        mode: "remote",
        remote: { url: gateway.url, token },
      });
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
        args: [
          "gateway",
          "status",
          "--url",
          gateway.url,
          "--token",
          token,
          "--require-rpc",
          "--json",
          "--timeout",
          "2000",
        ],
        root,
        stateDir,
        configPath,
        env: {
          ...withRuntimePreload({}, preloadPath),
          OPENCLAW_ENTRY_PID_LOG: pidLogPath,
          OPENCLAW_NODE_EXTRA_CA_CERTS_READY: "1",
          OPENCLAW_NODE_OPTIONS_READY: undefined,
          OPENCLAW_NO_RESPAWN: undefined,
        },
      });

      expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        rpc: { ok: true, kind: "read" },
      });
      const entryPids = new Set(
        (await fs.readFile(pidLogPath, "utf8"))
          .trim()
          .split(/\s+/u)
          .map((value) => Number.parseInt(value, 10)),
      );
      expect(entryPids.size).toBe(1);
      expect(await snapshotSharedStateArtifacts(stateDir)).toEqual({});
    },
  );

  it.each([{ label: "seeded", seeded: true }])(
    "exports diagnostics without changing $label shared state",
    async ({ label, seeded }) => {
      const fixture = await prepareUnreachableGatewayCliFixture({
        label: `gateway-diagnostics-export-${label}`,
        seeded,
      });
      const outputPath = path.join(fixture.root, "diagnostics.zip");
      const before = await snapshotSharedStateArtifacts(fixture.stateDir);

      const result = await runIsolatedGatewayCli({
        ...fixture,
        args: [
          "gateway",
          "diagnostics",
          "export",
          "--json",
          "--no-stability-bundle",
          "--output",
          outputPath,
        ],
      });

      expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
      const payload = JSON.parse(result.stdout) as { bytes?: unknown; path?: unknown };
      expect(payload.path).toBe(outputPath);
      expect(payload.bytes).toEqual(expect.any(Number));
      expect(payload.bytes).toBeGreaterThan(0);
      const outputStat = await fs.stat(outputPath);
      expect(outputStat.isFile()).toBe(true);
      expect(outputStat.size).toBe(payload.bytes);
      expect(await snapshotSharedStateArtifacts(fixture.stateDir)).toEqual(before);
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
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const caTriggerPath = path.join(root, "load-default-ca.mjs");
    const token = "test-token";
    const gateway = await startCliReadGateway(token);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      caTriggerPath,
      `if (process.env.OPENCLAW_NODE_OPTIONS_READY === "1") {
  const { getCACertificates } = await import("node:tls");
  getCACertificates("default");
}
`,
    );
    await fs.writeFile(
      configPath,
      JSON.stringify({
        gateway: { mode: "remote", remote: { url: gateway.url, token } },
      }),
    );

    // The command emits one JSON document, so a parseable buffer is the moment its
    // output is complete. Timing the exit from there measures the one-shot release
    // of the Gateway socket instead of the child's startup.
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
        // This case owns the NODE_OPTIONS respawn (the CA trigger only fires in the
        // respawned child). Suppress the separate compile-cache respawn that CI's
        // exported NODE_COMPILE_CACHE would stack on top of it; entry.compile-cache
        // owns that contract.
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

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ jobs: [], total: 0 });
    expect(completeOutputAt).toEqual(expect.any(Number));
    expect(exitedAt - (completeOutputAt ?? 0)).toBeLessThanOrEqual(ONE_SHOT_EXIT_BUDGET_MS);
  });

  it("renders a devices list URL override without explicit credentials as expected guidance, not a crash", async () => {
    const root = tempDirs.make("openclaw-devices-list-explicit-auth-");
    // Configured credentials must not leak to a caller-supplied URL; the producer
    // rejects the override before any socket opens, so the target never listens.
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
    expect(result.stderr).toContain("gateway url override requires explicit credentials");
    // The shared console redaction masks the word after "--password"; assert around it.
    expect(result.stderr).toContain("Fix: pass --token or --password");
    expect(result.stderr).toContain("--url (or gatewayToken in tools).");
    expect(result.stderr).toContain("remove --url to use the configured target.");
    expect(result.stderr).toContain(`Config: ${configPath}`);
    expect(result.stderr).not.toContain("The CLI command failed");
    expect(result.stderr).not.toContain("Could not start the CLI");
    expect(result.stderr).not.toContain("OPENCLAW_DEBUG");
    expect(result.stderr).not.toContain("Stack:");
    expect(result.stderr).not.toContain("openclaw doctor");
  });

  it.each(["--wait-timeout"])(
    "renders an invalid cron run %s duration as operator guidance",
    async (flag) => {
      const root = tempDirs.make("openclaw-cron-invalid-duration-");
      const { stateDir, configPath } = await prepareGatewayCliFixture(root, {
        mode: "remote",
        remote: { url: UNREACHABLE_GATEWAY_URL, token: "test-token" },
      });
      const result = await runIsolatedGatewayCli({
        args: ["cron", "run", "missing-job", "--wait", flag, "not-a-duration", "--json"],
        root,
        stateDir,
        configPath,
      });
      const message =
        'Invalid duration: "not-a-duration". Use values like 500ms, 30s, 5m, 2h, or 1h30m.';
      expect(result).toMatchObject({ code: 1, signal: null, stderr: `${message}\n` });
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        error: { type: "cli_error", message },
      });
    },
  );

  it.each([
    { label: "machine", args: ["cron", "show", "missing-job", "--json"], machineOutput: true },
  ])(
    "renders a $label-mode cron lookup miss as expected guidance, not a crash",
    async ({ label, args, machineOutput }) => {
      const root = tempDirs.make(`openclaw-cron-lookup-miss-${label}-`);
      const token = "test-token";
      const gateway = await startCronLookupMissGateway(token, "missing-job");
      const { stateDir, configPath } = await prepareGatewayCliFixture(root, {
        mode: "remote",
        remote: { url: gateway.url, token },
      });

      const result = await runIsolatedGatewayCli({ args, root, stateDir, configPath });

      const message =
        "Automation not found: missing-job. Run `openclaw cron list` to see recent automation ids.";
      expect(result).toMatchObject({ code: 1, signal: null });
      if (machineOutput) {
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: { type: "cli_error", message },
        });
      } else {
        expect(result.stdout).toBe("");
      }
      expect(result.stderr).toContain(message);
      expect(result.stderr).not.toContain("The CLI command failed");
      expect(result.stderr).not.toContain("Could not start the CLI");
      expect(result.stderr).not.toContain("OPENCLAW_DEBUG");
      expect(result.stderr).not.toContain("Stack:");
      expect(result.stderr).not.toContain("openclaw doctor");
      expect(gateway.calls).toEqual(["cron.get", "cron.list"]);
    },
  );
});
