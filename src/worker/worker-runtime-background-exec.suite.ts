import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { WorkerTranscriptCommitParams } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { listRunningSessions, waitForExecScope } from "../agents/bash-process-registry.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { NodeWorkerJournalWorker } from "../node-host/node-worker-journal-worker.js";
import type { NodeWorkerLaunchReceipt } from "../node-host/node-worker-launch-store.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "../node-host/node-worker-process-identity.js";
import { createNodeWorkerSupervisor } from "../node-host/node-worker-supervisor.js";
import { NodeWorkerTurnStore } from "../node-host/node-worker-turn-store.js";
import { createCompiledSdkHost } from "../plugins/compiled-sdk-host.test-support.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import type { NodeWorkerLaunchInput } from "./node-supervisor-protocol.js";
import { runWorkerCommand } from "./worker-command.runtime.js";
import { parseWorkerProcessResult, type WorkerProcessResult } from "./worker-process-protocol.js";
import { workerBackgroundExecEntrypoints } from "./worker-runtime-background-exec-entrypoints.test-support.js";

const workerProcessUrl = resolveRuntimeWorkerUrl(workerBackgroundExecEntrypoints.worker);
const supervisorUrl = resolveRuntimeWorkerUrl(workerBackgroundExecEntrypoints.supervisor);
const moduleLoaderUrl = resolveRuntimeWorkerUrl(workerBackgroundExecEntrypoints.moduleLoader);
const sdkEntrypoints = [
  workerBackgroundExecEntrypoints.providerModelMetadata,
  workerBackgroundExecEntrypoints.stringCoerceRuntime,
] as const;

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
      const sdkHost = createCompiledSdkHost(
        sdkEntrypoints,
        (prefix) => {
          const directory = path.join(workspaceDir, prefix);
          mkdirSync(directory);
          return directory;
        },
        { mode: "link" },
      );
      if (sdkHost) {
        expect(realpathSync(path.join(sdkHost, "dist"))).toBe(
          realpathSync(path.dirname(path.dirname(fileURLToPath(workerProcessUrl)))),
        );
      }
      const sdkWitness = path.join(workspaceDir, "native-sdk.json");
      const expectedSdkModules = sdkEntrypoints.map((entry) =>
        realpathSync(fileURLToPath(resolveRuntimeWorkerUrl(entry))),
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
          'import { createRequire } from "node:module";',
          "globalThis.WORKER_DEPLOY_BUILD = true;",
          `process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = ${JSON.stringify(path.resolve("extensions"))};`,
          ...(sdkHost
            ? [
                `process.env.OPENCLAW_DEV_SOURCE_ROOT = ${JSON.stringify(sdkHost)};`,
                // A built checkout also carries dist/extensions; the witness proves the
                // source policy transform against the selected host's SDK graph.
                `process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = ${JSON.stringify(path.resolve("extensions"))};`,
              ]
            : []),
          ...(workerProcessUrl.pathname.endsWith(".ts")
            ? [
                `await import(${JSON.stringify(new URL("../../scripts/tsx.mjs", import.meta.url).href)});`,
              ]
            : []),
          `const { runWorkerProcess } = await import(${JSON.stringify(workerProcessUrl.href)});`,
          `const { getPluginModuleLoaderStats } = await import(${JSON.stringify(moduleLoaderUrl.href)});`,
          "const nativeRequire = createRequire(import.meta.url);",
          `const sdkTargets = new Set(${JSON.stringify(expectedSdkModules)});`,
          "const write = process.stdout.write.bind(process.stdout);",
          "process.stdout.write = (chunk, ...args) => {",
          "  let frame;",
          "  try { frame = JSON.parse(chunk.toString()); } catch {}",
          '  if (frame?.type === "result") {',
          `    writeFileSync(${JSON.stringify(sdkWitness)}, JSON.stringify({`,
          "      policyTargets: getPluginModuleLoaderStats().topSourceTransformTargets.map(({ target }) => target),",
          "      sdkModules: Object.keys(nativeRequire.cache).filter((file) => sdkTargets.has(file)),",
          "    }));",
          "  }",
          "  return write(chunk, ...args);",
          "};",
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
      const recordFailure = (error: unknown) => {
        caseFailure = {
          error: caseFailure
            ? new AggregateError(
                [caseFailure.error, error],
                "registered worker fault and cleanup failed",
                { cause: error },
              )
            : error,
        };
      };
      try {
        let running: NodeWorkerLaunchReceipt;
        if (crashed !== "node-host") {
          running = await supervisor.launch(input, connectionEndpoint);
        } else {
          const entry = path.join(workspaceDir, "node-supervisor.mjs");
          await writeFile(
            entry,
            [
              ...(supervisorUrl.pathname.endsWith(".ts")
                ? [
                    `await import(${JSON.stringify(new URL("../../scripts/tsx.mjs", import.meta.url).href)});`,
                  ]
                : []),
              `const { createNodeWorkerSupervisor } = await import(${JSON.stringify(supervisorUrl.href)});`,
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
                : await new NodeWorkerTurnStore(
                    new NodeWorkerJournalWorker({ env: supervisorOptions.env }),
                  ).get(input.launchId);
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
        expect(JSON.parse(await readFile(sdkWitness, "utf8"))).toMatchObject({
          policyTargets: expect.arrayContaining([
            path.resolve("extensions/openai/provider-policy-api.ts"),
          ]),
          sdkModules: expect.arrayContaining(expectedSdkModules),
        });
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
        recordFailure(error);
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
        } catch (cleanupError) {
          recordFailure(cleanupError);
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
        } catch (cleanupError) {
          recordFailure(cleanupError);
        }
        try {
          await supervisor.close();
        } catch (cleanupError) {
          recordFailure(cleanupError);
        }
        try {
          await closeOpenClawStateDatabaseByPathAsync(
            resolveOpenClawStateSqlitePath(supervisorOptions.env),
          );
        } catch (cleanupError) {
          recordFailure(cleanupError);
        }
      }
      if (caseFailure) {
        throw caseFailure.error;
      }
    },
  );

  it("joins retained background processes before closing the managed owner on EOF", async ({
    signal,
  }) => {
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
      await expect(racePromiseWithAbortSignal(result.promise, signal)).resolves.toMatchObject({
        retainWorker: true,
      });
      const running = listRunningSessions().filter((session) => session.scopeKey === scopeKey);
      expect(running).toHaveLength(1);
      const pid = running[0]!.pid!;
      expect(pid).toBeGreaterThan(0);
      input.end();
      await racePromiseWithAbortSignal(command, signal);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(listRunningSessions().filter((session) => session.scopeKey === scopeKey)).toHaveLength(
        0,
      );
    } finally {
      input.end();
      supervisor.cancelScope(scopeKey, "manual-cancel");
      try {
        await command;
      } finally {
        await waitForExecScope(scopeKey);
      }
    }
  });
}
