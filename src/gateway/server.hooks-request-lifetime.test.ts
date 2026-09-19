/** Real HTTP proof for request-owned hook admission cancellation. */
import { channel } from "node:diagnostics_channel";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import type { RunCronAgentTurnParams } from "../cron/isolated-agent/run-prepare-runtime.js";
import { drainSystemEvents } from "../infra/system-events.js";
import {
  cronIsolatedRun,
  installGatewayTestHooks,
  testState,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
await import("./server.js");
const HOOK_TOKEN = "hook-secret";

function observeHookResponseClose(idempotencyKey: string) {
  const closed = createDeferred<{ writableEnded: boolean }>();
  const requests = channel("http.server.request.start");
  let detachResponse = () => {};
  const onRequest = (message: unknown) => {
    // Node's request-start diagnostics publishes the actual server request/response pair.
    const { request, response } = message as { request: IncomingMessage; response: ServerResponse };
    if (request.headers["idempotency-key"] !== idempotencyKey) {
      return;
    }
    requests.unsubscribe(onRequest);
    const onClose = () => closed.resolve({ writableEnded: response.writableEnded });
    response.once("close", onClose);
    detachResponse = () => response.off("close", onClose);
  };
  requests.subscribe(onRequest);
  return {
    closed: closed.promise,
    cleanup: () => {
      requests.unsubscribe(onRequest);
      detachResponse();
    },
  };
}

afterEach(() => {
  drainSystemEvents(resolveMainSessionKeyFromConfig());
  vi.restoreAllMocks();
});

async function postHook(
  port: number,
  hookPath: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}${hookPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HOOK_TOKEN}`,
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

function startAbortableHookRequest(
  port: number,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
) {
  const payload = JSON.stringify(body);
  let req!: ReturnType<typeof httpRequest>;
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          Authorization: `Bearer ${HOOK_TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "Idempotency-Key": idempotencyKey,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.once("error", reject);
    req.end(payload);
  });
  return { response, abort: () => req.destroy() };
}

describe("gateway hook request lifetime", () => {
  test("real HTTP disconnect cancels queued admission but not accepted work", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:"],
    };
    await withGatewayServer(async ({ port }) => {
      const occupied = createDeferred();
      const targetQueued = createDeferred();
      const targetAborted = createDeferred();
      const accepted = createDeferred();
      const acceptedCompletion = createDeferred();
      const acceptedFinished = createDeferred();
      const acceptedClosed = observeHookResponseClose("proof-accepted-id");
      const mapSet = Reflect.get(Map.prototype, "set") as typeof Map.prototype.set;
      let queueEntries = 0;
      vi.spyOn(Map.prototype, "set").mockImplementation(
        function (this: Map<unknown, unknown>, key, value) {
          const result = Reflect.apply(mapSet, this, [key, value]);
          if (
            key === "agent:main:hook:proof:disconnect" &&
            value instanceof Promise &&
            ++queueEntries === 2
          ) {
            targetQueued.resolve();
          }
          return result;
        },
      );
      const abort = Reflect.get(
        AbortController.prototype,
        "abort",
      ) as typeof AbortController.prototype.abort;
      vi.spyOn(AbortController.prototype, "abort").mockImplementation(
        function (this: AbortController, reason) {
          Reflect.apply(abort, this, [reason]);
          const message =
            typeof reason === "object" && reason !== null && "message" in reason
              ? String(reason.message)
              : String(reason);
          if (message === "hook request disconnected") {
            targetAborted.resolve();
          }
        },
      );
      cronIsolatedRun.mockClear();
      cronIsolatedRun
        .mockImplementationOnce(async (params: unknown) => {
          (params as { onExecutionStarted?: () => void }).onExecutionStarted?.();
          await occupied.promise;
          return { status: "ok", summary: "blocker complete" };
        })
        .mockImplementationOnce(async (params: unknown) => {
          (params as { onExecutionStarted?: () => void }).onExecutionStarted?.();
          return { status: "ok", summary: "retry complete" };
        })
        .mockImplementationOnce(async (params: unknown) => {
          const callbacks = params as {
            abortSignal: AbortSignal;
            onLaneWait?: (info: { waiting: boolean }) => void;
            onExecutionStarted?: () => void;
          };
          callbacks.onLaneWait?.({ waiting: false });
          accepted.resolve();
          await acceptedCompletion.promise;
          expect(callbacks.abortSignal.aborted).toBe(false);
          callbacks.onExecutionStarted?.();
          acceptedFinished.resolve();
          return { status: "ok", summary: "accepted complete" };
        });
      const body = {
        message: "Proof dispatch",
        sessionKey: "hook:proof:disconnect",
        sessionMode: "persistent",
      };

      let abandoned: ReturnType<typeof startAbortableHookRequest> | undefined;
      let surviving: ReturnType<typeof startAbortableHookRequest> | undefined;
      try {
        const blocker = postHook(port, "/hooks/agent", body, "proof-blocker");
        await waitForCronIsolatedRuns(1);
        expect((await blocker).status).toBe(200);

        abandoned = startAbortableHookRequest(port, "/hooks/agent", body, "proof-stable-id");
        await targetQueued.promise;
        abandoned.abort();
        await expect(abandoned.response).rejects.toThrow();
        await targetAborted.promise;
        occupied.resolve();

        const retry = await postHook(port, "/hooks/agent", body, "proof-stable-id");
        expect(retry.status).toBe(200);
        await waitForCronIsolatedRuns(2);
        expect(cronIsolatedRun).toHaveBeenCalledTimes(2);

        surviving = startAbortableHookRequest(
          port,
          "/hooks/agent",
          { ...body, waitForCompletion: true },
          "proof-accepted-id",
        );
        void surviving.response.catch(() => undefined);
        await accepted.promise;
        surviving.abort();
        await expect(acceptedClosed.closed).resolves.toEqual({ writableEnded: false });
        acceptedCompletion.resolve();
        await acceptedFinished.promise;
        expect(cronIsolatedRun).toHaveBeenCalledTimes(3);
        console.info(
          "GATEWAY_HTTP_PROOF",
          JSON.stringify({
            authenticated: true,
            stableIdempotencyKey: true,
            queuedByServerMapSignal: true,
            disconnectedByServerSignal: true,
            abandonedBeforeAdmission: true,
            abandonedExecutions: 0,
            retryExecutions: 1,
            acceptedDisconnectCompleted: true,
            acceptedBeforeRunnerEntry: true,
            acceptedExecutions: 1,
          }),
        );
      } finally {
        abandoned?.abort();
        surviving?.abort();
        occupied.resolve();
        acceptedCompletion.resolve();
        acceptedClosed.cleanup();
      }
    });
  });

  test("keeps background fan-out admission after HTTP disconnect and replays the batch", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      presets: ["gmail"],
      defaultSessionKey: "hook:gmail:ingress",
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:gmail:"],
    };
    await withGatewayServer(async ({ port }) => {
      const releaseAdmission = createDeferred();
      const callerClosed = observeHookResponseClose("test-fanout");
      const startupSignals: AbortSignal[] = [];
      let executions = 0;
      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockImplementation(async (input: unknown) => {
        const params = input as RunCronAgentTurnParams;
        if (!params.abortSignal) {
          throw new Error("expected hook startup abort signal");
        }
        startupSignals.push(params.abortSignal);
        await releaseAdmission.promise;
        params.onExecutionStarted?.();
        executions += 1;
        return { status: "ok", summary: "background complete" };
      });
      const body = {
        messages: ["first", "second"].map((id) => ({
          id,
          from: "sender@example.com",
          subject: id,
          snippet: "test notification",
        })),
      };
      const caller = startAbortableHookRequest(port, "/hooks/gmail", body, "test-fanout");
      try {
        await waitForCronIsolatedRuns(2);
        caller.abort();
        await expect(caller.response).rejects.toThrow();
        await expect(callerClosed.closed).resolves.toEqual({ writableEnded: false });
        expect(startupSignals.every((signal) => !signal.aborted)).toBe(true);
        releaseAdmission.resolve();
        const retry = await postHook(port, "/hooks/gmail", body, "test-fanout");
        expect(retry.status).toBe(200);
        expect(cronIsolatedRun).toHaveBeenCalledTimes(2);
        expect(executions).toBe(2);
      } finally {
        caller.abort();
        releaseAdmission.resolve();
        callerClosed.cleanup();
      }
    });
  });

  test.each([
    {
      name: "direct",
      path: "/hooks/agent",
      body: { message: "Dispatch" },
      hooksConfig: { enabled: true, token: HOOK_TOKEN },
    },
    {
      name: "mapped",
      path: "/hooks/mapped-overlap",
      body: { subject: "Email" },
      hooksConfig: {
        enabled: true,
        token: HOOK_TOKEN,
        mappings: [
          {
            match: { path: "mapped-overlap" },
            action: "agent" as const,
            messageTemplate: "Mapped: {{payload.subject}}",
          },
        ],
      },
    },
  ])("keeps one $name pending replay alive when its creator disconnects", async (testCase) => {
    testState.hooksConfig = testCase.hooksConfig;
    await withGatewayServer(async ({ port }) => {
      const runnerAdmission = createDeferred();
      const duplicateFoundPending = createDeferred();
      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockImplementationOnce(async (params: unknown) => {
        await runnerAdmission.promise;
        (params as { onExecutionStarted?: () => void }).onExecutionStarted?.();
        return { status: "ok", summary: "done" };
      });

      let creator: ReturnType<typeof startAbortableHookRequest> | undefined;
      try {
        creator = startAbortableHookRequest(
          port,
          testCase.path,
          testCase.body,
          `overlap-${testCase.name}`,
        );
        await waitForCronIsolatedRuns(1);
        const mapGet = Reflect.get(Map.prototype, "get") as typeof Map.prototype.get;
        vi.spyOn(Map.prototype, "get").mockImplementation(
          function (this: Map<unknown, unknown>, key) {
            const value = Reflect.apply(mapGet, this, [key]);
            if (
              typeof value === "object" &&
              value !== null &&
              "waiters" in value &&
              value.waiters === 1
            ) {
              duplicateFoundPending.resolve();
            }
            return value;
          },
        );

        const duplicate = postHook(port, testCase.path, testCase.body, `overlap-${testCase.name}`);
        await duplicateFoundPending.promise;
        creator.abort();
        await expect(creator.response).rejects.toThrow();
        runnerAdmission.resolve();

        expect((await duplicate).status).toBe(200);
        expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      } finally {
        creator?.abort();
        runnerAdmission.resolve();
      }
    });
  });
});
