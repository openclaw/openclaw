import { once } from "node:events";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import { waitForGatewayStartup } from "../../test/helpers/gateway-startup.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigFile } from "../config/config.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import * as sessionChangeEvent from "./server-methods/session-change-event.js";
import * as gateway from "./server.auth.test-helpers.js";
import * as placementDispatch from "./worker-environments/placement-dispatch.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";

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
  roles?: NonNullable<OpenClawConfig["gateway"]>["roles"],
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
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1"],
      controlUi: { allowedOrigins: [origin] },
      ...(roles ? { roles } : {}),
    },
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
    const admin = "admin@example.invalid";
    await configureWriters({ [email]: writerScopes, [admin]: ["operator.admin"] }, required);
    await gateway.withGatewayServer(async ({ port }) => {
      await waitForGatewayStartup(port);
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
      using administrator = await connectWriter(port, admin, ["operator.admin"]);
      const adminRoster = await gateway.rpcReq<{
        sessionPlacement: { hasDispatchableCloudProfile?: true };
      }>(administrator.ws, "agents.list", { includeSessionPlacement: true });
      expect(adminRoster.ok).toBe(true);
      expect(adminRoster.payload?.sessionPlacement.hasDispatchableCloudProfile).toBe(
        required || undefined,
      );
      const ordinary = await gateway.rpcReq(ws, "agents.list", {});
      expect(ordinary.ok).toBe(true);
      expect(ordinary.payload).not.toHaveProperty("sessionPlacement");
    });
  },
);

test.for(["before acknowledgment", "after acknowledgment"] as const)(
  "required placement survives disconnect and role revocation %s but stops setup when its worker policy changes",
  async (timing, { signal }) => {
    const afterAcknowledgment = timing === "after acknowledgment";
    const admin = "admin@example.invalid";
    const writers = {
      disconnect: "disconnect@example.invalid",
      scope: "scope@example.invalid",
      role: "role@example.invalid",
      profile: "profile@example.invalid",
    };
    await configureWriters(
      {
        [admin]: ["operator.admin"],
        ...Object.fromEntries(Object.values(writers).map((email) => [email, writerScopes])),
      },
      true,
      {
        default: "owner",
        definitions: {
          owner: {
            agents: ["main"],
            scopes: ["operator.admin"],
            sessions: { others: "write" },
          },
          denied: { agents: [], scopes: [], sessions: { others: "none" } },
        },
      },
    );

    // Observe real provider setup, never replace it.
    const setupCalls: string[] = [];
    const dispatchErrors: string[] = [];
    let dispatchSettled: Promise<unknown> | undefined;
    let terminalPlacement: Promise<WorkerSessionPlacementRecord | undefined> | undefined;
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
          const { sessionId } = args[0];
          dispatchSettled = operation.catch((error: unknown) => {
            dispatchErrors.push(
              error instanceof Error ? (error.stack ?? error.message) : String(error),
            );
          });
          terminalPlacement = dispatchSettled.then(() => options.placements.getAsync(sessionId));
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
      await waitForGatewayStartup(port);
      using adminConnection = await connectWriter(port, admin, ["operator.admin"]);
      const adminWs = adminConnection.ws;
      // Exclude lazy handler loading from the disconnect/placement ordering check.
      const [{ coreGatewayHandlers }, { prepareGatewayRequestHandler }] = await Promise.all([
        import("./server-methods/core-handlers.js"),
        import("./server-methods/lazy-core-handlers.js"),
      ]);
      await prepareGatewayRequestHandler(coreGatewayHandlers["sessions.create"]!);
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
        terminalReason: RegExp,
        expectedSetupCalls: string[] = [],
        afterAck = afterAcknowledgment,
      ) => {
        setupCalls.length = 0;
        dispatchErrors.length = 0;
        terminalPlacement = undefined;
        const { ws } = await connectWriter(port, email);
        const committed = createDeferredCore();
        const resume = createDeferredCore();
        hold = { committed, resume: resume.promise, afterAck };
        settled = { remaining: 2, done: createDeferredCore() };
        const sessionKey = `agent:main:required-source-${timing.replaceAll(" ", "-")}-${email.split("@")[0]}`;
        // This RPC is held across the placement boundary. Test cancellation owns its deadline,
        // so a cold sessions.create cannot be mistaken for a disconnect.
        const created = gateway
          .rpcReq(ws, "sessions.create", { key: sessionKey }, signal)
          .catch((error: unknown) => {
            throw new Error(`${email}: sessions.create failed: ${String(error)}`, { cause: error });
          });
        void created.catch(() => {});
        let phase = "waiting for requested placement";
        try {
          if (afterAck) {
            const response = await created;
            expect(response, JSON.stringify(response.error)).toMatchObject({ ok: true });
            // Release dispatch in finally even if the expected pause never arrives.
            await withinTest(committed.promise, signal);
            const published = await gateway.rpcReq<{
              sessions: Array<{ key: string }>;
            }>(adminWs, "sessions.list", {});
            expect(published.ok, JSON.stringify(published.error)).toBe(true);
            expect(published.payload?.sessions.some((session) => session.key === sessionKey)).toBe(
              true,
            );
          } else {
            await awaitGateBeforeSettlement(
              committed.promise,
              created,
              "sessions.create settled before its requested placement committed",
            );
          }
          phase = "ending source authority";
          await endAuthority(ws);
        } catch (error) {
          throw new Error(`${email}: ${phase}: ${String(error)}`, {
            cause: error,
          });
        } finally {
          resume.resolve();
          await dispatchSettled;
        }
        await withinTest(settled.done.promise, signal);
        expect(await withinTest(Promise.resolve(terminalPlacement), signal)).toMatchObject({
          sessionKey,
          state: "failed",
          terminalReason: expect.stringMatching(terminalReason),
        });
        expect(setupCalls, dispatchErrors.join("; ")).toEqual(expectedSetupCalls);
        if (expectedSetupCalls.length > 0) {
          expect(dispatchErrors.at(-1)).toContain(
            "device worker is not a paired node host: paired",
          );
        }
        return { ws, created };
      };
      // Detached setup keeps accepted custody after RPC acknowledgment and disconnect.
      const disconnected = await createThenEndAuthority(
        writers.disconnect,
        async (ws) => {
          const closed = once(ws, "close");
          ws.close();
          await closed;
        },
        /device worker is not a paired node host: paired/,
        ["prepareProjectIntent", "createWithRequest"],
      );
      if (afterAcknowledgment) {
        expect((await disconnected.created).ok).toBe(true);
      } else {
        await expect(disconnected.created).rejects.toThrow(/closed/);
      }

      // A role revoked after the placement committed applies to the next request.
      const reassigned = await createThenEndAuthority(
        writers.role,
        async (ws) => {
          const self = await gateway.rpcReq<{ profile: { id: string } }>(ws, "users.self", {});
          expect(self.ok, JSON.stringify(self.error)).toBe(true);
          for (const role of ["denied", null]) {
            const changed = await gateway.rpcReq(adminWs, "users.setRole", {
              profileId: self.payload?.profile.id,
              role,
            });
            expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
          }
        },
        /device worker is not a paired node host: paired/,
        ["prepareProjectIntent", "createWithRequest"],
      );
      if (!afterAcknowledgment) {
        await expect(reassigned.created).rejects.toThrow(/closed|policy changed|role changed/);
      }

      const unprofiled = await createThenEndAuthority(
        writers.profile,
        async () => {
          await commitConfigPatch({
            raw: JSON.stringify({ cloudWorkers: { requiredProfile: null } }),
          });
        },
        /required worker policy changed/i,
      );
      expect((await unprofiled.created).ok).toBe(true);
      expect(unprofiled.ws.readyState).toBe(WebSocket.OPEN);
      unprofiled.ws.close();
    });
  },
);
