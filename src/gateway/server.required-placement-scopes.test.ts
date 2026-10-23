import { once } from "node:events";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigFile } from "../config/config.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import * as sessionChangeEvent from "./server-methods/session-change-event.js";
import * as gateway from "./server.auth.test-helpers.js";
import * as placementDispatch from "./worker-environments/placement-dispatch.js";

gateway.installGatewayTestHooks({ scope: "suite" });
const temps = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const origin = "https://control.example.invalid";
const writerScopes: NonNullable<GatewayAuthConfig["identityScopes"]>[string] = [
  "operator.sessions.write",
];
async function configureWriters(
  identityScopes: NonNullable<GatewayAuthConfig["identityScopes"]>,
  required = true,
) {
  const dedicated = { provider: "device", settings: { device: "paired", inference: "worker" } };
  const auth: GatewayAuthConfig = {
    mode: "trusted-proxy",
    identityScopes,
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
      allowUsers: Object.keys(identityScopes),
    },
  };
  gateway.testState.gatewayAuth = auth;
  gateway.testState.gatewayControlUi = { allowedOrigins: [origin] };
  await writeConfigFile({
    gateway: { auth, trustedProxies: ["127.0.0.1"], controlUi: { allowedOrigins: [origin] } },
    ...(required
      ? { cloudWorkers: { requiredProfile: "dedicated", profiles: { dedicated } } }
      : {}),
  });
  if (required) {
    vi.stubEnv("OPENCLAW_TEST_MINIMAL_GATEWAY", "0");
  }
}

async function connectWriter(port: number, email: string, scopes = writerScopes) {
  const ws = await gateway.openWs(port, {
    origin,
    "x-forwarded-user": email,
    "x-forwarded-for": "203.0.113.50",
    "x-forwarded-proto": "https",
  });
  try {
    const connected = await gateway.connectReq(ws, {
      prePairDevice: true,
      client: gateway.CONTROL_UI_CLIENT,
      browserOrigin: origin,
      skipDefaultAuth: true,
      scopes,
      deviceIdentityPath: path.join(temps.make("policy-writer-"), "client", "credentials.sqlite"),
    });
    expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
    return { ws, connected, [Symbol.dispose]: () => ws.close() };
  } catch (error) {
    ws.close();
    throw error;
  }
}

test.each([false, true])(
  "session writers read only requested placement policy over authenticated RPC (required=%s)",
  async (required) => {
    const email = "writer@example.invalid";
    await configureWriters({ [email]: writerScopes }, required);
    await gateway.withGatewayServer(async ({ port }) => {
      using connection = await connectWriter(port, email);
      const { ws, connected } = connection;
      expect((connected.payload as HelloOk).auth.scopes).not.toContain("operator.write");
      const self = await gateway.rpcReq<{ profile: { id: string } }>(ws, "users.self", {});
      expect(self.ok, JSON.stringify(self.error)).toBe(true);
      expect(self.payload?.profile.id).toBeTruthy();
      for (const params of [{}, { runtimeId: "openclaw" }]) {
        const inventory = await gateway.rpcReq(ws, "environments.list", params);
        expect(inventory).toMatchObject({
          ok: false,
          error: { message: expect.stringMatching(/missing scope/) },
        });
      }
      const listed = await gateway.rpcReq<{ sessionPlacement: unknown }>(ws, "agents.list", {
        includeSessionPlacement: true,
      });
      expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
      expect(listed.payload?.sessionPlacement).toEqual(
        required
          ? {
              requiredProfile: {
                id: "dedicated",
                providerId: "device",
                executionModes: ["worker-turn"],
                inference: "worker",
              },
            }
          : {},
      );
      const ordinary = await gateway.rpcReq(ws, "agents.list", {});
      expect(ordinary.ok).toBe(true);
      expect(ordinary.payload).not.toHaveProperty("sessionPlacement");
    });
  },
);

test("required placement survives disconnect but stops setup when committed caller authority ends", async () => {
  const admin = "admin@example.invalid";
  const writers = {
    disconnect: "disconnect@example.invalid",
    scope: "scope@example.invalid",
    profile: "profile@example.invalid",
  };
  await configureWriters({
    [admin]: ["operator.admin"],
    ...Object.fromEntries(Object.values(writers).map((email) => [email, writerScopes])),
  });

  // Observe real provider setup, never replace it.
  const setupCalls: string[] = [];
  const dispatchErrors: string[] = [];
  let dispatchSettled: Promise<unknown> | undefined;
  let hold: { committed: Deferred; resume: Promise<void>; afterAck: boolean } | undefined;
  async function pauseRequested<T extends { state: string }>(placement: T, afterAck: boolean) {
    const current = hold;
    if (current?.afterAck === afterAck && placement.state === "requested") {
      hold = undefined;
      current.committed.resolve();
      await current.resume;
    }
    return placement;
  }
  const createDispatch = placementDispatch.createWorkerPlacementDispatchService;
  vi.spyOn(placementDispatch, "createWorkerPlacementDispatchService").mockImplementation(
    (options) => {
      const { prepareProjectIntent, createWithRequest } = options.environments;
      vi.spyOn(options.environments, "prepareProjectIntent").mockImplementation((...args) => {
        setupCalls.push("prepareProjectIntent");
        return prepareProjectIntent(...args);
      });
      vi.spyOn(options.environments, "createWithRequest").mockImplementation((...args) => {
        setupCalls.push("createWithRequest");
        return createWithRequest(...args);
      });
      const startDispatch = options.placements.startDispatch.bind(options.placements);
      vi.spyOn(options.placements, "startDispatch").mockImplementation(async (...args) =>
        pauseRequested(await startDispatch(...args), false),
      );
      const service = createDispatch({
        ...options,
        runLocalBarrier: async (params) =>
          pauseRequested(await options.runLocalBarrier(params), true),
      });
      const dispatch = service.dispatch;
      service.dispatch = (...args) => {
        const operation = dispatch(...args);
        dispatchSettled = operation.catch((error: unknown) => dispatchErrors.push(String(error)));
        return operation;
      };
      return service;
    },
  );
  // The requested acknowledgment and the failed dispatch's final transition each publish once.
  let settled: { remaining: number; done: Deferred } | undefined;
  const emitSessionsChanged = sessionChangeEvent.emitSessionsChanged;
  vi.spyOn(sessionChangeEvent, "emitSessionsChanged").mockImplementation((...args) => {
    if (args[1].reason === "dispatch" && settled && --settled.remaining === 0) {
      settled.done.resolve();
    }
    emitSessionsChanged(...args);
  });

  await gateway.withGatewayServer(async ({ port }) => {
    using adminConnection = await connectWriter(port, admin, ["operator.admin"]);
    const adminWs = adminConnection.ws;
    const commitConfigPatch = async (patch: Record<string, unknown>) => {
      const current = await gateway.rpcReq<{ hash: string }>(adminWs, "config.get", {});
      expect(current.ok, JSON.stringify(current.error)).toBe(true);
      const patched = await gateway.rpcReq(adminWs, "config.patch", {
        baseHash: current.payload?.hash,
        ...patch,
      });
      expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
    };
    const createThenEndAuthority = async (
      email: string,
      endAuthority: (ws: WebSocket) => Promise<void>,
      expectedSetupCalls: string[] = [],
      afterAck = false,
    ) => {
      setupCalls.length = 0;
      const { ws } = await connectWriter(port, email);
      const committed = createDeferredCore();
      const resume = createDeferredCore();
      hold = { committed, resume: resume.promise, afterAck };
      settled = { remaining: 2, done: createDeferredCore() };
      const created = gateway.rpcReq(ws, "sessions.create", {});
      void created.catch(() => {});
      try {
        if (afterAck) {
          expect(await created).toMatchObject({ ok: true });
          await committed.promise;
        } else {
          await Promise.race([
            committed.promise,
            created.then(() => {
              throw new Error("sessions.create settled before its requested placement committed");
            }),
          ]);
        }
        await endAuthority(ws);
      } finally {
        resume.resolve();
      }
      await settled.done.promise;
      await dispatchSettled;
      expect(setupCalls, dispatchErrors.join("; ")).toEqual(expectedSetupCalls);
      return { ws, created };
    };
    // Detached setup keeps accepted custody after RPC acknowledgment and disconnect.
    await createThenEndAuthority(
      writers.disconnect,
      async (ws) => {
        const closed = once(ws, "close");
        ws.close();
        await closed;
      },
      ["prepareProjectIntent", "createWithRequest"],
      true,
    );

    const revoked = await createThenEndAuthority(writers.scope, async () => {
      await commitConfigPatch({
        raw: JSON.stringify({ gateway: { auth: { identityScopes: { [writers.scope]: null } } } }),
        replacePaths: [`gateway.auth.identityScopes.${writers.scope}`],
      });
    });
    await expect(revoked.created).rejects.toThrow(/gateway policy changed/);

    const unprofiled = await createThenEndAuthority(writers.profile, async () => {
      await commitConfigPatch({
        raw: JSON.stringify({ cloudWorkers: { requiredProfile: null } }),
      });
    });
    await unprofiled.created;
    expect(unprofiled.ws.readyState).toBe(WebSocket.OPEN);
    unprofiled.ws.close();
  });
});
