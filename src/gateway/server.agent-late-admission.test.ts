import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { captureSessionWorkRunInterruptions } from "../sessions/session-controller.lifecycle.js";
import { isRpcSourceExecuting } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import type { AgentTurnIo } from "./agent-turn/types.js";
import { installAuthorityProofKernel } from "./server.agent-runtime-authority-proof.test-support.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import { agentCommandMock, prepareGatewayReplyRuntimeForTest } from "./test-helpers.js";

const gateway = installAuthorityProofKernel();

it("refuses provider execution when close overtakes acquired WS work during preparation", async ({
  signal,
}) => {
  const harness = gateway.harness();
  const kernel = gateway.kernel();
  await prepareGatewayReplyRuntimeForTest();
  const admissionHeld = createDeferred();
  const releaseAdmission = createDeferred();
  const drainEntered = createDeferred();
  let serviceCompletion: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let terminal: Parameters<AgentTurnIo["emitAcceptance"]> | undefined;
  const release = () => releaseAdmission.resolve();
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
      const emit = params.io.emitAcceptance;
      vi.spyOn(params.io, "emitAcceptance").mockImplementation((...frame) => {
        emit(...frame);
        terminal = frame;
      });
      serviceCompletion = start(params);
      return serviceCompletion;
    });
    return service;
  });
  vi.mocked(agentCommandMock).mockReset().mockResolvedValueOnce(undefined);
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
    await Promise.allSettled([closing]);
    vi.restoreAllMocks();
    signal.removeEventListener("abort", release);
  }
});
