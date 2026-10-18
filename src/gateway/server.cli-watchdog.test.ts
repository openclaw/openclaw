import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { text } from "node:stream/consumers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
  withTestTimeout,
} from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { testing } from "../agents/cli-backends.test-support.js";
import * as cliLiveSessions from "../agents/cli-runner/cli-live-session-registry.js";
import { executeDeps } from "../agents/cli-runner/execute-deps.js";
import { cliBackendLog } from "../agents/cli-runner/log.js";
import type {
  CliBackendExecute,
  CliBackendExecuteContext,
  CliBackendPrepareExecutionContext,
} from "../plugins/cli-backend.types.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { observeGatewayRunExecution } from "./agent-command.test-helpers.js";
import * as agentJobs from "./agent-turn/agent-job.js";
import * as watchdogFixture from "./server.cli-watchdog.test-support.js";
import * as gatewayFixture from "./test-helpers.e2e.js";

type WatchdogCase = [
  name: string,
  behavior: "complete" | "stall" | "quiet" | "overall" | "cancel" | "ordered",
  overallSeconds?: number,
  quietMs?: number,
  freezeMs?: number,
];

type WatchdogCompletion = { status: string; endedAt: number; error?: string };

const cases: WatchdogCase[] = [
  ["preserves a fresh CLI reply across a process freeze", "complete"],
  ["ends a resumed CLI stall at the normal quiet deadline after thaw", "stall", 0],
  ["counts a short process pause against the quiet budget", "quiet", 0, 40_000, 20_000],
  ["preserves the total active budget without hiding its later expiry", "overall", 40, 120_000],
  ["keeps the quiet deadline when output precedes an overdue timer", "ordered"],
  ["still allows chat.abort to cancel the actual CLI turn", "cancel"],
];

describe.skipIf(process.platform === "win32")(
  "CLI watchdog through registered Gateway methods",
  () => {
    let startup: Promise<watchdogFixture.WatchdogFixture>;
    beforeAll(() => {
      startup = watchdogFixture.createWatchdogFixture();
      return startup;
    }, 180_000);
    afterAll(async () => (await startup.catch(() => undefined))?.cleanup());
    it.for(cases)(
      "registered chat.send %s",
      { timeout: 180_000 },
      async (testCase, { signal, onTestFinished }) => {
        const work = runWatchdogCase(await startup, testCase, signal);
        onTestFinished(() => work);
        return work;
      },
    );
  },
);

async function runWatchdogCase(
  fixture: watchdogFixture.WatchdogFixture,
  testCase: WatchdogCase,
  signal: AbortSignal,
) {
  const { state, gateway, backends, token, controllerScript } = fixture;
  const [, behavior, overallSeconds = 300, quietMs = 40_000, freezeMs = 60_000] = testCase;
  const resume = behavior === "stall";
  const requestExecution = await observeGatewayRunExecution();
  const proof = state.path("proof", behavior);
  const nativeRoot = state.path("receipts", behavior);
  const sessionKey = `agent:main:freeze-${randomUUID()}`;
  const clock = watchdogFixture.createWatchdogClock();
  const watchdog = { minMs: quietMs, maxMs: quietMs };
  const readJson = async <T>(file: string): Promise<T> =>
    JSON.parse(await fs.readFile(file, "utf8"));
  const freezeReceipt = path.join(proof, "freeze-receipt.json");
  const realClock = executeDeps.watchdogClock;
  let orderedOutputAt: number | undefined;
  let abortedAt: number | undefined;
  let thawedAt: number | undefined;
  let outputs = 0;
  let outputChanged = createDeferred();
  const wait = async <T>(promise: Promise<T>, message: string, timeoutMs = 5_000) => {
    const result = await withTestTimeout(withinTest(promise, signal), timeoutMs, message);
    signal.throwIfAborted();
    return result;
  };
  const waitForOutputs = async (expected: number) => {
    await wait(
      (async () => {
        for (let observed = outputs; observed < expected; observed = outputs) {
          await withinTest(outputChanged.promise, signal);
        }
      })(),
      `CLI did not publish ${expected} outputs`,
    );
    expect(outputs).toBe(expected);
  };
  let completionRunId: string | undefined;
  const completionObserved = createDeferred();
  const originalWait = agentJobs.waitForAgentJob;
  const waitForAgentJob =
    behavior === "cancel"
      ? vi.spyOn(agentJobs, "waitForAgentJob").mockImplementation((params) => {
          if (params.runId === completionRunId && params.source === "chat") {
            completionObserved.resolve();
          }
          return originalWait(params);
        })
      : undefined;
  const log = vi.spyOn(cliBackendLog, "info");

  const preparedContexts = new Set<Parameters<typeof cliLiveSessions.closeCliLiveSession>[0]>();
  const createCapability = cliLiveSessions.createCliLiveSessionCapability;
  const capability = vi
    .spyOn(cliLiveSessions, "createCliLiveSessionCapability")
    .mockImplementation((params) => {
      preparedContexts.add(params.context);
      return createCapability(params);
    });
  let pendingCompletion: Promise<WatchdogCompletion> | undefined;
  let controller: ReturnType<typeof fork> | undefined;
  let controllerExit: Promise<void> | undefined;
  let receipts: Awaited<ReturnType<typeof reserveTestPortListener>> | undefined;
  const receiptSockets = new Set<Socket>();
  let closingReceipts = false;
  const readyReceipt = createDeferred();
  const resumedReceipt = createDeferred();
  void readyReceipt.promise.catch(() => {});
  void resumedReceipt.promise.catch(() => {});
  const rejectReceipts = (error: unknown) => {
    readyReceipt.reject(error);
    resumedReceipt.reject(error);
  };
  const recordAbort = () => {
    abortedAt = clock.now();
  };
  async function* observeOutput(execute: CliBackendExecute, execution: CliBackendExecuteContext) {
    execution.abortSignal?.addEventListener("abort", recordAbort, { once: true });
    try {
      for await (const event of execute(execution)) {
        const assistant = event.type === "assistant";
        if (assistant && behavior === "ordered" && orderedOutputAt === undefined) {
          orderedOutputAt = clock.now();
          clock.jump(60_000);
        }
        yield event;
        // The consumer has called noteOutput before requesting the next event.
        if (assistant) {
          outputs++;
          const observed = outputChanged;
          outputChanged = createDeferred();
          observed.resolve();
        }
      }
    } catch (error) {
      rejectReceipts(error);
      throw error;
    }
  }
  return await runQaGatewayFixture(
    async () => {
      executeDeps.watchdogClock = clock;
      await Promise.all(
        [proof, nativeRoot].map((directory) => fs.mkdir(directory, { recursive: true })),
      );
      receipts = await reserveTestPortListener({
        offsets: [0],
        signal,
        createListener: () =>
          createServer((socket) => {
            if (closingReceipts) {
              socket.destroy();
              return;
            }
            receiptSockets.add(socket);
            socket.once("close", () => receiptSockets.delete(socket));
            void text(socket)
              .then((receipt) => {
                const notification = new Map([
                  ["ready.json", readyReceipt],
                  ["resumed.json", resumedReceipt],
                ]).get(receipt);
                if (!notification) {
                  throw new Error(`Unexpected CLI receipt: ${receipt}`);
                }
                notification.resolve();
              })
              .catch(rejectReceipts);
          }),
      });
      receipts.listener.on("error", rejectReceipts);
      const receiptPort = receipts.claim.port;
      signal.throwIfAborted();
      testing.setDepsForTest({
        resolveRuntimeCliBackends: () =>
          backends.map((backend) =>
            Object.assign({}, backend, {
              prepareExecution: async (context: CliBackendPrepareExecutionContext) => {
                const prepared = await backend.prepareExecution?.(context);
                if (!prepared?.execute) {
                  throw new Error("Registered CLI backend must provide its execution transport.");
                }
                const execute = prepared.execute;
                return {
                  ...prepared,
                  env: {
                    ...prepared.env,
                    OPENCLAW_TEST_CLI_BEHAVIOR: behavior,
                    OPENCLAW_TEST_CLI_RECEIPTS: nativeRoot,
                    OPENCLAW_TEST_CLI_RECEIPT_PORT: String(receiptPort),
                  },
                  execute: (execution: CliBackendExecuteContext) =>
                    observeOutput(execute, execution),
                };
              },
              config: {
                ...backend.config,
                reliability: { watchdog: { fresh: watchdog, resume: watchdog } },
              },
            }),
          ),
      });
      const send = (message: string) =>
        gateway.client.request<{ runId: string; status: string }>("chat.send", {
          sessionKey,
          message,
          timeoutMs: overallSeconds * 1000,
          deliver: false,
          idempotencyKey: randomUUID(),
        });
      const waitForCompletion = (runId: string, timeoutMs: number, transportTimeoutMs?: number) =>
        gateway.client.request<WatchdogCompletion>(
          "agent.wait",
          { runId, timeoutMs },
          transportTimeoutMs === undefined ? undefined : { timeoutMs: transportTimeoutMs },
        );
      if (resume) {
        const warm = await send("Warm up this session");
        const warmResult = await waitForCompletion(warm.runId, 15_000);
        expect(warmResult.status).toBe("ok");
      }
      outputs = 0;
      abortedAt = undefined;
      const acceptedAt = Date.now();
      const accepted = await send("Reply after resume.");
      expect(accepted.status).toBe("started");
      await wait(readyReceipt.promise, "CLI readiness receipt was not published", 30_000);
      const ready = await readJson<{ pid: number; turns: number }>(
        path.join(nativeRoot, "ready.json"),
      );
      expect(preparedContexts.size).toBeGreaterThan(0);
      expect(ready.turns).toBe(resume ? 2 : 1);
      await waitForOutputs(1);
      const pulse = async () => {
        const expected = outputs + 1;
        process.kill(ready.pid, "SIGUSR1");
        await waitForOutputs(expected);
      };
      if (behavior === "cancel") {
        completionRunId = accepted.runId;
        pendingCompletion = waitForCompletion(accepted.runId, 50_000, 55_000);
        void pendingCompletion.catch(() => {});
        await wait(completionObserved.promise, "agent.wait was not registered");
        const cancelled = await gateway.client.request("chat.abort", {
          sessionKey,
          runId: accepted.runId,
        });
        expect(cancelled).toMatchObject({ aborted: true, runIds: [accepted.runId] });
      } else if (behavior === "ordered") {
        clock.advance(0);
      } else {
        controller = fork(
          controllerScript,
          [String(process.pid), freezeReceipt, String(ready.pid)],
          {
            detached: true,
            signal,
            stdio: ["ignore", "ignore", "inherit", "ipc"],
            env: { PATH: "/usr/bin:/bin" },
            execArgv: [],
          },
        );
        const ownedController = controller;
        controllerExit = once(ownedController, "exit").then(([code]) => {
          if (code !== 0) {
            throw new Error(`controller ${code}`);
          }
        });
        void controllerExit.catch(() => {});
        const [stopped] = await awaitGateBeforeSettlement(
          once(ownedController, "message"),
          controllerExit,
          "Controller exited before stopping the tree",
        );
        expect(stopped).toBe("stopped");
        signal.throwIfAborted();
        clock.jump(freezeMs);
        thawedAt = clock.now();
        if (!resume) {
          clock.advance(0);
        }
        ownedController.send("resume");
        await controllerExit;
        controller = undefined;
        if (behavior === "complete" || behavior === "quiet") {
          await wait(resumedReceipt.promise, "CLI resume receipt was not published");
        } else {
          await waitForOutputs(2);
        }
        if (resume) {
          clock.advance(0);
        }
        if (behavior === "complete") {
          clock.advance(250);
          await pulse();
        }
      }
      if (behavior !== "cancel") {
        await gatewayFixture.disconnectGatewayClient(gateway.client);
        gateway.client = await gatewayFixture.connectGatewayClient({
          url: `ws://127.0.0.1:${gateway.port}`,
          token,
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
      }
      if (!["complete", "cancel"].includes(behavior)) {
        // The overdue one-second tick is active time; only its lateness is credited.
        const remaining = behavior === "quiet" ? 20_000 : behavior === "overall" ? 39_000 : 40_000;
        for (let elapsed = 0; elapsed < remaining - 1;) {
          const step = Math.min(5_000, remaining - 1 - elapsed);
          clock.advance(step);
          elapsed += step;
          expect(abortedAt).toBeUndefined();
          if (behavior === "overall" && step === 5_000) {
            await pulse();
          }
        }
        clock.advance(1);
        expect(abortedAt).toBe(clock.now());
      }
      const completed = await (pendingCompletion ??
        waitForCompletion(accepted.runId, 50_000, 55_000));
      expect(completed.endedAt).toBeGreaterThanOrEqual(acceptedAt);
      expect(clock.pending()).toBe(0);
      const history = await gateway.client.request("chat.history", { sessionKey });
      const timerMessages = log.mock.calls
        .map(([message]) => message)
        .filter((message) => message.includes("cli watchdog credited timer gap"));
      if (behavior === "ordered") {
        expect(timerMessages).toEqual([expect.stringContaining("creditedMs=0")]);
      }
      if (behavior === "complete") {
        expect(completed.status).toBe("ok");
        expect(JSON.stringify(history)).toContain("Preserved reply.");
      } else if (behavior === "cancel") {
        expect(completed.status).not.toBe("timeout");
        expect(JSON.stringify(history)).not.toContain("Preserved reply.");
      } else {
        expect(completed.status).toBe("timeout");
        if (behavior !== "ordered") {
          const freeze = await readJson<{ stoppedAt: number; resumedAt: number }>(freezeReceipt);
          expect(freeze.resumedAt).toBeGreaterThanOrEqual(freeze.stoppedAt);
        }
        const elapsedAfterThaw =
          (abortedAt ?? Number.NaN) -
          (behavior === "ordered"
            ? 60_000 + (orderedOutputAt ?? Number.NaN)
            : (thawedAt ?? Number.NaN));
        const expectedRemaining = behavior === "quiet" ? 20_000 : 40_000;
        expect(elapsedAfterThaw).toBeGreaterThan(expectedRemaining - 5_000);
        expect(elapsedAfterThaw).toBeLessThan(expectedRemaining + 2_000);
        expect(completed.error).toContain(
          behavior === "overall" ? "exceeded timeout" : "no output for 40s",
        );
      }
    },
    async () => {
      controller?.kill("SIGTERM");
      await controllerExit?.catch(() => {});
    },
    // agent.wait can observe a terminal attempt while detached chat work settles.
    () => gateway.client.request("chat.abort", { sessionKey }),
    async () => {
      const results = await Promise.allSettled(
        [...preparedContexts].map((context) =>
          cliLiveSessions.closeCliLiveSession(context, "restart"),
        ),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "CLI session cleanup failed");
      }
    },
    async () => {
      await pendingCompletion?.catch(() => {});
      await requestExecution.waitForCompletion();
    },
    () => gateway.client.request("sessions.delete", { key: sessionKey }),
    async () => {
      closingReceipts = true;
      const closed = receipts?.releaseListener();
      for (const socket of receiptSockets) {
        socket.destroy();
      }
      await closed;
    },
    () => receipts?.claim.release(),
    async () => {
      executeDeps.watchdogClock = realClock;
      testing.resetDepsForTest();
      for (const spy of [capability, log, waitForAgentJob]) {
        spy?.mockRestore();
      }
      await requestExecution.restore();
    },
  );
}
