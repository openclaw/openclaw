import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { waitForFile } from "../../test/helpers/process-wait.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { testing } from "../agents/cli-backends.test-support.js";
import * as cliLiveSessions from "../agents/cli-runner/cli-live-session-registry.js";
import { executeDeps } from "../agents/cli-runner/execute-deps.js";
import { cliBackendLog } from "../agents/cli-runner/log.js";
import type {
  CliBackendExecuteContext,
  CliBackendPrepareExecutionContext,
} from "../plugins/cli-backend.types.js";
import * as agentJobs from "./agent-turn/agent-job.js";
import type { GatewayClient } from "./client.js";
import {
  createWatchdogClock,
  createWatchdogFixture,
  type WatchdogFixture,
} from "./server.cli-watchdog.test-support.js";
import * as gatewayFixture from "./test-helpers.e2e.js";

type WatchdogCase = {
  name: string;
  behavior: "complete" | "stall" | "quiet" | "overall" | "cancel" | "ordered";
  overallSeconds: number;
  quietMs: number;
  freezeMs: number;
  outputFirst: boolean;
  resume: boolean;
};

type WatchdogCompletion = { status: string; endedAt: number; error?: string };

const cases: WatchdogCase[] = [
  {
    name: "preserves a fresh CLI reply across a process freeze",
    behavior: "complete",
    overallSeconds: 300,
    quietMs: 40_000,
    freezeMs: 60_000,
    outputFirst: false,
    resume: false,
  },
  {
    name: "ends a resumed CLI stall at the normal quiet deadline after thaw",
    behavior: "stall",
    overallSeconds: 0,
    quietMs: 40_000,
    freezeMs: 60_000,
    outputFirst: true,
    resume: true,
  },
  {
    name: "counts a short process pause against the quiet budget",
    behavior: "quiet",
    overallSeconds: 0,
    quietMs: 40_000,
    freezeMs: 20_000,
    outputFirst: false,
    resume: false,
  },
  {
    name: "preserves the total active budget without hiding its later expiry",
    behavior: "overall",
    overallSeconds: 40,
    quietMs: 120_000,
    freezeMs: 60_000,
    outputFirst: false,
    resume: false,
  },
  {
    name: "keeps the quiet deadline when output precedes an overdue timer",
    behavior: "ordered",
    overallSeconds: 300,
    quietMs: 40_000,
    freezeMs: 0,
    outputFirst: false,
    resume: false,
  },
  {
    name: "still allows chat.abort to cancel the actual CLI turn",
    behavior: "cancel",
    overallSeconds: 300,
    quietMs: 40_000,
    freezeMs: 0,
    outputFirst: false,
    resume: false,
  },
];

describe.skipIf(process.platform === "win32")(
  "CLI watchdog through registered Gateway methods",
  () => {
    let fixture: WatchdogFixture | undefined;
    let startup: Promise<WatchdogFixture> | undefined;
    beforeAll(async () => {
      startup = createWatchdogFixture();
      fixture = await startup;
    }, 180_000);
    afterAll(async () => {
      const owned = await startup?.catch(() => undefined);
      await owned?.cleanup();
    });
    it.for(cases)(
      "registered chat.send $name",
      { timeout: 180_000 },
      (testCase, { signal, onTestFinished }) => {
        if (!fixture || fixture.cleanupFailed) {
          throw new Error("The shared watchdog Gateway is not available for another case.");
        }
        const work = runWatchdogCase(fixture, testCase, signal);
        onTestFinished(() => work);
        return work;
      },
    );
  },
);

async function runWatchdogCase(
  fixture: WatchdogFixture,
  testCase: WatchdogCase,
  signal: AbortSignal,
) {
  const { state, gateway, backends, token, controllerScript } = fixture;
  const proof = state.path("proof", testCase.behavior);
  const nativeRoot = state.path("receipts", testCase.behavior);
  const sessionKey = `agent:main:freeze-${randomUUID()}`;
  const clock = createWatchdogClock();
  const realClock = executeDeps.watchdogClock;
  let orderedOutputAt: number | undefined;
  let abortedAt: number | undefined;
  let thawedAt: number | undefined;
  let outputs = 0;
  let outputChanged = createDeferred();
  const waitForOutputs = async (expected: number) => {
    await withTestTimeout(
      (async () => {
        let observed = outputs;
        while (observed < expected) {
          signal.throwIfAborted();
          await outputChanged.promise;
          observed = outputs;
        }
        signal.throwIfAborted();
      })(),
      5_000,
      `CLI did not publish ${expected} outputs`,
    );
    expect(outputs).toBe(expected);
  };
  let completionRunId: string | undefined;
  const completionObserved = createDeferred();
  const originalWait = agentJobs.waitForAgentJob;
  const waitForAgentJob =
    testCase.behavior === "cancel"
      ? vi.spyOn(agentJobs, "waitForAgentJob").mockImplementation((params) => {
          if (params.runId === completionRunId && params.source === "chat") {
            completionObserved.resolve();
          }
          return originalWait(params);
        })
      : undefined;
  const log = vi.spyOn(cliBackendLog, "info");

  const preparedContexts = new Set<
    Parameters<typeof cliLiveSessions.createCliLiveSessionCapability>[0]["context"]
  >();
  const createCapability = cliLiveSessions.createCliLiveSessionCapability;
  const capability = vi
    .spyOn(cliLiveSessions, "createCliLiveSessionCapability")
    .mockImplementation((params) => {
      preparedContexts.add(params.context);
      return createCapability(params);
    });
  let pendingCompletion: Promise<WatchdogCompletion> | undefined;
  let controller: ReturnType<typeof spawn> | undefined;
  let controllerExit: Promise<void> | undefined;
  const abortWaits = () => {
    outputChanged.resolve();
    completionObserved.resolve();
  };
  signal.addEventListener("abort", abortWaits, { once: true });
  return await runQaGatewayFixture(
    async () => {
      executeDeps.watchdogClock = clock;
      await Promise.all([
        fs.mkdir(proof, { recursive: true }),
        fs.mkdir(nativeRoot, { recursive: true }),
      ]);
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
                    OPENCLAW_TEST_CLI_BEHAVIOR: testCase.behavior,
                    OPENCLAW_TEST_CLI_RECEIPTS: nativeRoot,
                  },
                  async *execute(execution: CliBackendExecuteContext) {
                    execution.abortSignal?.addEventListener(
                      "abort",
                      () => {
                        abortedAt = clock.now();
                      },
                      { once: true },
                    );
                    for await (const event of execute(execution)) {
                      if (
                        event.type === "assistant" &&
                        testCase.behavior === "ordered" &&
                        orderedOutputAt === undefined
                      ) {
                        orderedOutputAt = clock.now();
                        clock.jump(60_000);
                      }
                      yield event;
                      // The consumer has called noteOutput before requesting the next event.
                      if (event.type === "assistant") {
                        outputs++;
                        const observed = outputChanged;
                        outputChanged = createDeferred();
                        observed.resolve();
                      }
                    }
                  },
                };
              },
              config: {
                ...backend.config,
                reliability: {
                  watchdog: {
                    fresh: { minMs: testCase.quietMs, maxMs: testCase.quietMs },
                    resume: { minMs: testCase.quietMs, maxMs: testCase.quietMs },
                  },
                },
              },
            }),
          ),
      });
      if (testCase.resume) {
        const warm = await gateway.client.request<{ runId: string }>("chat.send", {
          sessionKey,
          message: "Warm up this session",
          timeoutMs: testCase.overallSeconds * 1000,
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        const warmResult = await gateway.client.request<{ status: string }>("agent.wait", {
          runId: warm.runId,
          timeoutMs: 15_000,
        });
        expect(warmResult.status).toBe("ok");
      }
      outputs = 0;
      abortedAt = undefined;
      const acceptedAt = Date.now();
      const accepted = await gateway.client.request<{ runId: string; status: string }>(
        "chat.send",
        {
          sessionKey,
          message: "Reply after resume.",
          timeoutMs: testCase.overallSeconds * 1000,
          deliver: false,
          idempotencyKey: randomUUID(),
        },
      );
      expect(accepted.status).toBe("started");
      // Observe the durable receipt: native directory watchers can miss a rename.
      await waitForFile(path.join(nativeRoot, "ready.json"), 30_000);
      signal.throwIfAborted();
      const ready: { pid: number; time: number; turns: number } = JSON.parse(
        await fs.readFile(path.join(nativeRoot, "ready.json"), "utf8"),
      );
      expect(preparedContexts.size).toBeGreaterThan(0);
      expect(ready.turns).toBe(testCase.resume ? 2 : 1);
      await waitForOutputs(1);
      const pulse = async () => {
        const expected = outputs + 1;
        process.kill(ready.pid, "SIGUSR1");
        await waitForOutputs(expected);
      };
      const waitForCompletion = (client: GatewayClient) =>
        client.request<WatchdogCompletion>(
          "agent.wait",
          {
            runId: accepted.runId,
            timeoutMs: 50_000,
          },
          { timeoutMs: 55_000 },
        );
      if (testCase.behavior === "cancel") {
        completionRunId = accepted.runId;
        pendingCompletion = waitForCompletion(gateway.client);
        void pendingCompletion.catch(() => {});
        await withTestTimeout(completionObserved.promise, 5_000, "agent.wait was not registered");
        signal.throwIfAborted();
        expect(
          waitForAgentJob?.mock.calls.some(
            ([params]) => params.runId === accepted.runId && params.source === "chat",
          ),
        ).toBe(true);
        const cancelled = await gateway.client.request("chat.abort", {
          sessionKey,
          runId: accepted.runId,
        });
        expect(cancelled).toMatchObject({ aborted: true, runIds: [accepted.runId] });
      } else if (testCase.behavior === "ordered") {
        clock.advance(0);
        expect(
          log.mock.calls.some(([message]) => message.includes("cli watchdog credited timer gap")),
        ).toBe(true);
        thawedAt = clock.now();
      } else {
        controller = spawn(
          process.execPath,
          [
            controllerScript,
            String(process.pid),
            path.join(proof, "freeze-receipt.json"),
            String(ready.pid),
          ],
          {
            detached: true,
            signal,
            stdio: ["ignore", "ignore", "inherit", "ipc"],
            env: { PATH: "/usr/bin:/bin" },
          },
        );
        const ownedController = controller;
        controllerExit = new Promise<void>((resolve, reject) => {
          ownedController.once("error", reject);
          ownedController.once("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(`controller ${code}`)),
          );
        });
        void controllerExit.catch(() => {});
        const stopped = await Promise.race([
          new Promise<unknown>((resolve) => {
            ownedController.once("message", resolve);
          }),
          controllerExit.then(() => {
            throw new Error("Controller exited before stopping the tree");
          }),
        ]);
        expect(stopped).toBe("stopped");
        signal.throwIfAborted();
        clock.jump(testCase.freezeMs);
        thawedAt = clock.now();
        if (!testCase.outputFirst) {
          clock.advance(0);
        }
        expect(abortedAt).toBeUndefined();
        ownedController.send("resume");
        await controllerExit;
        controller = undefined;
        if (testCase.behavior === "complete" || testCase.behavior === "quiet") {
          await waitForFile(path.join(nativeRoot, "resumed.json"), 5_000);
          await fs.access(path.join(nativeRoot, "resumed.json"));
        } else {
          await waitForOutputs(2);
        }
        if (testCase.outputFirst) {
          clock.advance(0);
        }
        if (testCase.behavior === "complete") {
          clock.advance(250);
          await pulse();
        }
      }
      if (testCase.behavior !== "cancel") {
        await gatewayFixture.disconnectGatewayClient(gateway.client);
        gateway.client = await gatewayFixture.connectGatewayClient({
          url: `ws://127.0.0.1:${gateway.port}`,
          token,
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
      }
      if (!["complete", "cancel"].includes(testCase.behavior)) {
        // The overdue one-second tick is active time; only its lateness is credited.
        const remaining =
          testCase.behavior === "quiet"
            ? 20_000
            : testCase.behavior === "overall"
              ? 39_000
              : 40_000;
        for (let elapsed = 0; elapsed < remaining - 1;) {
          const step = Math.min(5_000, remaining - 1 - elapsed);
          clock.advance(step);
          elapsed += step;
          expect(abortedAt).toBeUndefined();
          if (testCase.behavior === "overall" && step === 5_000) {
            await pulse();
          }
        }
        clock.advance(1);
        expect(abortedAt).toBe(clock.now());
      }
      const completed = await (pendingCompletion ?? waitForCompletion(gateway.client));
      expect(completed.endedAt).toBeGreaterThanOrEqual(acceptedAt);
      expect(clock.pending()).toBe(0);
      const history = await gateway.client.request("chat.history", { sessionKey });
      await fs.writeFile(
        path.join(proof, "gateway-result.json"),
        JSON.stringify({ accepted, completed, history }, null, 2),
      );
      const timerMessages = log.mock.calls
        .map(([message]) => message)
        .filter((message) => message.includes("cli watchdog credited timer gap"));
      await fs.writeFile(path.join(proof, "timer-events.json"), JSON.stringify(timerMessages));
      if (testCase.behavior === "ordered") {
        expect(timerMessages).toHaveLength(1);
        expect(timerMessages[0]).toContain("creditedMs=0");
      }
      if (testCase.behavior === "complete") {
        expect(completed.status).toBe("ok");
        expect(JSON.stringify(history)).toContain("Preserved reply.");
      } else if (testCase.behavior === "cancel") {
        expect(completed.status).not.toBe("timeout");
        expect(JSON.stringify(history)).not.toContain("Preserved reply.");
      } else {
        expect(completed.status).toBe("timeout");
        let elapsedAfterThaw: number;
        if (testCase.behavior === "ordered") {
          if (orderedOutputAt === undefined) {
            throw new Error("Registered CLI transport did not deliver its ordered output.");
          }
          elapsedAfterThaw = (abortedAt ?? Number.NaN) - 60_000 - orderedOutputAt;
        } else {
          const freeze: { stoppedAt: number; resumedAt: number } = JSON.parse(
            await fs.readFile(path.join(proof, "freeze-receipt.json"), "utf8"),
          );
          expect(freeze.resumedAt).toBeGreaterThanOrEqual(freeze.stoppedAt);
          elapsedAfterThaw = (abortedAt ?? Number.NaN) - (thawedAt ?? Number.NaN);
        }
        const expectedRemaining = testCase.behavior === "quiet" ? 20_000 : 40_000;
        expect(elapsedAfterThaw).toBeGreaterThan(expectedRemaining - 5_000);
        expect(elapsedAfterThaw).toBeLessThan(expectedRemaining + 2_000);
        expect(completed.error).toContain(
          testCase.behavior === "overall" ? "exceeded timeout" : "no output for 40s",
        );
      }
    },
    async () => {
      try {
        await runQaGatewayFixture(
          async () => {
            controller?.kill("SIGTERM");
            await controllerExit?.catch(() => {});
          },
          async () => {
            await gateway.client.request("sessions.delete", { key: sessionKey });
          },
          async () => {
            const results = await Promise.allSettled(
              [...preparedContexts].map((context) =>
                cliLiveSessions.closeCliLiveSession(context, "restart"),
              ),
            );
            const failures = results.filter((result) => result.status === "rejected");
            if (failures.length > 0) {
              throw new AggregateError(
                failures.map((failure) => failure.reason),
                "CLI session cleanup failed",
              );
            }
          },
          async () => {
            await pendingCompletion?.catch(() => {});
          },
        );
      } catch (error) {
        fixture.cleanupFailed = true;
        throw error;
      } finally {
        // Restore observation hooks after every owner has had its cleanup attempt.
        signal.removeEventListener("abort", abortWaits);
        executeDeps.watchdogClock = realClock;
        testing.resetDepsForTest();
        capability.mockRestore();
        log.mockRestore();
        waitForAgentJob?.mockRestore();
      }
    },
    async () => {
      const evidenceRoot = process.env.OPENCLAW_CLI_WATCHDOG_PROOF_DIR;
      if (evidenceRoot) {
        await fs.mkdir(evidenceRoot, { recursive: true });
        await fs.cp(proof, path.join(evidenceRoot, testCase.behavior), { recursive: true });
      }
    },
  );
}
