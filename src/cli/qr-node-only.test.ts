import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import {
  consumeDeviceBootstrapTokenWithSetupCompletion,
  readDevicePairSetupCompletion,
  verifyDeviceBootstrapToken,
} from "../infra/device-bootstrap.js";
import { decodePairingSetupCode } from "../pairing/setup-code.js";
import { defaultRuntime } from "../runtime.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { registerQrCli } from "./qr-cli.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

it("issues the native node-only setup into the selected Gateway database", async () => {
  const stateDir = await tempDirs.make("qr-node-only-selected-");
  const foreign = await tempDirs.make("qr-node-only-foreign-");
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      gateway: {
        auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-test-user" } },
      },
    }),
    { mode: 0o600 },
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  for (const name of ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"]) {
    vi.stubEnv(name, undefined);
  }
  const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  const url = "wss://gateway.example.test/node";
  const command = new Command();
  registerQrCli(command);
  await command.parseAsync(["qr", "--node-only", "--json", "--public-url", url], { from: "user" });

  expect(output.mock.calls.length).toBe(1);
  const value: unknown = output.mock.calls[0]?.[0];
  if (
    typeof value !== "object" ||
    value === null ||
    !("access" in value) ||
    !("auth" in value) ||
    !("urlSource" in value) ||
    !("gatewayUrl" in value) ||
    !("setupId" in value) ||
    !("expiresAtMs" in value) ||
    !("setupCode" in value) ||
    typeof value.setupCode !== "string" ||
    typeof value.setupId !== "string" ||
    typeof value.expiresAtMs !== "number"
  ) {
    throw new Error("Invalid node-only CLI record");
  }
  expect(value.auth).toBe("trusted-proxy");
  expect(typeof value.urlSource).toBe("string");
  expect(value.access).toBe("node");
  expect(value.gatewayUrl).toBe(url);
  expect(value.expiresAtMs).toBeGreaterThan(Date.now());
  const setup = decodePairingSetupCode(value.setupCode);
  expect(setup.url).toBe(url);
  expect(setup.expiresAtMs).toBe(value.expiresAtMs);
  expect((await fs.stat(path.join(stateDir, "state", "openclaw.sqlite"))).isFile()).toBe(true);

  // Read and consume through the native pairing owner. The verification results
  // have no secret values. The setup code and SQLite contents stay in this test.
  const node = {
    token: setup.bootstrapToken,
    deviceId: randomUUID(),
    publicKey: randomUUID(),
    role: "node",
    scopes: [],
  };
  expect((await verifyDeviceBootstrapToken({ ...node, baseDir: foreign })).ok).toBe(false);
  expect(
    (
      await verifyDeviceBootstrapToken({
        ...node,
        role: "operator",
        scopes: ["operator.admin"],
        baseDir: stateDir,
      })
    ).ok,
  ).toBe(false);
  expect(
    (await verifyDeviceBootstrapToken({ ...node, role: "operator", scopes: [], baseDir: stateDir }))
      .ok,
  ).toBe(false);
  expect((await verifyDeviceBootstrapToken({ ...node, baseDir: stateDir })).ok).toBe(true);
  await consumeDeviceBootstrapTokenWithSetupCompletion({
    baseDir: stateDir,
    token: node.token,
    deviceId: node.deviceId,
    completedAtMs: Date.now(),
  });
  const completion = await readDevicePairSetupCompletion({
    baseDir: stateDir,
    setupId: value.setupId,
  });
  expect(completion?.setupId).toBe(value.setupId);
  expect(completion?.deviceId).toBe(node.deviceId);
  expect(completion?.access).toBe("node");
  expect(
    await readDevicePairSetupCompletion({ baseDir: foreign, setupId: value.setupId }),
  ).toBeNull();
});
