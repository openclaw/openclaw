import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerLiveEventParams } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { resolveRuntimeWorkerUrl, resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import { snapshotNodeWorkerNativeInference } from "../node-host/node-worker-native-inference.js";
import { createCompiledSdkHost } from "../plugins/compiled-sdk-host.test-support.js";
import { prepareSecretInputStdio, type SpawnStdioEntry } from "../process/spawn-secret-input.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import {
  projectNativeInferenceStartup,
  WORKER_NATIVE_INFERENCE_STARTUP_ENV,
  WORKER_NATIVE_INFERENCE_STARTUP_FD,
  type NativeInferenceStartup,
} from "./native-inference-startup.js";
import { nativeWorkerTestEntrypoint } from "./native-worker-entrypoints.test-support.js";
import { ComposedGatewayHarness, SESSION_ID } from "./worker-fault-injection.test-support.js";
import {
  parseWorkerProcessResult,
  serializeWorkerProcessInput,
} from "./worker-process-protocol.js";
import { workerBackgroundExecEntrypoints } from "./worker-runtime-background-exec-entrypoints.test-support.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureEntry = resolveRuntimeWorkerUrl(nativeWorkerTestEntrypoint);
// External proxy auth is opaque, even when it resembles another process's sentinel.
const LOCAL_KEY = "oc-sent-v2." + "A".repeat(48) + ".end";
const MODEL = { provider: "openai", model: "local-worker-model" };
const children: Array<{ child: ChildProcess; exited: Promise<ProcessExit> }> = [];
const servers: Server[] = [];
let gateway: ComposedGatewayHarness | undefined;
type ProcessExit = { code: number | null; stdout: string; stderr: string };

// Join child/transport lifetimes before the shared tracker removes their homes.
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      for (const { child, exited } of children.splice(0)) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          try {
            await withTestTimeout(exited, 5_000, "worker did not stop during cleanup");
          } catch {
            child.kill("SIGKILL");
            await exited;
          }
        }
      }
      for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await gateway?.close();
      gateway = undefined;
    } finally {
      cleanup();
    }
  }),
);

function owner(): ComposedGatewayHarness {
  if (!gateway) {
    throw new Error("Gateway fixture was not initialized");
  }
  return gateway;
}

function messages() {
  return SessionManager.open(owner().sessionTarget)
    .getEntries()
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

async function localDescriptor(): Promise<WorkerLaunchDescriptor> {
  const descriptor = await owner().createDescriptor();
  descriptor.assignment.inference = "runtime-local";
  descriptor.assignment.modelRef = MODEL;
  descriptor.assignment.inferenceOptions = { reasoning: "low" };
  descriptor.assignment.toolAuthority.exec = { host: "gateway", security: "full", ask: "off" };
  descriptor.assignment.permissionMode = "full";
  descriptor.assignment.workerContainmentRoot = descriptor.assignment.workspaceDir;
  return descriptor;
}

function startupFor(descriptor: WorkerLaunchDescriptor, baseUrl: string): NativeInferenceStartup {
  return {
    credentials: { WORKER_TEST_PROVIDER_KEY: LOCAL_KEY },
    config: {
      models: [
        {
          provider: MODEL.provider,
          id: MODEL.model,
          api: "openai-completions",
          baseUrl,
          contextWindow: 32768,
          maxTokens: 173,
          reasoning: true,
          thinkingLevelMap: { low: "low", high: null },
          cost: { input: 2, output: 7, cacheRead: 0.5, cacheWrite: 3 },
          apiKeyEnv: "WORKER_TEST_PROVIDER_KEY",
          headers: { "x-local-registry": "worker-startup" },
        },
      ],
      workspaces: [
        {
          id: descriptor.assignment.agentId,
          path: descriptor.assignment.workspaceDir,
          sessionId: descriptor.admission.sessionId,
          models: [MODEL.provider + "/" + MODEL.model],
        },
      ],
    },
  };
}

async function launch(descriptor: WorkerLaunchDescriptor, startup?: NativeInferenceStartup) {
  const sdkHost = createCompiledSdkHost(
    [
      workerBackgroundExecEntrypoints.providerModelMetadata,
      workerBackgroundExecEntrypoints.stringCoerceRuntime,
    ],
    (prefix) => tempDirs.make(prefix),
    { mode: "link" },
  );
  const home = tempDirs.make("oc-native-child-");
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
    ["--unhandled-rejections=strict", ...resolveRuntimeWorkerArgv(fixtureEntry)],
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
        ...(startup
          ? { [WORKER_NATIVE_INFERENCE_STARTUP_ENV]: String(WORKER_NATIVE_INFERENCE_STARTUP_FD) }
          : {}),
      },
      stdio,
    },
  );
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
  const exited = new Promise<ProcessExit>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  // A spawn failure must remain observed even when a provider-readiness assertion fails first.
  void exited.catch(() => undefined);
  children.push({ child, exited });
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
    cancel: () =>
      stdin.write(
        serializeWorkerProcessInput({ type: "cancel", turnId: descriptor.assignment.turnId }),
      ),
    finish: async () => {
      try {
        return await withTestTimeout(exited, 30_000, "worker process did not finish");
      } catch (error) {
        throw new Error(
          JSON.stringify({
            error: String(error),
            stdout,
            stderr,
            admissions: owner().admissions.length,
            methods: owner().requests.map((request) => request.method),
            transcript: messages().map((message) =>
              message.role === "assistant"
                ? {
                    role: message.role,
                    stopReason: message.stopReason,
                    errorMessage: message.errorMessage,
                  }
                : { role: message.role },
            ),
          }),
          { cause: error },
        );
      }
    },
  };
}

function result(exit: ProcessExit) {
  expect(exit.code, exit.stderr).toBe(0);
  const lines = exit.stdout.trim().split("\n");
  expect(lines, exit.stderr).toHaveLength(1);
  const parsed = parseWorkerProcessResult(JSON.parse(lines[0]!));
  expect(parsed, exit.stderr).not.toBeNull();
  return parsed!;
}

type HttpRequest = { headers: IncomingHttpHeaders; body: Record<string, unknown>; url?: string };
async function providerFixture(mode: "tools" | "pending" = "tools") {
  const requests: HttpRequest[] = [];
  const entered = createDeferred();
  const disconnected = createDeferred();
  let held: ServerResponse | undefined;
  const errors: unknown[] = [];
  const frame = (response: ServerResponse, delta: object, finish: string | null = null) => {
    response.write(
      "data: " +
        JSON.stringify({
          id: "local-worker-response",
          object: "chat.completion.chunk",
          created: 1,
          model: MODEL.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(finish
            ? { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }
            : {}),
        }) +
        "\n\n",
    );
  };
  const complete = (response: ServerResponse) => {
    frame(response, { role: "assistant", content: "Local worker completed." });
    frame(response, {}, "stop");
    response.end("data: [DONE]\n\n");
  };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      requests.push({
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()),
        url: request.url,
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (mode === "pending") {
        held = response;
        response.flushHeaders();
        response.once("close", () => disconnected.resolve());
        entered.resolve();
        return;
      }
      entered.resolve();
      if (requests.length === 1) {
        const command =
          JSON.stringify(process.execPath) +
          " " +
          JSON.stringify(path.join(owner().root, "tool-proof.mjs")) +
          " " +
          children.at(-1)!.child.pid;
        frame(response, {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "local-exec",
              type: "function",
              function: { name: "exec", arguments: JSON.stringify({ command, yieldMs: 10000 }) },
            },
          ],
        });
        frame(response, {}, "tool_calls");
        response.end("data: [DONE]\n\n");
      } else if (requests.length === 2) {
        frame(response, {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "local-read",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({ path: path.join(owner().root, "tool-proof.json") }),
              },
            },
          ],
        });
        frame(response, {}, "tool_calls");
        response.end("data: [DONE]\n\n");
      } else {
        complete(response);
      }
    })().catch((error: unknown) => {
      errors.push(error);
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected loopback TCP provider");
  }
  return {
    requests,
    errors,
    entered: entered.promise,
    disconnected: disconnected.promise,
    baseUrl: "http://127.0.0.1:" + address.port + "/v1",
    release: () => {
      if (held && !held.destroyed) {
        complete(held);
      }
    },
  };
}

function expectNoProxyInference() {
  expect(
    owner().requests.filter((request) => request.method.startsWith("worker.inference.")),
  ).toEqual([]);
  expect(owner().providerCalls).toBe(0);
}

// The shared real-service fixture uses Unix-domain admission, not a fake hello/commit ack.
describe.skipIf(process.platform === "win32")(
  "native inference through an actual worker process",
  () => {
    beforeEach(async () => {
      gateway = await ComposedGatewayHarness.create(tempDirs.make("oc-native-gw-"));
      await gateway.start();
    });

    it("uses private startup model/auth, executes local tools, and durably commits their transcript", async () => {
      const provider = await providerFixture();
      const descriptor = await localDescriptor();
      await writeFile(
        path.join(owner().root, "tool-proof.mjs"),
        'import { readFileSync, writeFileSync } from "node:fs";\n' +
          "const ancestors = []; let pid = process.ppid;\n" +
          'if (process.platform === "linux") { while (pid > 1 && ancestors.length < 20) { ancestors.push(pid); const stat = readFileSync("/proc/" + pid + "/stat", "utf8"); pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]); } }\n' +
          "const workerPid = Number(process.argv[2]);\n" +
          'if (!Number.isSafeInteger(workerPid) || workerPid <= 1) throw new Error("Missing owned worker PID");\n' +
          'const initialStartup = process.platform === "linux" ? readFileSync("/proc/" + workerPid + "/environ", "utf8").split(String.fromCharCode(0)).find((entry) => entry.startsWith("OPENCLAW_WORKER_NATIVE_INFERENCE_STARTUP=")) : undefined;\n' +
          'const proof = { pid: process.pid, ancestors, startupPresent: "OPENCLAW_WORKER_NATIVE_INFERENCE_STARTUP" in process.env, credentialPresent: "WORKER_TEST_PROVIDER_KEY" in process.env, initialCarrierHasCredentials: initialStartup?.includes("credentials") ?? false };\n' +
          'writeFileSync(new URL("./tool-proof.json", import.meta.url), JSON.stringify(proof)); console.log("worker tool wrote proof");\n',
      );
      const registry = startupFor(descriptor, provider.baseUrl);
      registry.config.models.push({
        ...registry.config.models[0]!,
        id: "other-worker-model",
        apiKeyEnv: "OTHER_WORKER_KEY",
      });
      const configPath = path.join(owner().root, "native-grants.json");
      await writeFile(configPath, JSON.stringify(registry.config), { mode: 0o600 });
      const captured = snapshotNodeWorkerNativeInference(configPath, {
        WORKER_TEST_PROVIDER_KEY: LOCAL_KEY,
        OTHER_WORKER_KEY: "synthetic-other-worker-key",
      })!;
      const projected = projectNativeInferenceStartup(captured, descriptor);
      expect(projected.config.models.map(({ id }) => id)).toEqual([MODEL.model]);
      expect(projected.credentials).toEqual({ WORKER_TEST_PROVIDER_KEY: LOCAL_KEY });
      const worker = await launch(descriptor, projected);
      const outcome = result(await worker.finish());
      expect(outcome).toMatchObject({
        type: "result",
        retainWorker: false,
        result: { status: "completed" },
      });
      expect(worker.child.pid).not.toBe(process.pid);
      const proof = JSON.parse(await readFile(path.join(owner().root, "tool-proof.json"), "utf8"));
      expect(proof).toMatchObject({
        startupPresent: false,
        credentialPresent: false,
        initialCarrierHasCredentials: false,
      });
      expect(proof.pid).not.toBe(process.pid);
      expect(proof.pid).not.toBe(worker.child.pid);
      if (process.platform === "linux") {
        expect(proof.ancestors).toContain(worker.child.pid);
      }
      expect(provider.errors).toEqual([]);
      expect(provider.requests).toHaveLength(3);
      for (const request of provider.requests) {
        expect(request.url).toBe("/v1/chat/completions");
        expect(request.headers.authorization).toBe("Bearer " + LOCAL_KEY);
        expect(request.headers["x-local-registry"]).toBe("worker-startup");
        expect(request.body).toMatchObject({
          model: MODEL.model,
          max_completion_tokens: 173,
          reasoning_effort: "low",
        });
      }
      expect(JSON.stringify(provider.requests[2]!.body.messages)).toContain("startupPresent");
      expectNoProxyInference();
      expect(owner().admissions).toHaveLength(1);
      const transcript = messages();
      expect(transcript.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
        "assistant",
        "toolResult",
        "assistant",
      ]);
      expect(transcript.filter((message) => message.role === "toolResult")).toEqual([
        expect.objectContaining({ toolName: "exec", isError: false }),
        expect.objectContaining({ toolName: "read", isError: false }),
      ]);
      expect(transcript.at(-1)).toMatchObject({
        role: "assistant",
        provider: MODEL.provider,
        model: MODEL.model,
        api: "openai-completions",
        content: [{ type: "text", text: "Local worker completed." }],
        stopReason: "stop",
        usage: {
          input: 10,
          output: 3,
          cost: { input: expect.closeTo(0.00002, 10), output: expect.closeTo(0.000021, 10) },
        },
      });
      expect(outcome.result).toMatchObject({
        transcriptLeafId: SessionManager.open(owner().sessionTarget).getLeafId(),
      });
      expect(JSON.stringify(provider.requests)).not.toContain("synthetic-other-worker-key");
      expect(JSON.stringify(owner().requests)).not.toContain(LOCAL_KEY);
      expect(JSON.stringify(transcript)).not.toContain(LOCAL_KEY);
    }, 40_000);

    it.each([
      "missing registry",
      "missing model grant",
      "unknown model grant",
      "ungranted model",
      "wrong agent",
      "wrong workspace",
      "wrong session",
      "denied model",
    ] as const)(
      "rejects %s before provider HTTP or Gateway admission",
      async (scenario) => {
        const provider = await providerFixture();
        const descriptor = await localDescriptor();
        const startup = startupFor(descriptor, provider.baseUrl);
        startup.config.models.push({
          ...startup.config.models[0]!,
          id: "other-worker-model",
          apiKeyEnv: "OTHER_WORKER_KEY",
        });
        startup.credentials.OTHER_WORKER_KEY = "synthetic-other-worker-key";
        const grant = startup.config.workspaces[0]!;
        if (scenario === "missing model grant") {
          // Deliberately malformed carrier bypasses the node parser to prove worker admission.
          Reflect.deleteProperty(grant, "models");
        }
        if (scenario === "unknown model grant") {
          grant.models = [MODEL.provider + "/" + MODEL.model, "missing/model"];
        }
        if (scenario === "ungranted model") {
          descriptor.assignment.modelRef = {
            ...descriptor.assignment.modelRef,
            model: "other-worker-model",
          };
        }
        if (scenario === "wrong agent") {
          grant.id = "other-agent";
        }
        if (scenario === "wrong workspace") {
          grant.path = path.dirname(grant.path);
        }
        if (scenario === "wrong session") {
          grant.sessionId = SESSION_ID + "-other";
        }
        if (scenario === "denied model") {
          grant.models = [];
        }
        const worker = await launch(
          descriptor,
          scenario === "missing registry" ? undefined : startup,
        );
        const exit = await worker.finish();
        expect({
          code: exit.code,
          httpRequests: provider.requests.length,
          admissions: owner().admissions.length,
        }).toEqual({ code: 1, httpRequests: 0, admissions: 0 });
        expect(exit.stderr).toContain(
          scenario === "missing registry"
            ? "no node-local registry"
            : scenario === "missing model grant" || scenario === "unknown model grant"
              ? "Invalid node-local inference startup configuration"
              : "not authorized",
        );
        expect(provider.requests).toEqual([]);
        expect(owner().admissions).toEqual([]);
        expect(messages()).toEqual([]);
        expectNoProxyInference();
      },
      40_000,
    );

    it("rejects unsupported local reasoning before provider HTTP", async () => {
      const provider = await providerFixture();
      const descriptor = await localDescriptor();
      descriptor.assignment.inferenceOptions = {
        ...descriptor.assignment.inferenceOptions,
        reasoning: "high",
      };
      const worker = await launch(descriptor, startupFor(descriptor, provider.baseUrl));
      const exit = await worker.finish();
      expect(exit.code).toBe(1);
      expect(exit.stderr).toContain("thinking level is not supported");
      expect(provider.requests).toEqual([]);
      expectNoProxyInference();
    }, 40_000);

    it("cancels pending native HTTP and settles without submitting new transcript messages", async () => {
      const provider = await providerFixture("pending");
      const descriptor = await localDescriptor();
      const worker = await launch(descriptor, startupFor(descriptor, provider.baseUrl));
      await withTestTimeout(provider.entered, 30_000, "local provider was not reached");
      const before = messages();
      const commitsBefore = owner().requestParams("worker.transcript.commit").length;
      expect(before.map((message) => message.role)).toEqual(["user"]);
      worker.cancel();
      const outcome = result(await worker.finish());
      expect(outcome.result).toMatchObject({ status: "failed", reason: "turn-failed" });
      await withTestTimeout(provider.disconnected, 5_000, "cancel did not close provider HTTP");
      expect(provider.requests).toHaveLength(1);
      expect(messages()).toEqual(before);
      expect(owner().requestParams("worker.transcript.commit")).toHaveLength(commitsBefore);
      const finishing = owner()
        .requestParams("worker.live-event")
        .map((request) => request as WorkerLiveEventParams)
        .filter(({ event }) => event.kind === "lifecycle" && event.payload.phase === "finishing");
      expect(finishing).toHaveLength(1);
      expect(finishing[0]?.event).toMatchObject({
        kind: "lifecycle",
        payload: { phase: "finishing", aborted: true, stopReason: "aborted" },
      });
      expect(owner().placementStore.get(SESSION_ID)?.lastLiveEventAckCursor).toBe(
        finishing[0]!.seq,
      );
      expectNoProxyInference();
    }, 40_000);

    it("closes native provider HTTP during a held Gateway outage before revoked placement can readmit", async () => {
      const provider = await providerFixture("pending");
      const descriptor = await localDescriptor();
      const worker = await launch(descriptor, startupFor(descriptor, provider.baseUrl));
      await withTestTimeout(provider.entered, 30_000, "local provider was not reached");
      const admitted = owner().admissions.length;
      const before = messages();
      const resume = owner().pauseConnections();
      try {
        await owner().reclaimWithCredential(
          "synthetic-outage-replacement",
          "replacement-outage-run",
        );
        // This assertion precedes reopening admission, releasing HTTP, or stopping the child.
        await withTestTimeout(
          provider.disconnected,
          5_000,
          "native HTTP survived the held Gateway outage",
        );
        expect(owner().admissions).toHaveLength(admitted);
        expect(provider.requests).toHaveLength(1);
        expect(messages()).toEqual(before);
        expectNoProxyInference();
      } finally {
        resume();
      }
      const outcome = await worker.finish();
      expect(outcome.code).toBe(1);
      expect(provider.requests).toHaveLength(1);
    }, 40_000);

    it("fences a pending local producer after placement replacement without committing stale output", async () => {
      const provider = await providerFixture("pending");
      const descriptor = await localDescriptor();
      const worker = await launch(descriptor, startupFor(descriptor, provider.baseUrl));
      await withTestTimeout(provider.entered, 30_000, "local provider was not reached");
      const before = messages();
      const admitted = owner().admissions.length;
      const epoch = await owner().reclaimWithCredential(
        "synthetic-replacement-credential",
        "replacement-run",
      );
      expect(epoch).toBeGreaterThan(descriptor.admission.ownerEpoch);
      owner().partition();
      const outcome = await worker.finish();
      // Terminal flush can race rejected readmission; neither may revive provider authority.
      expect(outcome.code).toBe(1);
      expect(owner().admissions).toHaveLength(admitted);
      expect(provider.requests).toHaveLength(1);
      expect(outcome.stdout).toBe("");
      await withTestTimeout(provider.disconnected, 5_000, "fenced producer retained provider HTTP");
      provider.release();
      expect(messages()).toEqual(before);
      expectNoProxyInference();
    }, 40_000);

    it("keeps an unselected sibling Gateway-proxied even when local startup is provisioned", async () => {
      const provider = await providerFixture();
      const descriptor = await owner().createDescriptor();
      owner().providerPlan = { kind: "immediate", text: "Gateway-proxied sibling completed." };
      const worker = await launch(descriptor, startupFor(descriptor, provider.baseUrl));
      expect(result(await worker.finish()).result).toMatchObject({ status: "completed" });
      expect(owner().providerCalls).toBe(1);
      expect(owner().requestParams("worker.inference.start")).toHaveLength(1);
      expect(provider.requests).toEqual([]);
      expect(messages().at(-1)).toMatchObject({
        content: [{ type: "text", text: "Gateway-proxied sibling completed." }],
      });
    }, 40_000);
  },
);
