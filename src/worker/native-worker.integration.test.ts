import { readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerLiveEventParams } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import type { NativeInferenceStartup } from "./native-inference-startup.js";
import {
  closeNativeServers,
  expectNativeRequests,
  expectNoProxyInference,
  nativeProviderFixture,
} from "./native-worker.test-support.js";
import { ComposedGatewayHarness, SESSION_ID } from "./worker-fault-injection.test-support.js";
import { parseWorkerProcessMessage } from "./worker-process-protocol.js";
import {
  createWorkerProcessTestHarness,
  type WorkerProcessTestExit,
} from "./worker-process.test-support.js";

// External proxy auth is opaque, even when it resembles another process's sentinel.
const LOCAL_KEY = "oc-sent-v2." + "A".repeat(48) + ".end";
const MODEL = { provider: "openai", model: "local-worker-model" };
const servers: Server[] = [];
let gateway: ComposedGatewayHarness | undefined;
let activeTestSignal: AbortSignal;

// Join child/transport lifetimes before the shared tracker removes their homes.
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async ({ signal }) => {
    try {
      await workers.close(signal);
      await closeNativeServers(servers);
      await gateway?.close();
      gateway = undefined;
    } finally {
      cleanup();
    }
  }),
);

const workers = createWorkerProcessTestHarness((prefix) => tempDirs.make(prefix));

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
    credentials: { [`${MODEL.provider}/${MODEL.model}`]: LOCAL_KEY },
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
          headers: { "x-local-registry": "worker-startup" },
        },
      ],
      workspace: descriptor.assignment.workspaceDir,
    },
  };
}

async function launch(descriptor: WorkerLaunchDescriptor, startup?: NativeInferenceStartup) {
  return workers.launch({
    descriptor,
    startup,
    signal: activeTestSignal,
    diagnostics: () => ({
      admissions: owner().admissions.length,
      methods: owner().requests.map((request) => request.method),
    }),
  });
}

function result(exit: WorkerProcessTestExit) {
  expect(exit.code, exit.stderr).toBe(0);
  const lines = exit.stdout.trim().split("\n");
  expect(lines, exit.stderr).toHaveLength(1);
  const parsed = parseWorkerProcessMessage(JSON.parse(lines[0]!));
  if (parsed?.type !== "result") {
    throw new Error("Native worker did not emit a terminal result");
  }
  return parsed;
}

function providerFixture(mode: "tools" | "pending" = "tools") {
  const final = "Local worker completed.";
  return nativeProviderFixture(
    servers,
    MODEL.model,
    (request) => {
      if (mode === "pending") {
        return undefined;
      }
      if (request === 1) {
        return {
          name: "exec",
          args: {
            command: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(owner().root, "tool-proof.mjs"))}`,
            yieldMs: 10000,
          },
        };
      }
      if (request === 2) {
        return { name: "read", args: { path: path.join(owner().root, "tool-proof.json") } };
      }
      return final;
    },
    final,
  );
}

async function pendingWorker() {
  const provider = await providerFixture("pending");
  const descriptor = await localDescriptor();
  const worker = await launch(descriptor, startupFor(descriptor, provider.baseUrl));
  await withinTest(provider.entered, activeTestSignal);
  return { provider, descriptor, worker };
}

function addSiblingModel(startup: NativeInferenceStartup) {
  startup.config.models.push({ ...startup.config.models[0]!, id: "other-worker-model" });
  startup.credentials[`${MODEL.provider}/other-worker-model`] = "synthetic-other-worker-key";
}

// The shared real-service fixture uses Unix-domain admission, not a fake hello/commit ack.
describe.skipIf(process.platform === "win32")(
  "native inference through an actual worker process",
  () => {
    beforeEach(async ({ signal }) => {
      activeTestSignal = signal;
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
          'const proof = { pid: process.pid, ancestors, startupPresent: process.argv.includes("--internal-worker-native-inference"), credentialPresent: "WORKER_TEST_PROVIDER_KEY" in process.env };\n' +
          'writeFileSync(new URL("./tool-proof.json", import.meta.url), JSON.stringify(proof)); console.log("worker tool wrote proof");\n',
      );
      const registry = startupFor(descriptor, provider.baseUrl);
      addSiblingModel(registry);
      const worker = await launch(descriptor, registry);
      const outcome = result(await worker.finish());
      expect(outcome).toMatchObject({
        retainWorker: false,
        result: { status: "completed" },
      });
      expect(worker.child.pid).not.toBe(process.pid);
      const proof = JSON.parse(await readFile(path.join(owner().root, "tool-proof.json"), "utf8"));
      expect(proof).toMatchObject({
        startupPresent: false,
        credentialPresent: false,
      });
      expect(proof.pid).not.toBe(process.pid);
      expect(proof.pid).not.toBe(worker.child.pid);
      if (process.platform === "linux") {
        expect(proof.ancestors).toContain(worker.child.pid);
      }
      expectNativeRequests(provider, 3, {
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer " + LOCAL_KEY, "x-local-registry": "worker-startup" },
        body: { model: MODEL.model, max_completion_tokens: 173, reasoning_effort: "low" },
      });
      expect(JSON.stringify(provider.requests[2]!.body.messages)).toContain("startupPresent");
      expectNoProxyInference(owner());
      expect(owner().admissions).toHaveLength(1);
      const transcript = messages();
      expect(transcript).toMatchObject([
        { role: "user" },
        { role: "assistant" },
        { role: "toolResult", toolName: "exec", isError: false },
        { role: "assistant" },
        { role: "toolResult", toolName: "read", isError: false },
        {
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
        },
      ]);
      expect(outcome.result).toMatchObject({
        transcriptLeafId: SessionManager.open(owner().sessionTarget).getLeafId(),
      });
      expect(JSON.stringify(provider.requests)).not.toContain("synthetic-other-worker-key");
      expect(JSON.stringify(owner().requests)).not.toContain(LOCAL_KEY);
      expect(JSON.stringify(transcript)).not.toContain(LOCAL_KEY);
    }, 40_000);

    it.each([
      "missing model config",
      "unknown model",
      "wrong workspace",
      "unsupported reasoning",
    ] as const)(
      "rejects %s before provider HTTP",
      async (scenario) => {
        const provider = await providerFixture();
        const descriptor = await localDescriptor();
        const startup = startupFor(descriptor, provider.baseUrl);
        addSiblingModel(startup);
        if (scenario === "unknown model") {
          descriptor.assignment.modelRef = {
            ...descriptor.assignment.modelRef,
            model: "missing-model",
          };
        }
        if (scenario === "wrong workspace") {
          startup.config.workspace = path.dirname(startup.config.workspace);
        }
        if (scenario === "unsupported reasoning") {
          descriptor.assignment.inferenceOptions = { reasoning: "high" };
        }
        const worker = await launch(
          descriptor,
          scenario === "missing model config" ? undefined : startup,
        );
        const exit = await worker.finish();
        expect(exit.code).toBe(1);
        expect(exit.stderr).toContain(
          scenario === "missing model config"
            ? "no node-local model configuration"
            : scenario === "unsupported reasoning"
              ? "thinking level is not supported"
              : "does not match the admitted workspace or model",
        );
        expect(provider.requests).toEqual([]);
        if (scenario !== "unsupported reasoning") {
          expect(owner().admissions).toEqual([]);
          expect(messages()).toEqual([]);
        }
        expectNoProxyInference(owner());
      },
      40_000,
    );

    it("cancels pending native HTTP and settles without submitting new transcript messages", async () => {
      const { provider, worker } = await pendingWorker();
      const before = messages();
      const commitsBefore = owner().requestParams("worker.transcript.commit").length;
      expect(before.map((message) => message.role)).toEqual(["user"]);
      worker.cancel();
      const outcome = result(await worker.finish());
      expect(outcome.result).toMatchObject({ status: "failed", reason: "turn-failed" });
      await withinTest(provider.disconnected, activeTestSignal);
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
      expectNoProxyInference(owner());
    }, 40_000);

    it.each(["held Gateway outage", "placement replacement"])(
      "fences pending native HTTP after %s",
      async (scenario) => {
        const { provider, descriptor, worker } = await pendingWorker();
        const admitted = owner().admissions.length;
        const before = messages();
        if (scenario === "held Gateway outage") {
          const resume = owner().pauseConnections();
          try {
            await owner().reclaimWithCredential(
              "synthetic-outage-replacement",
              "replacement-outage-run",
            );
            // Prove disconnection before reopening admission or stopping the child.
            await withinTest(provider.disconnected, activeTestSignal);
            expect(owner().admissions).toHaveLength(admitted);
            expect(provider.requests).toHaveLength(1);
            expect(messages()).toEqual(before);
            expectNoProxyInference(owner());
          } finally {
            resume();
          }
        } else {
          const epoch = await owner().reclaimWithCredential(
            "synthetic-replacement-credential",
            "replacement-run",
          );
          expect(epoch).toBeGreaterThan(descriptor.admission.ownerEpoch);
          owner().partition();
        }
        expect(result(await worker.finish())).toMatchObject({
          result: { status: "failed", reason: "node-lost" },
          retainWorker: false,
        });
        expect(owner().admissions).toHaveLength(admitted);
        expect(provider.requests).toHaveLength(1);
        await withinTest(provider.disconnected, activeTestSignal);
        if (scenario === "placement replacement") {
          provider.release();
        }
        expect(messages()).toEqual(before);
        expectNoProxyInference(owner());
      },
      40_000,
    );

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
