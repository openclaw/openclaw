import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { captureSessionWorkRunInterruptions } from "../sessions/session-controller.lifecycle.js";
import { isRpcSourceExecuting } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import type { AgentTurnIo } from "./agent-turn/types.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
} from "./test-helpers.js";

let harness: GatewayServerHarness;
let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
let acquisition: Promise<GatewayServerHarness> | undefined;
installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    const kernelModule = await import("./server-kernel.js");
    const createKernel = kernelModule.createGatewayKernel;
    const capture = vi
      .spyOn(kernelModule, "createGatewayKernel")
      .mockImplementation(async (...args) => {
        kernel = await createKernel(...args);
        return kernel;
      });
    acquisition = startGatewayServerHarness();
    harness = await acquisition.finally(() => capture.mockRestore());
  },
  cleanup: async () => {
    const ready = await acquisition?.catch(() => undefined);
    await ready?.close();
  },
});

it("refuses provider execution when close overtakes acquired WS work during preparation", async ({
  signal,
}) => {
  await prepareGatewayReplyRuntimeForTest();
  const admissionHeld = createDeferred();
  const releaseAdmission = createDeferred();
  const commandStarted = createDeferred();
  const releaseCommand = createDeferred();
  const terminalObserved = createDeferred();
  const drainEntered = createDeferred();
  let serviceCompletion: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let terminal: Parameters<AgentTurnIo["emitAcceptance"]> | undefined;
  const release = () => {
    releaseAdmission.resolve();
    releaseCommand.resolve();
  };
  signal.addEventListener("abort", release, { once: true });
  const admissionModule = await import("./agent-turn/agent-run-admission-phase.js");
  const prepare = admissionModule.prepareAgentRunDispatch;
  vi.spyOn(admissionModule, "prepareAgentRunDispatch").mockImplementationOnce(async (params) => {
    const acquire = params.acquireGatewayWorkAdmission;
    return await prepare({
      ...params,
      acquireGatewayWorkAdmission: async (...args) => {
        await acquire(...args);
        admissionHeld.resolve();
        await releaseAdmission.promise;
      },
    });
  });
  const serviceModule = await import("./agent-turn/agent-turn-service.js");
  const createService = serviceModule.createAgentTurnService;
  vi.spyOn(serviceModule, "createAgentTurnService").mockImplementationOnce((...args) => {
    const service = createService(...args);
    const start = service.startTurn.bind(service);
    vi.spyOn(service, "startTurn").mockImplementationOnce((params) => {
      serviceCompletion = start({
        ...params,
        io: {
          ...params.io,
          emitAcceptance: (...frame) => {
            params.io.emitAcceptance(...frame);
            if (!frame[0][0] || (isRecord(frame[0][1]) && frame[0][1].status === "timeout")) {
              terminal = frame;
              terminalObserved.resolve();
            }
          },
          emitFinal: (...frame) => {
            params.io.emitFinal(...frame);
            terminalObserved.resolve();
          },
        },
      });
      return serviceCompletion;
    });
    return service;
  });
  vi.mocked(agentCommandMock).mockReset();
  vi.mocked(agentCommandMock).mockImplementationOnce(async () => {
    commandStarted.resolve();
    await releaseCommand.promise;
    return {
      payloads: [{ text: "late provider reply" }],
      meta: {
        durationMs: 1,
        terminalReply: { disposition: "visible", text: "late provider reply" },
      },
    };
  });
  try {
    const { ws } = await harness.openClient();
    ws.send(
      JSON.stringify({
        type: "req",
        id: "late-admission",
        method: "agent",
        params: {
          message: "hold while preparing the run",
          sessionKey: "main",
          idempotencyKey: "late-admission",
        },
      }),
    );
    await admissionHeld.promise;
    const acceptedSource = rpcSourceTesting.get("late-admission");
    expect(acceptedSource).toBeDefined();
    expect(isRpcSourceExecuting(acceptedSource)).toBe(false);
    const session = await loadSessionEntryAsync("main");
    expect(
      captureSessionWorkRunInterruptions({
        scope: session.storePath,
        identities: [session.canonicalKey, session.entry?.sessionId],
        accept: (run) => run.runId === "late-admission",
      }).map(({ run }) => run),
    ).toEqual([
      {
        runId: "late-admission",
        sessionKey: session.canonicalKey,
        sessionId: session.entry?.sessionId,
        agentId: "main",
      },
    ]);
    const drain = kernel.connectionWork.drain.bind(kernel.connectionWork);
    vi.spyOn(kernel.connectionWork, "drain").mockImplementationOnce(() => {
      const operation = drain();
      drainEntered.resolve();
      return operation;
    });
    // Exercise public per-Gateway close without a process-global restart fence.
    closing = harness.server.close({ reason: "gateway stopping", restartExpectedMs: null });
    await drainEntered.promise;
    releaseAdmission.resolve();
    await Promise.race([commandStarted.promise, terminalObserved.promise]);
    releaseCommand.resolve();
    await terminalObserved.promise;
    await serviceCompletion;
    await closing;
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(terminal?.[1]).toMatchObject({ cached: true });
    expect(terminal?.[0]).toEqual([
      true,
      expect.objectContaining({
        runId: "late-admission",
        status: "timeout",
        summary: "aborted",
        stopReason: "restart",
        timeoutPhase: "queue",
        providerStarted: false,
      }),
      undefined,
    ]);
    expect(rpcSourceTesting.has("late-admission")).toBe(false);
  } finally {
    release();
    await Promise.allSettled([serviceCompletion]);
    if (vi.mocked(agentCommandMock).mock.calls.length > 0) {
      await terminalObserved.promise;
    }
    await Promise.allSettled([closing]);
    vi.restoreAllMocks();
    signal.removeEventListener("abort", release);
  }
});
