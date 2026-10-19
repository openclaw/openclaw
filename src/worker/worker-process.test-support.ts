import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withinTest } from "../../test/helpers/promise.js";
import { resolveRuntimeWorkerUrl, resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import { createCompiledSdkHost } from "../plugins/compiled-sdk-host.test-support.js";
import { prepareSecretInputStdio, type SpawnStdioEntry } from "../process/spawn-secret-input.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import {
  WORKER_NATIVE_INFERENCE_STARTUP_ARG,
  WORKER_NATIVE_INFERENCE_STARTUP_FD,
  type NativeInferenceStartup,
} from "./native-inference-startup.js";
import { nativeWorkerTestEntrypoint } from "./native-worker-entrypoints.test-support.js";
import { serializeWorkerProcessInput } from "./worker-process-protocol.js";
import { workerBackgroundExecEntrypoints } from "./worker-runtime-background-exec-entrypoints.test-support.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureEntry = resolveRuntimeWorkerUrl(nativeWorkerTestEntrypoint);
export type WorkerProcessTestExit = { code: number | null; stdout: string; stderr: string };

/** Real worker commands own process-local state and event registries, apart from their Gateway. */
export function createWorkerProcessTestHarness(makeTempDir: (prefix: string) => string) {
  const children: Array<(signal: AbortSignal) => Promise<void>> = [];
  let lastPid: number | undefined;
  const launch = async ({
    descriptor,
    startup,
    signal,
    diagnostics,
  }: {
    descriptor: WorkerLaunchDescriptor;
    startup?: NativeInferenceStartup;
    signal: AbortSignal;
    diagnostics?: () => Record<string, unknown>;
  }) => {
    const sdkHost = createCompiledSdkHost(
      [
        workerBackgroundExecEntrypoints.providerModelMetadata,
        workerBackgroundExecEntrypoints.stringCoerceRuntime,
      ],
      (prefix) => makeTempDir(prefix),
      { mode: "link" },
    );
    const home = makeTempDir("oc-native-child-");
    const temp = path.join(home, "tmp");
    await mkdir(temp);
    const stdio: ["pipe", "pipe", "pipe", ...SpawnStdioEntry[]] = ["pipe", "pipe", "pipe"];
    using secretDelivery = prepareSecretInputStdio(
      stdio,
      startup
        ? {
            fd: WORKER_NATIVE_INFERENCE_STARTUP_FD,
            createData: () => Buffer.from(JSON.stringify(startup)),
          }
        : undefined,
    );
    const child = spawn(
      process.execPath,
      [
        "--unhandled-rejections=strict",
        ...resolveRuntimeWorkerArgv(fixtureEntry),
        ...(startup ? [WORKER_NATIVE_INFERENCE_STARTUP_ARG] : []),
      ],
      {
        cwd: repoRoot,
        // Deliberately do not inherit provider keys, proxy settings, NODE_OPTIONS, or live state.
        env: {
          // Compiled fixture keeps synchronous exec helpers out of the TS loader.
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          HOME: home,
          USERPROFILE: home,
          TMPDIR: temp,
          TMP: temp,
          TEMP: temp,
          OPENCLAW_STATE_DIR: path.join(home, "state"),
          OPENCLAW_CONFIG_PATH: path.join(home, "config.json"),
          ...(sdkHost
            ? {
                OPENCLAW_DEV_SOURCE_ROOT: sdkHost,
                OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(repoRoot, "extensions"),
              }
            : {}),
        },
        stdio,
      },
    );
    lastPid = child.pid;
    const { stdin, stdout: childOutput, stderr: childError } = child;
    if (!stdin || !childOutput || !childError) {
      child.kill("SIGKILL");
      throw new Error("Native worker fixture requires all three control/output pipes");
    }
    let stdout = "";
    let stderr = "";
    childOutput.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    childError.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<WorkerProcessTestExit>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
    // A spawn failure must remain observed even when a provider-readiness assertion fails first.
    void exited.catch(() => undefined);
    const close = async (cleanupSignal: AbortSignal) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        try {
          await withinTest(exited, cleanupSignal);
        } catch {
          child.kill("SIGKILL");
          await exited;
        }
      } else {
        await exited;
      }
    };
    children.push(close);
    await secretDelivery?.deliverTo(child);
    stdin.write(
      serializeWorkerProcessInput({
        type: "turn",
        turnId: descriptor.assignment.turnId,
        descriptor,
      }),
    );
    return {
      child,
      exited,
      close,
      cancel: () =>
        stdin.write(
          serializeWorkerProcessInput({ type: "cancel", turnId: descriptor.assignment.turnId }),
        ),
      finish: async () => {
        try {
          return await withinTest(exited, signal);
        } catch (error) {
          throw new Error(
            JSON.stringify({
              error: String(error),
              stdout,
              stderr,
              ...diagnostics?.(),
            }),
            { cause: error },
          );
        }
      },
    };
  };
  return {
    launch,
    lastPid: () => lastPid,
    close: async (signal: AbortSignal) => {
      const settled = await Promise.allSettled(children.splice(0).map((close) => close(signal)));
      const errors = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, "Worker fixture cleanup failed");
      }
    },
  };
}
