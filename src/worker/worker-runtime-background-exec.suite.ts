import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { WorkerTranscriptCommitParams } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { listRunningSessions, waitForExecScope } from "../agents/bash-process-registry.js";
import type { NodeWorkerLaunchReceipt } from "../node-host/node-worker-launch-store.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "../node-host/node-worker-process-identity.js";
import { createNodeWorkerSupervisor } from "../node-host/node-worker-supervisor.js";
import { NodeWorkerTurnStore } from "../node-host/node-worker-turn-store.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import type { NodeWorkerLaunchInput } from "./node-supervisor-protocol.js";
import { runWorkerCommand } from "./worker-command.runtime.js";
import { parseWorkerProcessResult, type WorkerProcessResult } from "./worker-process-protocol.js";

type WorkerCrashFixture = {
  setup: (options: {
    inferencePlans: Array<"background-tool" | "text">;
    backgroundCommand?: string;
  }) => Promise<{
    gateway: { acceptedTranscriptRequests: WorkerTranscriptCommitParams[] };
    launch: WorkerLaunchDescriptor;
    workspaceDir: string;
  }>;
  waitForFast: (
    callback: () => void | Promise<void>,
    options?: { timeout?: number; interval?: number },
  ) => Promise<void>;
  bundleHash: string;
  sessionId: string;
  inferenceStartTimeoutMs: number;
};

export function registerWorkerBackgroundExecLifecycleTests({
  setup,
  waitForFast,
  bundleHash: BUNDLE_HASH,
  sessionId: SESSION_ID,
  inferenceStartTimeoutMs: WORKER_INFERENCE_START_TIMEOUT_MS,
}: WorkerCrashFixture) {
  it
    .runIf(process.platform === "linux" || process.platform === "darwin")
    .each(["worker", "anchor", "node-host", "environment-stop"] as const)(
    "stops registered background execs after %s",
    { timeout: 120_000 },
    async (crashed) => {
      const { gateway, launch, workspaceDir } = await setup({
        inferencePlans: ["background-tool", "text"],
        backgroundCommand: `exec '${process.execPath.replaceAll("'", "'\\''")}' heartbeat.cjs`,
      });
      await writeFile(
        path.join(workspaceDir, "heartbeat.cjs"),
        [
          'const fs = require("node:fs");',
          'process.on("SIGTERM", () => {});',
          'fs.writeFileSync("exec.pid", String(process.pid));',
          'setInterval(() => fs.appendFileSync("heartbeat.txt", "tick\\n"), 25);',
        ].join("\n"),
      );
      const root = path.join(workspaceDir, "node-host");
      const bundle = path.join(root, "worker-lifetime", "bundles", BUNDLE_HASH);
      const home = path.join(workspaceDir, "home");
      await mkdir(bundle, { recursive: true });
      await mkdir(home);
      await writeFile(
        path.join(bundle, "worker.mjs"),
        [
          'import { writeFileSync } from "node:fs";',
          "globalThis.WORKER_DEPLOY_BUILD = true;",
          `await import(${JSON.stringify(new URL("../../scripts/tsx.mjs", import.meta.url).href)});`,
          `const { runWorkerProcess } = await import(${JSON.stringify(new URL("./worker-process.ts", import.meta.url).href)});`,
          `writeFileSync(${JSON.stringify(path.join(workspaceDir, "runtime.pid"))}, String(process.pid));`,
          ...(crashed === "anchor"
            ? [
                // A normal exception exit would conceal a failed supervisor-lifetime signal.
                'process.on("exit", () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));',
              ]
            : []),
          "await runWorkerProcess({ internalWorkerIpc: true, managed: true });",
        ].join("\n"),
      );
      const { connectionEndpoint, ...plan } = launch;
      const input = {
        environmentSession: 1,
        launchId: launch.assignment.turnId,
        gatewayNamespace: "worker-lifetime",
        expectedBundleHash: BUNDLE_HASH,
        descriptor: plan,
        placementGeneration: 1,
      } satisfies NodeWorkerLaunchInput;
      let capacity = { total: 1, available: 0 };
      const supervisorOptions = {
        bundleRoot: root,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          OPENCLAW_STATE_DIR: path.join(workspaceDir, "node-state"),
        },
        capacity: 1,
      };
      const supervisor = createNodeWorkerSupervisor({
        ...supervisorOptions,
        onCapacityChanged: (next) => {
          capacity = next;
        },
      });
      let command: NodeWorkerProcessIdentity | undefined;
      let runtime: NodeWorkerProcessIdentity | undefined;
      let runtimeStopped = false;
      let pendingCleanupObserved = false;
      let nodeHost: ChildProcess | undefined;
      let caseFailure: { error: unknown } | undefined;
      try {
        let running: NodeWorkerLaunchReceipt;
        if (crashed !== "node-host") {
          running = await supervisor.launch(input, connectionEndpoint);
        } else {
          const entry = path.join(workspaceDir, "node-supervisor.mjs");
          await writeFile(
            entry,
            [
              `await import(${JSON.stringify(new URL("../../scripts/tsx.mjs", import.meta.url).href)});`,
              `const { createNodeWorkerSupervisor } = await import(${JSON.stringify(new URL("../node-host/node-worker-supervisor.ts", import.meta.url).href)});`,
              `const supervisor = createNodeWorkerSupervisor({ ...${JSON.stringify(supervisorOptions)}, onCapacityChanged: (capacity) => process.send?.({ type: "capacity", capacity }) });`,
              'process.once("SIGTERM", () => { void supervisor.close().then(() => process.exit(0)); });',
              `const receipt = await supervisor.launch(${JSON.stringify(input)}, ${JSON.stringify(connectionEndpoint)});`,
              'process.send?.({ type: "receipt", receipt });',
              "setInterval(() => {}, 1000);",
            ].join("\n"),
          );
          nodeHost = spawn(process.execPath, [entry], {
            env: supervisorOptions.env,
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          });
          const admitted = createDeferred<NodeWorkerLaunchReceipt>();
          nodeHost.once("error", admitted.reject);
          nodeHost.on("message", (message: unknown) => {
            if (!isRecord(message)) {
              return;
            }
            if (message.type === "capacity" && isRecord(message.capacity)) {
              expect(message.capacity).toMatchObject({ total: 1 });
              capacity = { total: 1, available: Number(message.capacity.available) };
            } else if (message.type === "receipt") {
              // SAFETY: the owned fixture sends its canonical supervisor.launch result over IPC.
              admitted.resolve(message.receipt as NodeWorkerLaunchReceipt);
            }
          });
          running = await withTestTimeout(
            admitted.promise,
            WORKER_INFERENCE_START_TIMEOUT_MS,
            "node supervisor did not admit the registered-exec fixture",
          );
        }
        expect(running.state).toBe("running");
        const worker = running.worker!;
        await waitForFast(
          async () => {
            runtime = requireNodeWorkerProcessIdentity(
              Number(await readFile(path.join(workspaceDir, "runtime.pid"), "utf8")),
            );
            command = requireNodeWorkerProcessIdentity(
              Number(await readFile(path.join(workspaceDir, "exec.pid"), "utf8")),
            );
            expect(await readFile(path.join(workspaceDir, "heartbeat.txt"), "utf8")).toContain(
              "tick\n",
            );
            const turn =
              crashed !== "node-host"
                ? await supervisor.status(input.launchId)
                : new NodeWorkerTurnStore({ env: supervisorOptions.env }).get(input.launchId);
            expect(turn?.state).toBe("completed");
          },
          { timeout: WORKER_INFERENCE_START_TIMEOUT_MS },
        );
        expect(
          gateway.acceptedTranscriptRequests
            .flatMap((request) => request.messages)
            .filter((message) => message.role === "toolResult" && message.toolName === "exec"),
        ).toHaveLength(1);
        expect(capacity).toEqual({ total: 1, available: 0 });
        expect(inspectNodeWorkerProcessIdentity(command!)).toBe("live");

        if (crashed === "environment-stop") {
          await supervisor.stopEnvironment({
            gatewayNamespace: input.gatewayNamespace,
            environmentId: plan.admission.environmentId,
            sessionId: plan.admission.sessionId,
            ownerEpoch: plan.admission.ownerEpoch,
          });
        } else if (nodeHost) {
          const exited = once(nodeHost, "exit");
          nodeHost.kill("SIGKILL");
          await exited;
          await supervisor.initialize();
        } else {
          if (crashed === "anchor") {
            process.kill(runtime!.pid, "SIGSTOP");
            runtimeStopped = true;
          }
          process.kill(crashed === "anchor" ? worker.pid : runtime!.pid, "SIGKILL");
        }
        await waitForFast(
          async () => {
            if (crashed === "anchor") {
              try {
                await supervisor.status(input.launchId);
              } catch (error) {
                expect(String(error)).toContain("cleanup remains unconfirmed");
                expect(capacity.available).toBe(0);
                if (!pendingCleanupObserved) {
                  expect(inspectNodeWorkerProcessIdentity(command!)).toBe("live");
                  pendingCleanupObserved = true;
                  process.kill(runtime!.pid, "SIGCONT");
                  runtimeStopped = false;
                }
              }
            }
            expect({ available: capacity.available, pendingCleanupObserved }).toEqual({
              available: 1,
              pendingCleanupObserved: crashed === "anchor",
            });
          },
          { timeout: 10_000 },
        );
        expect({
          worker: inspectNodeWorkerProcessIdentity(worker),
          runtime: inspectNodeWorkerProcessIdentity(runtime!),
          command: inspectNodeWorkerProcessIdentity(command!),
        }).toEqual({ worker: "dead", runtime: "dead", command: "dead" });
      } catch (error) {
        caseFailure = { error };
      } finally {
        try {
          if (runtimeStopped && runtime && inspectNodeWorkerProcessIdentity(runtime) === "live") {
            process.kill(runtime.pid, "SIGCONT");
          }
          if (runtime && inspectNodeWorkerProcessIdentity(runtime) === "live") {
            process.kill(runtime.pid, "SIGKILL");
          }
          if (nodeHost) {
            await stopChildProcess(nodeHost, 5_000);
          }
          if (command) {
            if (inspectNodeWorkerProcessIdentity(command) === "live") {
              process.kill(command.pid, "SIGKILL");
            }
            await waitForFast(() =>
              expect(inspectNodeWorkerProcessIdentity(command!)).toBe("dead"),
            );
          }
          try {
            await waitForFast(
              async () =>
                await supervisor.stopEnvironment({
                  gatewayNamespace: input.gatewayNamespace,
                  environmentId: plan.admission.environmentId,
                  sessionId: plan.admission.sessionId,
                  ownerEpoch: plan.admission.ownerEpoch,
                }),
              { timeout: 10_000 },
            );
          } finally {
            await supervisor.close();
          }
        } catch (cleanupError) {
          caseFailure = {
            error: caseFailure
              ? new AggregateError(
                  [caseFailure.error, cleanupError],
                  "registered worker fault and cleanup failed",
                  { cause: cleanupError },
                )
              : cleanupError,
          };
        }
      }
      if (caseFailure) {
        throw caseFailure.error;
      }
    },
  );

  it("joins retained background processes before closing the managed owner on EOF", async () => {
    const { launch } = await setup({ inferencePlans: ["background-tool", "text"] });
    const input = new PassThrough();
    const output = new PassThrough();
    const result = createDeferred<WorkerProcessResult>();
    output.on("data", (chunk: Buffer) => {
      const parsed = parseWorkerProcessResult(JSON.parse(chunk.toString("utf8")));
      if (parsed) {
        result.resolve(parsed);
      }
    });
    const command = runWorkerCommand({ managed: true, input, output });
    const scopeKey = `worker:${SESSION_ID}`;
    const supervisor = getProcessSupervisor();
    try {
      input.write(
        `${JSON.stringify({ type: "turn", turnId: launch.assignment.turnId, descriptor: launch })}\n`,
      );
      await expect(result.promise).resolves.toMatchObject({ retainWorker: true });
      const running = listRunningSessions().filter((session) => session.scopeKey === scopeKey);
      expect(running).toHaveLength(1);
      const pid = running[0]!.pid!;
      expect(pid).toBeGreaterThan(0);
      input.end();
      await command;
      expect(() => process.kill(pid, 0)).toThrow();
      expect(listRunningSessions().filter((session) => session.scopeKey === scopeKey)).toHaveLength(
        0,
      );
    } finally {
      input.end();
      try {
        await command;
      } finally {
        supervisor.cancelScope(scopeKey, "manual-cancel");
        await waitForExecScope(scopeKey);
      }
    }
  });
}
