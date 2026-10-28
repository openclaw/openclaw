import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  GatewayClient,
  GatewayClientRequestTimeoutError,
} from "../../packages/gateway-client/src/client.js";
import {
  GatewayProtocolClient,
  type GatewayProtocolSocket,
  type GatewayProtocolSocketHandlers,
} from "../../packages/gateway-client/src/protocol-client.js";
import type { RequestFrame } from "../../packages/gateway-protocol/src/schema/frames.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { authorizationClient } from "./server-methods.authorization.test-support.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

const methods = ["sessions.create", "agent", "chat.send", "sessions.send"] as const;

const fixtures: Array<{ dispose(): Promise<void> }> = [];
const tempDirs = createTempDirTracker();

function createFixture(method: (typeof methods)[number]) {
  const reachedAdmission = createDeferred();
  const connection = new AbortController();
  const preparation = createDeferred();
  const refusal = createAgentDatabaseInspectionRefusal({
    agentId: "main",
    paths: [],
    reason: "Synthetic startup inspection is pending.",
    pending: true,
  });
  recordAgentDatabaseAdmissions([refusal], { source: "startup" });
  const startup = {
    hasPendingAgents: true,
    waitForAgentPreparation: () => {
      reachedAdmission.resolve();
      return startup.hasPendingAgents ? preparation.promise : undefined;
    },
  };
  const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
  const context = {
    getRuntimeConfig: () => cfg,
    logGateway: { warn: vi.fn(), info: vi.fn() },
    agentDatabaseStartup: startup,
  };
  const writes: RequestFrame[] = [];
  const client = new GatewayClient({});
  let handlers: GatewayProtocolSocketHandlers | undefined;
  const protocol = new GatewayProtocolClient({
    createSocket: (next) => {
      handlers = next;
      return socket;
    },
    createRequestId: () => "startup-request",
    createRequestTimeoutError: (requestMethod, timeoutMs, requestSent) =>
      new GatewayClientRequestTimeoutError({ method: requestMethod, timeoutMs, requestSent }),
    buildConnectPlan: () => ({}),
    buildConnectParams: (plan) => plan,
    resolveClose: () => ({ retry: false, notify: false }),
    handshake: { mode: "require-challenge", timeoutMs: 100 },
    reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
  });
  const sent: string[] = [];
  const active: Promise<void>[] = [];
  const errors: unknown[] = [];
  const socket: GatewayProtocolSocket = {
    isOpen: () => true,
    close: () => {},
    send: (raw) => {
      const req = JSON.parse(raw) as RequestFrame;
      if (req.method === "connect") {
        handlers?.message(
          JSON.stringify({ type: "res", id: req.id, ok: true, payload: { type: "hello-ok" } }),
        );
        return;
      }
      sent.push(raw);
      active.push(
        handleGatewayRequest({
          req,
          client: authorizationClient(
            "startup-deadline",
            ["operator.admin"],
            { connectionSignal: connection.signal },
            { client: { id: "cli", version: "test", platform: "linux", mode: "cli" } },
          ),
          signal: connection.signal,
          isWebchatConnect: () => false,
          context: context as unknown as GatewayRequestContext,
          extraHandlers: {
            [method]: ({ req: written, respond }) => {
              writes.push(written);
              respond(true, { status: "written" });
            },
          },
          respond: (ok, payload, error) => {
            reachedAdmission.resolve();
            handlers?.message(JSON.stringify({ type: "res", id: req.id, ok, payload, error }));
          },
        }).catch((error: unknown) => {
          errors.push(error);
        }),
      );
    },
  };
  Object.assign(client, { protocol });
  protocol.start();
  void Promise.resolve().then(() => {
    handlers?.open();
    handlers?.message(
      JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "fixture" } }),
    );
  });
  const fixture = {
    client,
    sent,
    writes,
    reachedAdmission: reachedAdmission.promise,
    params: {
      agentId: "main",
      message: "Synthetic request",
      idempotencyKey: "startup-write",
      ...(method === "chat.send" ? { sessionKey: "agent:main:test" } : {}),
      ...(method === "sessions.send" ? { key: "agent:main:test" } : {}),
    },
    ready() {
      startup.hasPendingAgents = false;
      recordAgentDatabaseAdmissions([], { source: "startup" });
      preparation.resolve();
    },
    async drain() {
      await Promise.all(active);
      if (errors.length > 0) {
        throw new AggregateError(errors, "Synthetic Gateway request failed");
      }
    },
    async dispose() {
      client.stop();
      connection.abort();
      fixture.ready();
      await Promise.allSettled(active);
    },
  };
  fixtures.push(fixture);
  return fixture;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("gateway-startup-deadline-"));
});

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  recordAgentDatabaseAdmissions([], { source: "startup" });
  vi.unstubAllEnvs();
  vi.useRealTimers();
  tempDirs.cleanup();
});

const scenarios = [
  ...["timeout", "abort"].flatMap((ending) => methods.map((method) => ({ method, ending }))),
  ...(["sessions.create", "agent"] as const).map((method) => ({ method, ending: "ready" })),
];
it.each(scenarios)("startup $method: $ending", async ({ method, ending }) => {
  const fixture = createFixture(method);
  const controller = new AbortController();
  const options =
    ending === "timeout"
      ? undefined
      : {
          timeoutMs: 60_000,
          ...(ending === "abort" ? { signal: controller.signal } : {}),
        };
  const outcome = fixture.client
    .request(method, fixture.params, options)
    .catch((error: unknown) => error);
  const settled = vi.fn();
  void outcome.then(settled);
  await fixture.reachedAdmission;
  await vi.advanceTimersByTimeAsync(
    ending === "timeout" ? 30_000 : ending === "abort" ? 35_000 : 45_000,
  );
  if (ending === "abort") {
    controller.abort();
    expect(await outcome).toMatchObject({ message: `gateway request aborted for ${method}` });
  } else {
    if (ending === "timeout") {
      expect(await outcome).toBeInstanceOf(GatewayClientRequestTimeoutError);
    } else {
      expect(settled).not.toHaveBeenCalled();
    }
    expect(fixture.writes).toHaveLength(0);
    if (ending === "timeout") {
      await vi.advanceTimersByTimeAsync(15_000);
    }
  }
  fixture.ready();
  if (ending === "ready") {
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toEqual({ status: "written" });
  }
  await fixture.drain();
  if (ending === "ready") {
    expect(fixture.writes).toMatchObject([{ params: { idempotencyKey: "startup-write" } }]);
    expect(fixture.sent.length).toBeGreaterThan(1);
    expect(new Set(fixture.sent).size).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.writes).toHaveLength(1);
  } else {
    await vi.advanceTimersByTimeAsync(ending === "abort" ? 30_000 : 1_000);
    expect(fixture.writes).toHaveLength(0);
  }
});
