// Real CLI scope selection, Gateway handlers, and token storage with in-process transport.
// Authentication mode is supplied by the fixture; device scope grants use the real verifier.
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../config/config.js";
import type { GatewayClientOptions } from "../gateway/client.js";
import { authorizeOperatorScopesForMethod } from "../gateway/method-scopes.js";
import { deviceHandlers } from "../gateway/server-methods/devices.js";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import {
  revokeDeviceToken,
  rotateDeviceToken,
  verifyDeviceToken,
} from "../infra/device-pairing-tokens.js";
import {
  getPairedDevice,
  getPendingDevicePairing,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import type { GatewayLockIdentity } from "../infra/gateway-lock.js";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { registerDevicesCli } from "./devices-cli.js";

const transport = vi.hoisted(() => ({
  request:
    vi.fn<
      (scopes: string[], method: string, params: Record<string, unknown>) => Promise<unknown>
    >(),
  runtime: { log: vi.fn(), error: vi.fn(), writeJson: vi.fn(), exit: vi.fn() },
  activeOwner: vi.fn<() => Promise<GatewayLockIdentity | undefined>>(),
}));

vi.mock("../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/gateway-lock.js")>()),
  readActiveGatewayLockIdentity: transport.activeOwner,
}));

vi.mock("../config/gateway-dispatch-config.js", () => ({
  readGatewayDispatchConfig: () => ({ gateway: { auth: { mode: "none" } } }),
  readGatewayDispatchConfigWithShellEnvFallback: async () => ({
    gateway: { auth: { mode: "none" } },
  }),
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: transport.runtime,
}));

vi.mock("../gateway/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/client.js")>()),
  GatewayClient: class {
    constructor(private readonly options: GatewayClientOptions) {}
    start() {
      this.options.onHelloOk?.({
        type: "hello-ok",
        protocol: 1,
        server: { version: "test", connId: "test-connection" },
        features: { methods: Object.keys(deviceHandlers), events: [] },
        snapshot: {
          presence: [],
          health: {},
          stateVersion: { presence: 0, health: 0 },
          uptimeMs: 0,
        },
        auth: { role: "operator", scopes: this.options.scopes ?? [] },
        policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 1 },
      });
    }
    async request(method: string, params: Record<string, unknown>) {
      return await transport.request(this.options.scopes ?? [], method, params);
    }
    async stopAndWait() {}
  },
}));

const roots = createSuiteTempRootTracker({ prefix: "openclaw-devices-cli-scopes-" });
const targetDeviceId = "device-1";
const warn = vi.fn();

beforeAll(async () => {
  await roots.setup();
});
beforeEach(async () => {
  vi.clearAllMocks();
  transport.activeOwner.mockResolvedValue(undefined);
  vi.stubEnv("OPENCLAW_STATE_DIR", await roots.make());
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await roots.cleanup();
});

async function pairOperator(deviceId: string, scopes: string[], tokenScopes = scopes) {
  const pending = await requestDevicePairing({
    deviceId,
    publicKey: `public-${deviceId}`,
    role: "operator",
    scopes,
  });
  const approved = await approveDevicePairing(pending.request.requestId, {
    callerScopes: ["operator.admin"],
  });
  expect(approved?.status).toBe("approved");
  const rotated = await rotateDeviceToken({ deviceId, role: "operator", scopes: tokenScopes });
  expect(rotated.ok).toBe(true);
}

async function installTransport(callerDeviceId?: string) {
  const caller = callerDeviceId ? await getPairedDevice(callerDeviceId) : null;
  const callerToken = caller?.tokens?.operator?.token;
  transport.request.mockImplementation(
    async (scopes: string[], method: string, params: Record<string, unknown>) => {
      if (callerDeviceId) {
        const verified = await verifyDeviceToken({
          deviceId: callerDeviceId,
          role: "operator",
          scopes,
          token: expectDefined(callerToken, "expected paired caller token"),
        });
        if (!verified.ok) {
          throw new Error(`device auth denied: ${verified.reason}`);
        }
      }
      const methodAuth = authorizeOperatorScopesForMethod(method, scopes, params);
      if (!methodAuth.allowed) {
        throw new Error(`missing scope: ${methodAuth.missingScope}`);
      }
      const handler = expectDefined(deviceHandlers[method], "expected real device handler");
      const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
      await handler({
        req: { type: "req", id: "scope-test", method, params },
        params,
        respond,
        client: {
          isDeviceTokenAuth: Boolean(callerDeviceId),
          connect: { scopes, device: callerDeviceId ? { id: callerDeviceId } : undefined },
        },
        context: { logGateway: { info: vi.fn(), warn }, broadcast: vi.fn() },
      } as unknown as GatewayRequestHandlerOptions);
      expect(respond).toHaveBeenCalledOnce();
      const [ok, result, error] = expectDefined(respond.mock.calls[0], "expected Gateway response");
      if (!ok) {
        throw new Error(expectDefined(error, "expected Gateway denial").message);
      }
      return result;
    },
  );
}

async function runTokenCommand(command: string, scopes?: string[]) {
  const program = new Command();
  registerDevicesCli(program);
  const argv = [
    "devices",
    command,
    "--device",
    ` ${targetDeviceId} `,
    "--role",
    " operator ",
    "--json",
  ];
  for (const scope of scopes ?? []) {
    argv.push("--scope", scope);
  }
  await program.parseAsync(argv, { from: "user" });
}

it.each([
  {
    command: "rotate",
    caller: "self",
    scopes: ["operator.pairing", "operator.write"],
    requested: undefined,
    connection: ["operator.pairing", "operator.read", "operator.write"],
  },
  {
    command: "revoke",
    caller: "self",
    scopes: ["operator.pairing", "operator.read"],
    requested: undefined,
    connection: ["operator.pairing", "operator.read"],
  },
  {
    command: "rotate",
    caller: "admin-cross-device",
    scopes: ["operator.admin"],
    requested: ["operator.read"],
    connection: ["operator.admin"],
  },
  {
    command: "rotate",
    caller: "shared",
    scopes: ["operator.pairing", "operator.write"],
    requested: ["operator.admin"],
    connection: ["operator.admin"],
  },
])(
  "$command with $caller authority preserves the approval ceiling",
  async ({ command, caller, scopes, requested, connection }) => {
    await pairOperator(targetDeviceId, ["operator.admin"], scopes);
    if (caller === "admin-cross-device") {
      await pairOperator("caller", ["operator.admin"]);
    }
    await installTransport(
      caller === "self" ? targetDeviceId : caller === "admin-cross-device" ? "caller" : undefined,
    );
    const before = expectDefined(await getPairedDevice(targetDeviceId), "paired target");
    await runTokenCommand(command, requested);
    const after = expectDefined(await getPairedDevice(targetDeviceId), "retained target");
    expect(after.approvedScopes).toEqual(before.approvedScopes);
    expect(after.tokens?.operator?.scopes).toEqual(normalizeDeviceAuthScopes(requested ?? scopes));
    if (command === "rotate") {
      expect(after.tokens?.operator?.token !== before.tokens?.operator?.token).toBe(true);
      expect(after.tokens?.operator?.revokedAtMs).toBeUndefined();
    } else {
      expect(after.tokens?.operator?.revokedAtMs).toEqual(expect.any(Number));
    }
    expect(
      transport.request.mock.calls.map(([grant, method]) => ({ requested: grant, method })),
    ).toEqual([
      { requested: ["operator.pairing"], method: "device.pair.list" },
      { requested: connection, method: `device.token.${command}` },
    ]);
    expect(transport.runtime.writeJson).toHaveBeenCalledOnce();
    const [output] = expectDefined(transport.runtime.writeJson.mock.calls[0], "CLI output");
    expect(typeof output.token === "string").toBe(command === "rotate" && caller === "self");
    expect(warn).not.toHaveBeenCalled();
  },
);

it("rotates a revoked target using its narrowed scopes", async () => {
  await pairOperator(targetDeviceId, ["operator.admin"], ["operator.read"]);
  expect((await revokeDeviceToken({ deviceId: targetDeviceId, role: "operator" })).ok).toBe(true);
  await installTransport();
  await runTokenCommand("rotate");
  expect(transport.request.mock.calls.at(-1)?.[0]).toEqual(["operator.pairing", "operator.read"]);
  const after = await getPairedDevice(targetDeviceId);
  expect(after?.tokens?.operator?.scopes).toEqual(["operator.read"]);
  expect(after?.tokens?.operator?.revokedAtMs).toBeUndefined();
});

it("rechecks target scopes before revoking after the list changes", async () => {
  await pairOperator(targetDeviceId, ["operator.admin"], ["operator.read"]);
  await installTransport();
  const dispatch = expectDefined(transport.request.getMockImplementation(), "installed transport");
  let replacementToken: string | undefined;
  transport.request.mockImplementation(async (...args) => {
    const result = await dispatch(...args);
    if (args[1] === "device.pair.list") {
      const replacement = await rotateDeviceToken({
        deviceId: targetDeviceId,
        role: "operator",
        scopes: ["operator.admin"],
      });
      expect(replacement.ok).toBe(true);
      if (replacement.ok) {
        replacementToken = replacement.entry.token;
      }
    }
    return result;
  });
  await expect(runTokenCommand("revoke")).rejects.toThrow("device token revocation denied");
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("caller-missing-scope scope=operator.admin"),
  );
  const after = await getPairedDevice(targetDeviceId);
  expect(after?.tokens?.operator?.token === replacementToken).toBe(true);
  expect(after?.tokens?.operator?.revokedAtMs).toBeUndefined();
  expect(transport.runtime.writeJson).not.toHaveBeenCalled();
});

it("does not attempt rotation when listing fails", async () => {
  transport.request.mockRejectedValue(new Error("pairing list unavailable"));
  await expect(runTokenCommand("rotate", ["operator.read"])).rejects.toThrow(
    "pairing list unavailable",
  );
  expect(transport.request.mock.calls.map(([, method]) => method)).toEqual(["device.pair.list"]);
  expect(transport.runtime.writeJson).not.toHaveBeenCalled();
});

it.each(["live", "offline", "uncertain"] as const)(
  "approval fallback preserves %s Gateway ownership",
  async (mode) => {
    const pending = await requestDevicePairing({
      deviceId: "bootstrap-device",
      publicKey: "bootstrap-public-key",
      role: "operator",
      scopes: ["operator.read"],
    });
    const requestId = pending.request.requestId;
    // Discovery is the external-process seam; admission and SQLite writes are real.
    transport.activeOwner.mockResolvedValue(
      mode === "live"
        ? {
            pid: process.pid + 1,
            port: 18789,
            ownerId: "external-gateway",
            createdAt: "2026-10-09T00:00:00.000Z",
          }
        : undefined,
    );
    transport.request.mockRejectedValue(
      mode === "live"
        ? new Error(`device pairing required (requestId: ${requestId})`)
        : new GatewayTransportError({
            kind: "closed",
            connectionDetails: {
              url: "ws://127.0.0.1:18789",
              urlSource: "local loopback",
              message: "",
            },
            message: "Gateway not reachable",
            ...(mode === "uncertain" ? { requestDispatched: true } : {}),
          }),
    );
    const program = new Command();
    registerDevicesCli(program);
    const approval = program.parseAsync(["devices", "approve", requestId, "--json"], {
      from: "user",
    });
    if (mode === "offline") {
      await approval;
      expect(await getPendingDevicePairing(requestId)).toBeNull();
      expect(await getPairedDevice("bootstrap-device")).toMatchObject({
        scopes: ["operator.read"],
      });
      expect(transport.runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({ requestId }),
      );
    } else {
      await expect(approval).rejects.toThrow(
        mode === "live" ? "stop the Gateway" : "Gateway not reachable",
      );
      expect(await getPendingDevicePairing(requestId)).toMatchObject({
        deviceId: "bootstrap-device",
      });
      expect(await getPairedDevice("bootstrap-device")).toBeNull();
      expect(transport.runtime.writeJson).not.toHaveBeenCalled();
    }
  },
);
