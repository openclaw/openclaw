/** Focused HTTP coverage for hook admission feedback and pending replay behavior. */
import fs from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
import path from "node:path";
import { afterEach, assert, describe, expect, test, vi, type TestContext } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { DEFAULT_WEBHOOK_MAX_BODY_BYTES } from "../infra/http-body.js";
import { drainSystemEvents, peekSystemEventEntries } from "../infra/system-events.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  connectWebchatClient,
  createGatewaySuiteHarness,
  cronIsolatedRun,
  installGatewayTestHooks,
  rpcReq,
  testState,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

await import("./server.js");

const HOOK_TOKEN = "hook-secret";
const ROTATED_HOOK_TOKEN = "hook-secret-rotated";

const fixtureLifetime = createFixtureLifetime();

afterEach(async () => {
  await fixtureLifetime.cleanup();
  drainSystemEvents(resolveMainSessionKeyFromConfig());
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
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

async function waitForCronIsolatedRuns(count: number): Promise<void> {
  await expect
    .poll(() => cronIsolatedRun.mock.calls.length, { timeout: 2_000, interval: 10 })
    .toBe(count);
}

async function waitForDuplicateRequest(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 25);
  });
}

async function writeReloadableHooksConfig(hooks: Record<string, unknown>): Promise<void> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  assert(configPath, "expected OPENCLAW_CONFIG_PATH");
  await fs.writeFile(
    configPath,
    `${JSON.stringify({ gateway: { reload: { mode: "hybrid" } }, hooks }, null, 2)}\n`,
    "utf8",
  );
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
  body: string;
  status: number;
}): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await fetch(`http://127.0.0.1:${params.port}${params.path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${params.token}`,
            "Content-Type": "application/json",
          },
          body: params.body,
        });
        await response.arrayBuffer();
        return response.status;
      },
      { timeout: 5_000, interval: 50 },
    )
    .toBe(params.status);
}

async function postOversizedChunkedHook(port: number): Promise<{
  statusCode: number | undefined;
  body: string;
  connection: string | undefined;
  events: string[];
}> {
  const agent = new Agent({ keepAlive: true });
  const events: string[] = [];
  try {
    return await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          agent,
          host: "127.0.0.1",
          port,
          path: "/hooks/wake",
          method: "POST",
          headers: {
            Authorization: `Bearer ${HOOK_TOKEN}`,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            events.push("response-end");
            void socketClosed.then(() => {
              events.push("socket-close");
              resolve({
                statusCode: res.statusCode,
                body: Buffer.concat(chunks).toString("utf8"),
                connection: res.headers.connection,
                events,
              });
            }, reject);
          });
        },
      );
      const socketClosed = new Promise<void>((resolveClose) => {
        req.once("socket", (socket) => socket.once("close", resolveClose));
      });
      req.on("error", reject);
      req.setTimeout(5_000, () => req.destroy(new Error("chunked hook request timed out")));
      req.write('{"text":"');
      req.write("x".repeat(DEFAULT_WEBHOOK_MAX_BODY_BYTES + 1));
      req.end('"}');
    });
  } finally {
    agent.destroy();
  }
}

async function writeHookTransformModule(moduleName: string, source: string): Promise<void> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  assert(configPath, "expected OPENCLAW_CONFIG_PATH");
  const transformsDir = path.join(path.dirname(configPath), "hooks", "transforms");
  await fs.mkdir(transformsDir, { recursive: true });
  await fs.writeFile(path.join(transformsDir, moduleName), source, "utf8");
}

async function createBlockedHookTransform(moduleName: string): Promise<{
  entered: Promise<void>;
  release: () => void;
  dispose: () => void;
}> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  assert(configPath, "expected OPENCLAW_CONFIG_PATH");
  const enteredEvent = `hook-transform:${configPath}:${moduleName}`;
  const entered = createDeferred();
  const released = createDeferred();
  const onEntered = (complete: () => void) => {
    entered.resolve();
    void released.promise.then(complete);
  };
  await writeHookTransformModule(
    moduleName,
    `export default async function transform() {
  await new Promise((resolve) => process.emit(${JSON.stringify(enteredEvent)}, resolve));
  return {};
}`,
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
  afterRotation?: (port: number, socket: Parameters<typeof rpcReq>[0]) => Promise<void>,
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
          const socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
          const mainSessionKey = resolveMainSessionKeyFromConfig();
          try {
            const current = await postHook(
              port,
              "/hooks/wake",
              { text: "before-reload" },
              "before",
            );
            expect(current.status).toBe(200);
            await expect
              .poll(
                () =>
                  peekSystemEventEntries(mainSessionKey).some((event) =>
                    event.text.includes("before-reload"),
                  ),
                { timeout: 2_000, interval: 10 },
              )
              .toBe(true);
            drainSystemEvents(mainSessionKey);
            const revoked = postHook(port, "/hooks/revoked", { text: "after-reload" }, "revoked");
            let response: Response;
            try {
              await withinTest(
                awaitGateBeforeSettlement(
                  transform.entered,
                  revoked,
                  "hook request settled before its transform entered",
                ),
                signal,
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
                body: "{}",
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
            await afterRotation?.(port, socket);
          } finally {
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
  test("flushes an oversized chunked hook response before closing the socket", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
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
    await withRevokedHook("rotate", context, async (port, socket) => {
      const mainSessionKey = resolveMainSessionKeyFromConfig();
      const authorized = await postHook(
        port,
        "/hooks/wake",
        { text: "current-after-rotation" },
        "current-after-rotation",
        ROTATED_HOOK_TOKEN,
      );
      expect(authorized.status).toBe(200);
      await expect
        .poll(
          () =>
            peekSystemEventEntries(mainSessionKey).some((event) =>
              event.text.includes("current-after-rotation"),
            ),
          { timeout: 2_000, interval: 10 },
        )
        .toBe(true);
      drainSystemEvents(mainSessionKey);
      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockImplementation(async (params: unknown) => {
        (params as { onExecutionStarted?: () => void }).onExecutionStarted?.();
        return { status: "ok", summary: "done" };
      });
      const replayKey = "production-reload-replay";
      const firstAgent = await postHook(
        port,
        "/hooks/agent",
        { message: "replay across reload" },
        replayKey,
        ROTATED_HOOK_TOKEN,
      );
      expect(firstAgent.status).toBe(200);
      const firstAgentBody = (await firstAgent.json()) as { runId?: string };
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
        body: "{}",
        status: 400,
      });
      const replayedAgent = await postHook(
        port,
        "/incoming/agent",
        { message: "replay across reload" },
        replayKey,
        ROTATED_HOOK_TOKEN,
      );
      expect(replayedAgent.status).toBe(200);
      const replayedAgentBody = (await replayedAgent.json()) as { runId?: string };
      expect(replayedAgentBody.runId).toBe(firstAgentBody.runId);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
    });
  });

  test("returns visible suppression without admitting a hook run", async () => {
    await writeHookTransformModule(
      "suppress.mjs",
      "export default function suppress() { return null; }",
    );
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      mappings: [
        {
          id: "suppressed-source",
          match: { path: "suppressed" },
          action: "agent",
          messageTemplate: "private {{payload.subject}}",
          transform: { module: "suppress.mjs" },
        },
      ],
    };
    await withGatewayServer(async ({ port }) => {
      cronIsolatedRun.mockClear();
      const response = await postHook(
        port,
        "/hooks/suppressed",
        { subject: "secret" },
        "suppressed-source",
      );
      expect(response.status).toBe(204);
      expect(cronIsolatedRun).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(resolveMainSessionKeyFromConfig())).toEqual([]);
    });
  });

  test("admits an HTTP hook after placement while runtime preparation remains blocked", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      const placementAdmissionPublished = createDeferred();
      const runtimePreparation = createDeferred();
      let runnerEntered = false;
      let response: Response | undefined;
      cronIsolatedRun.mockClear();
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
      const responsePromise = postHook(
        port,
        "/hooks/agent",
        { message: "Dispatch" },
        "placement-admission-before-runtime",
      ).then((result) => {
        response = result;
        return result;
      });

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

  test.each(["persistent", "mapped"])(
    "shares one pending %s dispatch across simultaneous duplicates",
    async (mode) => {
      testState.hooksConfig = {
        enabled: true,
        token: HOOK_TOKEN,
        allowRequestSessionKey: true,
        allowedSessionKeyPrefixes: ["hook:"],
        mappings: [
          {
            match: { path: "mapped-pending" },
            action: "agent",
            messageTemplate: "Mapped: {{payload.subject}}",
          },
        ],
      };
      const persistent = mode === "persistent";
      await withGatewayServer(async ({ port }) => {
        const runnerAdmission = createDeferred();
        cronIsolatedRun.mockClear();
        cronIsolatedRun.mockImplementationOnce(async (params: unknown) => {
          if (persistent) {
            expect(params).toHaveProperty("job.sessionTarget", "session:hook:admission:shared");
          }
          await runnerAdmission.promise;
          (params as { onExecutionStarted?: () => void }).onExecutionStarted?.();
          return { status: "ok", summary: "done" };
        });
        const request = () =>
          postHook(
            port,
            persistent ? "/hooks/agent" : "/hooks/mapped-pending",
            persistent
              ? {
                  message: "Dispatch",
                  sessionKey: "hook:admission:shared",
                  sessionMode: "persistent",
                }
              : { subject: "Email" },
            `pending-${mode}-idem`,
          );

        const firstResponse = request();
        await waitForCronIsolatedRuns(1);
        const duplicateResponse = request();
        await waitForDuplicateRequest();
        expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
        runnerAdmission.resolve();

        const [first, duplicate] = await Promise.all([firstResponse, duplicateResponse]);
        expect(first.status).toBe(200);
        expect(duplicate.status).toBe(200);
        const firstBody = (await first.json()) as { runId?: string };
        const duplicateBody = (await duplicate.json()) as { runId?: string };
        expect(duplicateBody.runId).toBe(firstBody.runId);
      });
    },
  );

  test("returns typed admission failures and leaves the idempotency key retryable", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      cronIsolatedRun.mockClear();
      cronIsolatedRun
        .mockResolvedValueOnce({
          status: "error",
          error: "session changed",
          admissionDisposition: "session-conflict",
        })
        .mockResolvedValueOnce({
          status: "error",
          error: "provider preparation failed",
          admissionDisposition: "rejected",
        })
        .mockImplementationOnce(async (params: unknown) => {
          (params as { onExecutionStarted?: () => void }).onExecutionStarted?.();
          return { status: "ok", summary: "done" };
        });
      const request = () =>
        postHook(port, "/hooks/agent", { message: "Dispatch" }, "admission-retry");

      const conflict = await request();
      expect(conflict.status).toBe(409);
      const conflictBody = (await conflict.json()) as { ok?: boolean; runId?: string };
      expect(conflictBody.ok).toBe(false);

      const gatewayFailure = await request();
      expect(gatewayFailure.status).toBe(502);
      const gatewayFailureBody = (await gatewayFailure.json()) as {
        ok?: boolean;
        runId?: string;
      };
      expect(gatewayFailureBody.ok).toBe(false);
      expect(gatewayFailureBody.runId).not.toBe(conflictBody.runId);

      const admitted = await request();
      expect(admitted.status).toBe(200);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(3);
    });
  });
});
