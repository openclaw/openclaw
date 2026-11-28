/**
 * Warm worker inference admission over the composed Gateway's Unix WebSocket.
 * Run serially on the same host and Node version, interleaving identical base
 * A1/A2 and candidate B processes at least five times for each mode:
 * OPENCLAW_INFERENCE_START_BENCH=1 node scripts/run-vitest.mjs run src/worker/worker-inference-start.perf.test.ts --maxWorkers=1 --pool forks
 * Each process runs unprofiled CPU first, then V8 allocation sampling.
 * Accept a decrease beyond A/A spread in admission CPU and sampled owner allocation,
 * with no request rejection, extra provider execution, or >20% p95 wall regression.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { Type } from "typebox";
import { it } from "vitest";
import type { WorkerInferenceStartParams } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  startCollectedHeapSampling,
  sumSampledHeapBytes,
} from "../../scripts/lib/heap-sampling.js";

function sampledAdmissionBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  const { functionName, url } = node.callFrame;
  if (
    (functionName === "start" && /\/worker-environments\/inference\.[jt]s$/u.test(url)) ||
    (functionName === "startInference" &&
      /\/worker-environments\/worker-turn-rpc\.[jt]s$/u.test(url))
  ) {
    return sumSampledHeapBytes(node);
  }
  return node.children.reduce((total, child) => total + sampledAdmissionBytes(child), 0);
}

it.skipIf(process.env.OPENCLAW_INFERENCE_START_BENCH !== "1")(
  "measures warm inference start on the worker WebSocket",
  async () => {
    const [
      { bindAgentToolExecutionLocation },
      { createToolSurfacePresentationForTest },
      { bindWorkerTurnCapabilities },
      { createWorkerGatewayToolRuntime },
      { withOpenClawTestState },
      { ComposedGatewayHarness, doneOutcome },
    ] = await Promise.all([
      import("../agents/agent-tool-metadata.js"),
      import("../agents/tool-surface-plan.test-support.js"),
      import("../gateway/worker-environments/placement-turn-claim-events.js"),
      import("../gateway/worker-environments/worker-gateway-tool-runtime.js"),
      import("../test-utils/openclaw-test-state.js"),
      import("./worker-fault-injection.test-support.js"),
    ]);
    await withOpenClawTestState({ label: "worker-inference-start" }, async (state) => {
      const gateway = await ComposedGatewayHarness.create(state.path("composed"));
      let executions = 0;
      let starts = 0;
      let cpuUs = 0;
      const wallMs: number[] = [];
      // Keep the normal service and transport in the measurement. Measure this owner
      // separately from the fixture's client encoder, socket observer and provider.
      const start = gateway.serviceValue.startInference;
      gateway.serviceValue.startInference = async (...args) => {
        const cpu = process.threadCpuUsage();
        const wall = performance.now();
        const result = await start(...args);
        const used = process.threadCpuUsage(cpu);
        cpuUs += used.user + used.system;
        wallMs.push(performance.now() - wall);
        starts++;
        return result;
      };
      try {
        await gateway.start();
        const descriptor = await gateway.createDescriptor();
        const { sessionId, ownerEpoch } = descriptor.admission;
        const { modelRef, runId } = descriptor.assignment;
        const clients = await gateway.createClients();
        try {
          await clients.connection.start();
          const identity = gateway.admissions.at(-1);
          assert(identity?.turnClaim);
          const tools = Array.from({ length: 96 }, (_, index) => {
            const name = `fixture_tool_${index}`;
            const tool = {
              name,
              label: name,
              description: `Synthetic tool ${index} with bounded input and output`,
              parameters: Type.Object(
                Object.fromEntries(
                  Array.from({ length: 12 }, (_field, field) => [
                    `field_${field}`,
                    Type.Optional(Type.String({ description: `A synthetic field for ${name}` })),
                  ]),
                ),
                { additionalProperties: false },
              ),
              execute: async () => ({ content: [], details: {} }),
            };
            bindAgentToolExecutionLocation(tool, { kind: "gateway" });
            return tool;
          });
          const toolSurface = createWorkerGatewayToolRuntime({
            assertCurrent() {},
            signal: new AbortController().signal,
            prepare: async () => ({
              tools,
              presentation: createToolSurfacePresentationForTest(),
              policy: {
                workspaceOnly: true,
                readOnly: true,
                applyPatchEnabled: false,
                applyPatchWorkspaceOnly: true,
                imageSanitization: {},
              },
            }),
          });
          bindWorkerTurnCapabilities(gateway.placementStore, identity.turnClaim, {
            toolSurface,
            admitTurn: async (_request, assertCurrent, approve) => {
              assertCurrent();
              approve();
              return { outcome: "allow", baseLeafId: null };
            },
            inference: async () => {
              executions++;
              return doneOutcome("Synthetic worker response");
            },
          });
          const admission = await clients.connection.rpc.request("turn-admission", {
            runEpoch: ownerEpoch,
            systemPrompt: "Synthetic system prompt",
            prompt: "Synthetic worker turn",
            messages: [],
          });
          assert(admission.ok && admission.payload.outcome === "allow");
          const projection = await toolSurface.getPromptProjection(identity);
          assert.equal(projection.tools.length, tools.length);
          const requests = [42, 135, 320].map((count): WorkerInferenceStartParams => ({
            runEpoch: ownerEpoch,
            sessionId,
            runId,
            turnId: "size",
            modelRef,
            options: {},
            context: {
              tools: projection.tools,
              systemPrompt: "Synthetic worker instructions",
              messages: Array.from({ length: count }, (_, index) => ({
                role: "user",
                content: `${index}: ${'Synthetic history text \\ with unicode 🐚 and "quotes"\n'.repeat(35)}`,
                timestamp: index + 1,
              })),
            },
          }));
          const requestBytes = requests.map((request) =>
            Buffer.byteLength(JSON.stringify(request)),
          );
          let turn = 0;
          const run = async (count: number) => {
            for (let index = 0; index < count; index++) {
              const request = {
                ...requests[index % requests.length]!,
                turnId: `fixture-${turn++}`,
              };
              const outcome = await clients.inference.start(request);
              assert.equal(outcome.type, "done", JSON.stringify(outcome));
              gateway.requests.length = 0;
            }
          };
          await run(12);
          for (const mode of ["cpu", "allocation"]) {
            globalThis.gc?.();
            starts = executions = cpuUs = 0;
            wallMs.length = 0;
            const load = loadavg();
            const inspector = mode === "allocation" ? new Session() : undefined;
            if (inspector) {
              await startCollectedHeapSampling(inspector, 4096);
            }
            await run(45);
            const profile =
              inspector && (await inspector.post("HeapProfiler.stopSampling")).profile;
            inspector?.disconnect();
            assert.equal(starts, 45);
            assert.equal(executions, starts);
            const sortedWall = wallMs.toSorted((left, right) => left - right);
            console.log(
              JSON.stringify({
                mode,
                starts,
                requestBytes,
                tools: tools.length,
                cpuUsPerStart: cpuUs / starts,
                wallP50Ms: sortedWall[Math.floor(starts * 0.5)],
                wallP95Ms: sortedWall[Math.ceil(starts * 0.95) - 1],
                sampledBytesPerStart: profile && sumSampledHeapBytes(profile.head) / starts,
                sampledAdmissionBytesPerStart:
                  profile && sampledAdmissionBytes(profile.head) / starts,
                load,
              }),
            );
          }
        } finally {
          clients.inference.dispose();
          await clients.connection.stop();
        }
      } finally {
        await gateway.close();
      }
    });
  },
  120_000,
);
