/** Focused HTTP coverage for hook admission feedback and pending replay behavior. */
import fs from "node:fs/promises";
import { Agent, request as httpRequest, type IncomingMessage } from "node:http";
import path from "node:path";
import { afterEach, assert, describe, expect, test, vi, type TestContext } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { waitForGatewayStartup } from "../../test/helpers/gateway-startup.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { runEmbeddedAgent } from "../agents/embedded-agent-runner/run.js";
import { withFullRuntimeReplyConfig } from "../auto-reply/reply/get-reply-fast-path.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import * as sessionEventHandoff from "../auto-reply/reply/session-event-handoff.js";
import * as sessionEventTarget from "../auto-reply/reply/session-event-target.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions/main-session.runtime.js";
import { DEFAULT_WEBHOOK_MAX_BODY_BYTES } from "../infra/http-body.js";
import { peekSystemEventEntries } from "../infra/system-events.js";
import { refreshActiveProviderAuthRuntimeSnapshot } from "../secrets/runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import * as configReload from "./config-reload.js";
import {
  connectWebchatClient,
  createGatewaySuiteHarness,
  cronIsolatedRun,
  gatewayReplyMock,
  installGatewayTestHooks,
  rpcReq,
  testState,
  withGatewayServer,
} from "./test-helpers.js";

// mock-isolation: Both Gateway barrel instances share this inference boundary; admission stays real.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const hookModel = vi.mocked(runEmbeddedAgent);

installGatewayTestHooks({ scope: "suite" });

await import("./server.js");

const HOOK_TOKEN = "hook-secret";
const ROTATED_HOOK_TOKEN = "hook-secret-rotated";

const fixtureLifetime = createFixtureLifetime();
const enabledHooks = { enabled: true, token: HOOK_TOKEN };
type HookReceipt = ReturnType<typeof sessionEventHandoff.enqueueSessionEventForHost>;
const hookHeaders = (token = HOOK_TOKEN) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

function observeHookReceipts(
  onReceipt: (text: string, receipt: HookReceipt, source: string | undefined) => void,
) {
  const enqueue = sessionEventHandoff.enqueueSessionEventForHost;
  return vi
    .spyOn(sessionEventHandoff, "enqueueSessionEventForHost")
    .mockImplementation((text, options) => {
      const receipt = enqueue(text, options);
      onReceipt(text, receipt, options.source);
      return receipt;
    });
}

function withHookGateway(run: Parameters<typeof withGatewayServer>[0]) {
  testState.hooksConfig = { ...enabledHooks };
  return withGatewayServer((context) => {
    cronIsolatedRun.mockClear();
    return run(context);
  });
}

function postWake(port: number, text: string, key = text, token = HOOK_TOKEN) {
  return postHook(port, "/hooks/wake", { text }, key, token);
}

function postAgent(
  port: number,
  key: string,
  body: Record<string, unknown> = { message: "Dispatch" },
  token = HOOK_TOKEN,
) {
  return postHook(port, "/hooks/agent", body, key, token);
}

async function expectResponse(response: Response, status = 200) {
  expect(response.status, await response.clone().text()).toBe(status);
}

async function hookRunId(response: Response) {
  await expectResponse(response);
  return ((await response.json()) as { runId?: string }).runId;
}

function waitForGate(
  gate: Promise<void>,
  pending: Promise<unknown>,
  signal: AbortSignal,
  message: string,
) {
  return withinTest(awaitGateBeforeSettlement(gate, pending, message), signal);
}

function installHookReplyRuntime() {
  // Admission, native session creation, and reload authority remain real.
  gatewayReplyMock.mockImplementation((ctx, options, config) =>
    getReplyFromConfig(ctx, options, withFullRuntimeReplyConfig(config ?? getRuntimeConfig())),
  );
  return hookModel.mockReset().mockImplementation(async (params) => {
    assert(params.preparedRunAdmission, "expected ordinary reply admission");
    await params.preparedRunAdmission.admit("gateway", params.runId);
    params.onExecutionPhase?.({ phase: "model_call_started" });
    await params.onExecutionStarted?.();
    await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    return {
      payloads: [{ text: "Hook event observed" }],
      meta: {
        durationMs: 1,
        terminalReply: { disposition: "visible", text: "Hook event observed" },
      },
    };
  });
}

afterEach(async () => {
  await fixtureLifetime.cleanup();
  vi.restoreAllMocks();
});

async function postHook(
  port: number,
  hookPath: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
  token = HOOK_TOKEN,
): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}${hookPath}`, {
    method: "POST",
    headers: { ...hookHeaders(token), "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
  });
}

async function waitForCronIsolatedRuns(count: number): Promise<void> {
  await expect
    .poll(() => cronIsolatedRun.mock.calls.length, { timeout: 2_000, interval: 10 })
    .toBe(count);
}

async function writeReloadableHooksConfig(hooks: Record<string, unknown>): Promise<void> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  assert(configPath, "expected OPENCLAW_CONFIG_PATH");
  const config = {
    gateway: { reload: { mode: "hybrid" } },
    agents: {
      defaults: {
        skipBootstrap: true,
        model: { primary: "openai/gpt-5.6-luna" },
        models: { "openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://openai.example.test/v1",
          apiKey: "synthetic-fixture-key",
          models: [{ id: "gpt-5.6-luna", name: "Hook fixture model" }],
        },
      },
    },
    hooks,
  };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function patchHooksConfig(
  socket: Parameters<typeof rpcReq>[0],
  hooks: Record<string, unknown>,
): Promise<void> {
  const current = await rpcReq<{ hash: string }>(socket, "config.get", {});
  expect(current.ok, current.error?.message).toBe(true);
  const changed = await rpcReq(socket, "config.patch", {
    raw: JSON.stringify({ hooks }),
    baseHash: current.payload?.hash,
  });
  expect(changed.ok, changed.error?.message).toBe(true);
}

async function waitForHookStatus(params: {
  port: number;
  path: string;
  token: string;
  status: number;
}): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await fetch(`http://127.0.0.1:${params.port}${params.path}`, {
          method: "POST",
          headers: hookHeaders(params.token),
          body: "{}",
        });
        await response.arrayBuffer();
        return response.status;
      },
      { timeout: 5_000, interval: 50 },
    )
    .toBe(params.status);
}

async function postOversizedChunkedHook(port: number) {
  const agent = new Agent({ keepAlive: true });
  const events: string[] = [];
  const response = createDeferred<IncomingMessage>();
  const requestFailed = createDeferred<never>();
  const req = httpRequest(
    { agent, host: "127.0.0.1", port, path: "/hooks/wake", method: "POST", headers: hookHeaders() },
    response.resolve,
  );
  const socketClosed = new Promise<void>((resolve) => {
    req.once("socket", (socket) => socket.once("close", resolve));
  });
  req.on("error", requestFailed.reject);
  req.setTimeout(5_000, () => req.destroy(new Error("chunked hook request timed out")));
  try {
    return await Promise.race([
      requestFailed.promise,
      (async () => {
        req.write('{"text":"');
        req.write("x".repeat(DEFAULT_WEBHOOK_MAX_BODY_BYTES + 1));
        req.end('"}');
        const res = await response.promise;
        const chunks: Buffer[] = [];
        for await (const chunk of res) {
          chunks.push(chunk);
        }
        events.push("response-end");
        await socketClosed;
        events.push("socket-close");
        return {
          statusCode: res.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
          connection: res.headers.connection,
          events,
        };
      })(),
    ]);
  } finally {
    agent.destroy();
  }
}

async function createBlockedHookTransform(moduleName: string) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  assert(configPath, "expected OPENCLAW_CONFIG_PATH");
  const enteredEvent = `hook-transform:${configPath}:${moduleName}`;
  const entered = createDeferred();
  const released = createDeferred();
  const onEntered = (complete: () => void) => {
    entered.resolve();
    void released.promise.then(complete);
  };
  const transformsDir = path.join(path.dirname(configPath), "hooks", "transforms");
  await fs.mkdir(transformsDir, { recursive: true });
  await fs.writeFile(
    path.join(transformsDir, moduleName),
    `export default async function transform() {
  await new Promise((resolve) => process.emit(${JSON.stringify(enteredEvent)}, resolve));
  return {};
}`,
    "utf8",
  );
  process.once(enteredEvent, onEntered);
  return {
    entered: entered.promise,
    release: released.resolve,
    dispose: () => {
      process.removeListener(enteredEvent, onEntered);
    },
  };
}

function withRevokedHook(
  mode: "disable" | "rotate",
  { signal }: Pick<TestContext, "signal">,
  afterRotation?: (
    port: number,
    socket: Parameters<typeof rpcReq>[0],
    waitForEvent: (text: string) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  return fixtureLifetime.run(async () => {
    const moduleName = `${mode}-reload.mjs`;
    const transform = await createBlockedHookTransform(moduleName);
    try {
      await writeReloadableHooksConfig({
        enabled: true,
        token: HOOK_TOKEN,
        mappings: [
          {
            match: { path: "revoked" },
            action: "wake",
            textTemplate: "{{payload.text}}",
            transform: { module: moduleName },
          },
        ],
      });
      await withEnvAsync({ OPENCLAW_TEST_MINIMAL_GATEWAY: "0" }, async () => {
        const gateway = await createGatewaySuiteHarness();
        try {
          const { port, server } = gateway;
          await server.startupSettled;
          await waitForGatewayStartup(port);
          const socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
          const mainSessionKey = resolveMainSessionKeyFromConfig();
          const receipts = new Map<string, HookReceipt>();
          const eventObserver = observeHookReceipts((text, receipt, source) => {
            if (source === "hook") {
              receipts.set(text, receipt);
            }
          });
          const model = installHookReplyRuntime();
          const waitForEvent = async (text: string) => {
            const receipt = receipts.get(text);
            assert(receipt, `expected admitted hook occurrence: ${text}`);
            await expect(receipt.accepted).resolves.toEqual({ ok: true });
            const outcome = await receipt.settled;
            expect(outcome, JSON.stringify(outcome)).toMatchObject({
              status: "completed",
              executionStarted: true,
            });
            expect(model.mock.calls.some(([params]) => params.prompt.includes(text))).toBe(true);
          };
          try {
            await expectResponse(await postWake(port, "before-reload", "before"));
            await waitForEvent("before-reload");
            const revoked = postHook(port, "/hooks/revoked", { text: "after-reload" }, "revoked");
            let response: Response;
            try {
              await waitForGate(
                transform.entered,
                revoked,
                signal,
                "hook request settled before its transform entered",
              );
              await patchHooksConfig(
                socket,
                mode === "disable"
                  ? { enabled: false }
                  : { enabled: true, token: ROTATED_HOOK_TOKEN },
              );
              await waitForHookStatus({
                port,
                path: "/hooks/wake",
                token: HOOK_TOKEN,
                status: mode === "disable" ? 404 : 401,
              });
              if (mode === "rotate") {
                const control = await postHook(
                  port,
                  "/hooks/wake",
                  {},
                  "current-token-control",
                  ROTATED_HOOK_TOKEN,
                );
                expect(control.status).toBe(400);
              }
            } finally {
              await fixtureLifetime.verifyCleanup(async () => {
                transform.release();
                await revoked;
              });
              response = await revoked;
            }
            expect(response.status).toBe(409);
            await expect(response.json()).resolves.toEqual({
              ok: false,
              error: "hook configuration changed; retry request",
            });
            expect(
              peekSystemEventEntries(mainSessionKey).some((event) =>
                event.text.includes("after-reload"),
              ),
            ).toBe(false);
            expect(receipts.has("after-reload")).toBe(false);
            expect(
              model.mock.calls.some(([params]) => params.prompt.includes("after-reload")),
            ).toBe(false);
            await afterRotation?.(port, socket, waitForEvent);
          } finally {
            for (const receipt of receipts.values()) {
              receipt.cancel();
            }
            await Promise.allSettled([...receipts.values()].map((receipt) => receipt.settled));
            eventObserver.mockRestore();
            model.mockReset();
            gatewayReplyMock.mockReset();
            socket.close();
          }
        } finally {
          await fixtureLifetime.verifyCleanup(() => gateway.close());
        }
      });
    } finally {
      await fixtureLifetime.verifyCleanup(async () => transform.dispose());
    }
  });
}

describe("gateway hook admission", () => {
  test("joins the initial config reconcile before accepting the first hook", async ({ signal }) => {
    const entered = createDeferred();
    const release = createDeferred();
    let ready = false;
    const startReloader = configReload.startGatewayConfigReloader;
    vi.spyOn(configReload, "startGatewayConfigReloader").mockImplementation((options) => {
      let initial = true;
      const reloader = startReloader({
        ...options,
        readSnapshot: async (...args) => {
          if (initial) {
            initial = false;
            entered.resolve();
            await release.promise;
          }
          return options.readSnapshot(...args);
        },
      });
      void reloader.ready.then(() => {
        ready = true;
      });
      return reloader;
    });
    await writeReloadableHooksConfig(enabledHooks);
    await withEnvAsync({ OPENCLAW_TEST_MINIMAL_GATEWAY: "0" }, async () => {
      installHookReplyRuntime();
      const admitted = createDeferred<HookReceipt>();
      observeHookReceipts((_text, receipt) => admitted.resolve(receipt));
      const request = withGatewayServer(async ({ port, server }) => {
        await server.startupSettled;
        await waitForGatewayStartup(port);
        await expectResponse(await postWake(port, "first-hook", "first"));
        await expect((await admitted.promise).settled).resolves.toMatchObject({
          status: "completed",
        });
      });
      try {
        await waitForGate(entered.promise, request, signal, "Gateway skipped initial reconcile");
        expect(ready, "config reloader became ready during its initial reconcile").toBe(false);
        // Change source identity without changing runtime values: startup must
        // finish this no-op publication before the hook captures its authority.
        await fs.appendFile(process.env.OPENCLAW_CONFIG_PATH!, "\n", "utf8");
      } finally {
        release.resolve();
        await request;
      }
    });
  });

  test("keeps pending hook admission current through a same-value provider-auth refresh", async ({
    signal,
  }) => {
    await writeReloadableHooksConfig(enabledHooks);
    await withEnvAsync({ OPENCLAW_TEST_MINIMAL_GATEWAY: "0" }, async () => {
      installHookReplyRuntime();
      const entered = createDeferred();
      const release = createDeferred();
      const admitted = createDeferred<HookReceipt>();
      const prepare = sessionEventTarget.prepareSessionEventTargetForHost;
      vi.spyOn(sessionEventTarget, "prepareSessionEventTargetForHost").mockImplementationOnce(
        async (...args) => {
          entered.resolve();
          await release.promise;
          return prepare(...args);
        },
      );
      observeHookReceipts((_text, receipt) => admitted.resolve(receipt));
      await withGatewayServer(async ({ port, server }) => {
        await server.startupSettled;
        await waitForGatewayStartup(port);
        const request = postWake(port, "refresh-during-admission", "refresh");
        let response: Response;
        try {
          await waitForGate(entered.promise, request, signal, "hook skipped admission gate");
          expect(await refreshActiveProviderAuthRuntimeSnapshot()).toBe(true);
        } finally {
          release.resolve();
          response = await request;
        }
        await expectResponse(response);
        await expect((await admitted.promise).settled).resolves.toMatchObject({
          status: "completed",
        });
      });
    });
  });

  test("flushes an oversized chunked hook response before closing the socket", async () => {
    await withHookGateway(async ({ port }) => {
      const response = await postOversizedChunkedHook(port);

      expect(response).toEqual({
        statusCode: 413,
        body: JSON.stringify({ ok: false, error: "payload too large" }),
        connection: "close",
        events: ["response-end", "socket-close"],
      });
    });
  });

  test("revokes in-flight hook authority when startup-enabled hooks are disabled", async (context) => {
    await withRevokedHook("disable", context);
  });

  test("rotates hook credentials and preserves replay across production hot reloads", async (context) => {
    await withRevokedHook("rotate", context, async (port, socket, waitForEvent) => {
      await expectResponse(
        await postWake(
          port,
          "current-after-rotation",
          "current-after-rotation",
          ROTATED_HOOK_TOKEN,
        ),
      );
      await waitForEvent("current-after-rotation");
      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockImplementation(async (params: unknown) => {
        (params as { onExecutionStarted?: () => void }).onExecutionStarted?.();
        return { status: "ok", summary: "done" };
      });
      const replayKey = "production-reload-replay";
      const message = { message: "replay across reload" };
      const firstRunId = await hookRunId(
        await postAgent(port, replayKey, message, ROTATED_HOOK_TOKEN),
      );
      await waitForCronIsolatedRuns(1);

      await patchHooksConfig(socket, {
        enabled: true,
        token: ROTATED_HOOK_TOKEN,
        path: "/incoming",
      });
      await waitForHookStatus({
        port,
        path: "/incoming/wake",
        token: ROTATED_HOOK_TOKEN,
        status: 400,
      });
      const replayedRunId = await hookRunId(
        await postHook(port, "/incoming/agent", message, replayKey, ROTATED_HOOK_TOKEN),
      );
      expect(replayedRunId).toBe(firstRunId);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
    });
  });

  test("admits an HTTP hook after placement while runtime preparation remains blocked", async () => {
    await withHookGateway(async ({ port }) => {
      await waitForGatewayStartup(port);
      const placementAdmissionPublished = createDeferred();
      const runtimePreparation = createDeferred();
      let runnerEntered = false;
      let response: Response | undefined;
      cronIsolatedRun.mockImplementationOnce(async (params: unknown) => {
        const callbacks = params as {
          onExecutionStarted?: () => void;
          onLaneWait?: (info: { waiting: boolean }) => void;
        };
        callbacks.onLaneWait?.({ waiting: false });
        placementAdmissionPublished.resolve();
        await runtimePreparation.promise;
        runnerEntered = true;
        callbacks.onExecutionStarted?.();
        return { status: "ok", summary: "done" };
      });
      const responsePromise = postAgent(port, "placement-admission-before-runtime").then(
        (result) => {
          response = result;
          return result;
        },
      );

      try {
        await placementAdmissionPublished.promise;
        await expect.poll(() => response?.status, { timeout: 1_000, interval: 10 }).toBe(200);
        expect(runnerEntered).toBe(false);
      } finally {
        runtimePreparation.resolve();
        await responsePromise;
      }
    });
  });

  test("does not admit an HTTP hook when only cron session preparation enters its lane", async () => {
    await withHookGateway(async ({ port }) => {
      await waitForGatewayStartup(port);
      cronIsolatedRun.mockImplementationOnce(async (params: unknown) => {
        const callbacks = params as {
          onLaneWait?: (info: { waiting: boolean; stage?: "session-preparation" }) => void;
        };
        callbacks.onLaneWait?.({ waiting: false, stage: "session-preparation" });
        return { status: "error", error: "busy", admissionDisposition: "session-conflict" };
      });
      const response = await postAgent(port, "session-preparation-before-execution-lane");
      expect(response.status).toBe(409);
    });
  });
});
