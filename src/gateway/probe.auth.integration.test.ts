import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { createStatusGatewayProbeBudget } from "../commands/status.gateway-probe-budget.js";
import { resolveGatewayProbeSnapshot } from "../commands/status.scan.shared.js";
import type { OpenClawConfig } from "../config/config.js";
import * as deviceAuthStore from "../infra/device-auth-store.js";
import { listDevicePairing, removePairedDevice } from "../infra/device-pairing.js";
import { resolveGatewayDeviceAuthRoute } from "./connection-details.js";
import { createGatewaySuiteHarness, installGatewayTestHooks, testState } from "./test-helpers.js";

const ssh = vi.hoisted(() => ({ port: 0 }));
vi.mock("../infra/ssh-tunnel.js", async (original) => ({
  ...(await original<typeof import("../infra/ssh-tunnel.js")>()),
  // Only process/forwarding setup is substituted; pairing, storage and all
  // connect/auth/read RPCs still cross the suite's real Gateway socket.
  startSshPortForward: async () => {
    const closed = createDeferred();
    let active = true;
    return {
      localPort: ssh.port,
      pid: null,
      isActive: () => active,
      closed: closed.promise,
      stop: async () => {
        active = false;
        closed.resolve();
      },
    };
  },
}));

installGatewayTestHooks({ scope: "suite" });

const { callGateway } = await import("./call.js");
const { probeGateway } = await import("./probe.js");
const { seedDeviceAuthToken, seedOriginDeviceToken } =
  await import("../infra/device-auth-store.test-support.js");
const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } =
  await import("../infra/device-identity.js");
const { approveDevicePairing } = await import("../infra/device-pairing-approval.js");
const { requestDevicePairing } = await import("../infra/device-pairing.js");
await import("./server.js");

let gatewayHarness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;

beforeAll(async () => {
  gatewayHarness = await createGatewaySuiteHarness();
  ssh.port = gatewayHarness.port;
});

afterAll(async () => {
  await gatewayHarness.close();
});

function requireGatewayToken(): string {
  const token = testState.gatewayAuth?.token;
  if (typeof token !== "string" || !token) {
    throw new Error("expected gateway auth token");
  }
  return token;
}

function statePath(...parts: string[]): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("expected OPENCLAW_STATE_DIR");
  }
  return path.join(stateDir, ...parts);
}

function expectRecord(value: unknown, label: string) {
  if (typeof value !== "object" || value === null) {
    throw new Error(`expected ${label}`);
  }
}

const gatewayUrl = () => `ws://127.0.0.1:${gatewayHarness.port}`;
const probe = (auth?: { token: string }, timeoutMs = 10_000) =>
  probeGateway({ url: gatewayUrl(), auth, timeoutMs });
async function snapshot(cfg: OpenClawConfig) {
  const { gatewayProbe } = await resolveGatewayProbeSnapshot({
    cfg,
    configPath: statePath("openclaw.json"),
    env: { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR },
    opts: { ...createStatusGatewayProbeBudget(10_000), detailLevel: "full" },
  });
  return gatewayProbe;
}
function expectRead(result: Awaited<ReturnType<typeof probe>> | null | undefined) {
  expect(result).toMatchObject({ error: null, ok: true, auth: { capability: "read_only" } });
  expectRecord(result?.health, "probe health");
  expectRecord(result?.status, "probe status");
  expectRecord(result?.configSnapshot, "probe config snapshot");
}

async function seedCachedOperatorToken() {
  const scopes = ["operator.read"];
  const identity = loadOrCreateDeviceIdentity();
  const pairing = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    displayName: "vitest probe",
    platform: process.platform,
    clientId: "test",
    clientMode: "probe",
    role: "operator",
    scopes,
    silent: true,
  });
  const approved = await approveDevicePairing(pairing.request.requestId, { callerScopes: scopes });
  expect(approved?.status).toBe("approved");
  const token =
    approved?.status === "approved" ? (approved.device.tokens?.operator?.token ?? "") : "";
  if (!token) {
    throw new Error("expected approved operator token");
  }
  const auth = { deviceId: identity.deviceId, role: "operator", token, scopes };
  seedOriginDeviceToken({ gatewayScope: gatewayUrl(), ...auth });
  return auth;
}

describe("probeGateway auth integration", () => {
  it("reuses enrolled SSH route auth across local ports without sending it to another route", async () => {
    const token = requireGatewayToken();
    const localAuth = await seedCachedOperatorToken();
    const url = gatewayUrl();
    const remote = {
      url,
      transport: "ssh" as const,
      sshTarget: "fixture@gateway-a",
      remotePort: 18789,
    };
    const config = { gateway: { mode: "remote" as const, remote } };
    try {
      const enrolled = await callGateway({
        config,
        token,
        clientName: GATEWAY_CLIENT_NAMES.TUI,
        mode: GATEWAY_CLIENT_MODES.UI,
        method: "status",
        scopes: ["operator.read"],
        timeoutMs: 10_000,
      });
      expectRecord(enrolled, "SSH enrollment status");

      // Lookup/persistence must use the SSH route, not this different local port.
      const movedUrl = "ws://127.0.0.1:18999";
      const moved = { gateway: { ...config.gateway, remote: { ...remote, url: movedUrl } } };
      const result = await snapshot(moved);
      expect(result).toMatchObject({ error: null, ok: true, auth: { capability: "read_only" } });
      expectRecord(result?.status, "SSH route paired read without shared credentials");

      // The fixture server would accept A's token even on this second route;
      // rejecting anonymously proves B did not inherit A's valid bearer.
      const foreign = await snapshot({
        gateway: { ...config.gateway, remote: { ...remote, sshTarget: "fixture@gateway-b" } },
      });
      expect(foreign?.ok).toBe(false);
      expect(foreign?.connectErrorDetails).toMatchObject({
        code: ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED,
      });
    } finally {
      // Restore shared state before the first-time diagnostic case.
      await removePairedDevice(localAuth.deviceId);
      await deviceAuthStore.clearDeviceAuthToken(localAuth);
      await deviceAuthStore.clearOriginDeviceToken({ ...localAuth, gatewayScope: url });
      const route = resolveGatewayDeviceAuthRoute({
        config,
        url,
        remote: true,
        configuredRemote: true,
      });
      if (route.deviceAuthScope) {
        await deviceAuthStore.clearOriginDeviceToken({
          ...localAuth,
          gatewayScope: route.deviceAuthScope,
        });
      }
    }
  });

  it("keeps direct local authenticated status RPCs device-bound", async () => {
    const status = await callGateway({
      url: gatewayUrl(),
      token: requireGatewayToken(),
      method: "status",
      timeoutMs: 5_000,
    });

    expectRecord(status, "status response");
  });

  it("keeps first-time local authenticated probes non-mutating", async () => {
    const result = await probe({ token: requireGatewayToken() }, 5_000);
    expect(result).toMatchObject({
      ok: false,
      health: null,
      status: null,
      configSnapshot: null,
      auth: { capability: "connected_no_operator_scope" },
    });
    expect(await listDevicePairing()).toMatchObject({ paired: [], pending: [] });
    expect(fs.existsSync(statePath("identity", "device-auth.json"))).toBe(false);
  });

  it("keeps paired local reads and restores remote loopback reads with explicit credentials", async () => {
    const token = requireGatewayToken();
    const localAuth = await seedCachedOperatorToken();
    expectRead(await probe({ token }));
    const url = gatewayUrl();
    expect(await probe()).toMatchObject({ ok: true, auth: { capability: "read_only" } });
    const remote = await snapshot({ gateway: { mode: "remote", remote: { url } } });
    expect(remote?.ok).toBe(false);
    expectRead(await snapshot({ gateway: { mode: "remote", remote: { url, token } } }));

    // A retired SSH tunnel can leave another Gateway's token at the local URL.
    seedOriginDeviceToken({
      ...localAuth,
      gatewayScope: url,
      token: "retired-tunnel-device-token",
    });
    const unbound = await probe();
    expect(unbound.ok).toBe(false);
    expect(unbound.connectErrorDetails).toMatchObject({
      code: ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED,
    });

    const explicit = await probe({ token });
    expect(explicit).toMatchObject({ error: null, ok: true });
    expectRecord(explicit.status, "explicit local auth with stale origin cache");

    seedDeviceAuthToken(localAuth);
    expectRead(await probe());
  });

  it("keeps a locally verified origin token when the client cache changes", async () => {
    const localAuth = await seedCachedOperatorToken();
    await deviceAuthStore.clearDeviceAuthToken({
      deviceId: localAuth.deviceId,
      role: "operator",
    });
    const url = gatewayUrl();
    const load = deviceAuthStore.loadOriginDeviceTokenReadOnly;
    const read = vi
      .spyOn(deviceAuthStore, "loadOriginDeviceTokenReadOnly")
      .mockImplementationOnce(async (...args) => {
        const entry = await load(...args);
        seedOriginDeviceToken({
          ...localAuth,
          gatewayScope: url,
          token: "replacement-tunnel-device-token",
        });
        return entry;
      });
    try {
      const result = await probe();
      expect(result).toMatchObject({ error: null, ok: true });
      expectRecord(result.status, "status after origin cache replacement");
    } finally {
      read.mockRestore();
    }
  });
});
