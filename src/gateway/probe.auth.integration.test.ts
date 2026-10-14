// Probe auth integration tests verify cached operator device tokens and pairing
// state work with call/probe flows against a real local gateway harness.
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
  const token =
    typeof (testState.gatewayAuth as { token?: unknown } | undefined)?.token === "string"
      ? ((testState.gatewayAuth as { token?: string }).token ?? "")
      : "";
  if (!token) {
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

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

async function seedCachedOperatorToken(scopes: string[]) {
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
  const approved = await approveDevicePairing(pairing.request.requestId, {
    callerScopes: scopes,
  });
  expect(approved?.status).toBe("approved");
  const token =
    approved?.status === "approved" ? (approved.device.tokens?.operator?.token ?? "") : "";
  if (!token) {
    throw new Error("expected approved operator token");
  }
  const auth = {
    deviceId: identity.deviceId,
    role: "operator",
    token,
    scopes,
  };
  seedOriginDeviceToken({
    gatewayScope: `ws://127.0.0.1:${gatewayHarness.port}`,
    ...auth,
  });
  return auth;
}

describe("probeGateway auth integration", () => {
  it("reuses enrolled SSH route auth across local ports without sending it to another route", async () => {
    const token = requireGatewayToken();
    const localAuth = await seedCachedOperatorToken(["operator.read"]);
    const url = `ws://127.0.0.1:${gatewayHarness.port}`;
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

      // The owner chooses the real allocated port. This configured local port is
      // intentionally different; neither lookup nor persistence may key on it.
      const movedUrl = "ws://127.0.0.1:18999";
      const moved = { gateway: { ...config.gateway, remote: { ...remote, url: movedUrl } } };
      const { gatewayProbe: result } = await resolveGatewayProbeSnapshot({
        cfg: moved,
        configPath: statePath("openclaw.json"),
        env: { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR },
        opts: { ...createStatusGatewayProbeBudget(10_000), detailLevel: "full" },
      });
      expect(result?.error).toBeNull();
      expect(result?.ok).toBe(true);
      expect(result?.auth.capability).toBe("read_only");
      expectRecord(result?.status, "SSH route paired read without shared credentials");

      // The fixture server would accept A's token even on this second route;
      // rejecting anonymously proves B did not inherit A's valid bearer.
      const { gatewayProbe: foreign } = await resolveGatewayProbeSnapshot({
        cfg: {
          gateway: { ...config.gateway, remote: { ...remote, sshTarget: "fixture@gateway-b" } },
        },
        configPath: statePath("openclaw.json"),
        env: { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR },
        opts: { ...createStatusGatewayProbeBudget(10_000), detailLevel: "full" },
      });
      expect(foreign?.ok).toBe(false);
      expect(foreign?.connectErrorDetails).toMatchObject({
        code: ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED,
      });
    } finally {
      // The suite shares its Gateway. Return this case's pairing and caches to
      // their empty baseline before the first-time diagnostic case runs.
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
    const token = requireGatewayToken();

    const status = await callGateway({
      url: `ws://127.0.0.1:${gatewayHarness.port}`,
      token,
      method: "status",
      timeoutMs: 5_000,
    });

    expectRecord(status, "status response");
  });

  it("keeps first-time local authenticated probes non-mutating", async () => {
    const token = requireGatewayToken();

    const result = await probeGateway({
      url: `ws://127.0.0.1:${gatewayHarness.port}`,
      auth: { token },
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    expect(result.health).toBeNull();
    expect(result.status).toBeNull();
    expect(result.configSnapshot).toBeNull();
    expect(result.auth.capability).toBe("connected_no_operator_scope");
    const pairing = await listDevicePairing();
    expect(pairing.paired).toEqual([]);
    expect(pairing.pending).toEqual([]);
    expect(fs.existsSync(statePath("identity", "device-auth.json"))).toBe(false);
  });

  it("keeps paired local reads and restores remote loopback reads with explicit credentials", async () => {
    const token = requireGatewayToken();
    const localAuth = await seedCachedOperatorToken(["operator.read"]);
    const result = await probeGateway({
      url: `ws://127.0.0.1:${gatewayHarness.port}`,
      auth: { token },
      timeoutMs: 10_000,
    });

    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.auth.capability).toBe("read_only");
    expectRecord(result.health, "probe health");
    expectRecord(result.status, "probe status");
    expectRecord(result.configSnapshot, "probe config snapshot");

    const url = `ws://127.0.0.1:${gatewayHarness.port}`;
    const paired = await probeGateway({ url, timeoutMs: 10_000 });
    expect(paired.ok).toBe(true);
    expect(paired.auth.capability).toBe("read_only");
    const remote = await resolveGatewayProbeSnapshot({
      cfg: { gateway: { mode: "remote", remote: { url } } },
      configPath: statePath("openclaw.json"),
      env: { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR },
      opts: { ...createStatusGatewayProbeBudget(10_000), detailLevel: "full" },
    });
    expect(remote.gatewayProbe?.ok).toBe(false);

    const recovered = await resolveGatewayProbeSnapshot({
      cfg: { gateway: { mode: "remote", remote: { url, token } } },
      configPath: statePath("openclaw.json"),
      env: { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR },
      opts: { ...createStatusGatewayProbeBudget(10_000), detailLevel: "full" },
    });
    expect(recovered.gatewayProbe?.error).toBeNull();
    expect(recovered.gatewayProbe?.ok).toBe(true);
    expect(recovered.gatewayProbe?.auth.capability).toBe("read_only");
    expectRecord(recovered.gatewayProbe?.health, "remote probe health");
    expectRecord(recovered.gatewayProbe?.status, "remote probe status");
    expectRecord(recovered.gatewayProbe?.configSnapshot, "remote probe config snapshot");

    // A retired SSH tunnel can leave another Gateway's token at the local URL.
    seedOriginDeviceToken({
      ...localAuth,
      gatewayScope: url,
      token: "retired-tunnel-device-token",
    });
    const unbound = await probeGateway({ url, timeoutMs: 10_000 });
    expect(unbound.ok).toBe(false);
    expect(unbound.connectErrorDetails).toMatchObject({
      code: ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED,
    });

    const explicit = await probeGateway({ url, auth: { token }, timeoutMs: 10_000 });
    expect(explicit.error).toBeNull();
    expect(explicit.ok).toBe(true);
    expectRecord(explicit.status, "explicit local auth with stale origin cache");

    seedDeviceAuthToken(localAuth);
    const local = await probeGateway({ url, timeoutMs: 10_000 });
    expect(local.error).toBeNull();
    expect(local.ok).toBe(true);
    expect(local.auth.capability).toBe("read_only");
    expectRecord(local.health, "local probe health after tunnel");
    expectRecord(local.status, "local probe status after tunnel");
    expectRecord(local.configSnapshot, "local probe config after tunnel");
  });

  it("keeps a locally verified origin token when the client cache changes", async () => {
    const localAuth = await seedCachedOperatorToken(["operator.read"]);
    await deviceAuthStore.clearDeviceAuthToken({
      deviceId: localAuth.deviceId,
      role: "operator",
    });
    const url = `ws://127.0.0.1:${gatewayHarness.port}`;
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
      const result = await probeGateway({ url, timeoutMs: 10_000 });
      expect(result.error).toBeNull();
      expect(result.ok).toBe(true);
      expectRecord(result.status, "status after origin cache replacement");
    } finally {
      read.mockRestore();
    }
  });
});
