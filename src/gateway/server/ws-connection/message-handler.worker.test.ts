import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WORKER_LIVE_EVENT_PROTOCOL_FEATURE } from "../../../../packages/gateway-protocol/src/index.js";
import { WORKER_GATEWAY_TOOL_METHODS } from "../../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import {
  WORKER_INFERENCE_PROTOCOL_FEATURE,
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
} from "../../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createNoisyPngBuffer } from "../../../../test/helpers/image-fixtures.js";
import { prepareSystemAgentRunAdmission } from "../../../agents/admitted-run-context.js";
import { prepareCoreToolPolicy } from "../../../agents/prepared-tool-surface.js";
import type { SessionPlacementTurnParams } from "../../../agents/session-placement-admission.js";
import { createToolSurfacePresentationForTest } from "../../../agents/tool-surface-plan.test-support.js";
import {
  beginGatewayRestartSignalAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { placementTurnOwner } from "../../worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "../../worker-environments/placement-store.js";
import { advancePlacementFixtureToActive } from "../../worker-environments/placement-test-fixtures.js";
import { prepareWorkerAgentRuntimeIdentity } from "../../worker-environments/worker-turn-payload.js";
import {
  CREDENTIAL,
  HANDSHAKE,
  IDENTITY,
  TRANSCRIPT_COMMIT,
  LIVE_EVENT,
  ATTACHED_IDENTITY,
  INFERENCE_IDS,
  INFERENCE_START,
  INFERENCE_EVENT,
  waitForWorkerProtocol,
  createRateLimiter,
  attachHarness,
  admit,
  setupWorkerProtocolTestState,
} from "./message-handler.worker.test-support.js";
import { buildWorkerHello } from "./worker-connection-frames.js";

describe("dedicated worker websocket protocol", () => {
  setupWorkerProtocolTestState();

  it.each([
    WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
    WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES + 1,
  ])("budgets the authenticated tool catalog hello at %s encoded bytes", async (bytes) => {
    vi.useFakeTimers();
    const harness = attachHarness({ identity: ATTACHED_IDENTITY });
    const definition = {
      name: "read",
      label: "Read",
      description: "",
      parameters: { description: "" },
    };
    const surface = {
      generation: "surface",
      presentation: createToolSurfacePresentationForTest(),
      tools: [{ id: "read", execution: "placement" as const, definition }],
      policy: prepareCoreToolPolicy({}),
    };
    const frame = {
      type: "res",
      id: "connect-1",
      ok: true,
      payload: { ...buildWorkerHello(ATTACHED_IDENTITY), toolSurface: surface },
    };
    const available = bytes - Buffer.byteLength(JSON.stringify(frame));
    definition.parameters.description = "x".repeat(available);
    const tooLarge = bytes > WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES;
    harness.service.getToolSurface.mockResolvedValue({ ok: true, result: surface });
    harness.sendConnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.responses[0]).toMatchObject(
      tooLarge
        ? {
            ok: false,
            error: { message: "Worker tool surface exceeds the admission frame limit" },
          }
        : { ok: true, payload: { toolSurface: { generation: surface.generation } } },
    );
    if (!tooLarge) {
      expect(Buffer.byteLength(JSON.stringify(harness.responses[0]))).toBe(bytes);
    }
    expect(harness.advanceHandshakePhase.mock.calls.flat().includes("ready")).toBe(!tooLarge);
  });

  it("does not finish hello after its socket closes while preparing tools", async () => {
    vi.useFakeTimers();
    const harness = attachHarness({ identity: ATTACHED_IDENTITY });
    const pending = createDeferredCore();
    const prepare = harness.service.getToolSurface.getMockImplementation()!;
    harness.service.getToolSurface.mockImplementation(async (identity) => {
      await pending.promise;
      return prepare(identity);
    });
    harness.sendConnect();
    await vi.advanceTimersByTimeAsync(0);
    harness.cleanup();
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.responses).toHaveLength(0);
    expect(harness.advanceHandshakePhase).not.toHaveBeenCalledWith("ready");
  });

  it("carries connection cancellation into Gateway tool dispatch", async () => {
    vi.useFakeTimers();
    const harness = attachHarness({ identity: ATTACHED_IDENTITY });
    const completion = createDeferredCore();
    let connectionSignal: AbortSignal | undefined;
    harness.service.invokeGatewayTool.mockImplementation(
      async (_identity, _request, _sink, signal) => {
        connectionSignal = signal;
        await completion.promise;
        return { ok: true, result: { content: [] } };
      },
    );
    harness.sendConnect();
    await vi.advanceTimersByTimeAsync(0);
    harness.sendRequest(WORKER_GATEWAY_TOOL_METHODS.invoke, {
      generation: "generation-1",
      toolId: "presence",
      toolCallId: "call-presence",
      arguments: { action: "person", person: "me", include: ["devices"] },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(connectionSignal?.aborted).toBe(false);

    harness.cleanup();
    expect(connectionSignal?.aborted).toBe(true);
    completion.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.responses).toHaveLength(1);
  });

  it("does not mark a synchronously closed hello ready or recreate its expiry timer", async () => {
    vi.useFakeTimers();
    const harness = attachHarness({ closeDuringHello: true });

    harness.sendConnect();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.responses).toHaveLength(1);
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.advanceHandshakePhase).not.toHaveBeenCalledWith("ready");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps unrelated worker admission closed while startup is pending", async () => {
    const harness = attachHarness({ startupPending: () => true });
    harness.sendConnect();

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1013, "gateway-unavailable"),
    );
    expect(harness.service.admitWorker).not.toHaveBeenCalled();
    expect(harness.responses[0]).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", retryable: true },
    });
  });

  it("fails closed when public ingress context is missing", async () => {
    const harness = attachHarness({ omitPublicAdmission: true });
    harness.sendConnect();

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "invalid-handshake"),
    );
    expect(harness.service.admitWorker).not.toHaveBeenCalled();
    expect(harness.logWsControl.warn).toHaveBeenCalledWith(
      "worker admission rejected reason=public-ingress-context-missing",
    );
  });

  it.each(["invalid-credential"] as const)(
    "projects public %s failures to one opaque reason",
    async (internalReason) => {
      const recordFailure = vi.fn();
      const rateLimiter = createRateLimiter({ recordFailure });
      const harness = attachHarness({
        admissionFailure: internalReason,
        rateLimiter,
      });
      harness.sendConnect();

      await waitForWorkerProtocol(() =>
        expect(harness.close).toHaveBeenCalledWith(1008, "invalid-handshake"),
      );
      expect(harness.responses[0]).toMatchObject({
        ok: false,
        error: { details: { reason: "invalid-handshake" } },
      });
      expect(harness.logWsControl.warn).toHaveBeenCalledWith(
        `worker admission rejected reason=${internalReason}`,
      );
      expect(harness.setCloseCause).toHaveBeenCalledWith(internalReason);
      expect(recordFailure).toHaveBeenCalledWith("203.0.113.10", "worker-admission");
      expect(harness.setClient).not.toHaveBeenCalled();
    },
  );

  it("rejects rate-limited public admission before credential verification", async () => {
    const rateLimiter = createRateLimiter({
      check: vi.fn(() => ({ allowed: false, remaining: 0, retryAfterMs: 12_000 })),
    });
    const harness = attachHarness({ rateLimiter });
    harness.sendConnect();

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "invalid-handshake"),
    );
    expect(harness.responses[0]).toMatchObject({
      ok: false,
      error: {
        details: { reason: "invalid-handshake" },
      },
    });
    expect(harness.service.admitWorker).not.toHaveBeenCalled();
    expect(harness.setCloseCause).toHaveBeenCalledWith("rate-limited");
  });

  it("resets public credential failures after successful admission", async () => {
    const reset = vi.fn();
    const rateLimiter = createRateLimiter({ reset });
    const harness = attachHarness({ rateLimiter });
    await admit(harness);

    expect(reset).toHaveBeenCalledWith("203.0.113.10", "worker-admission");
    expect(harness.responses[0]).toMatchObject({ ok: true, payload: { type: "worker-hello-ok" } });
    expect(JSON.stringify([harness.responses, harness.client()])).not.toContain(CREDENTIAL);
    expect(harness.client()).toMatchObject({
      connectionKind: "worker",
      connect: { role: "worker" },
    });
  });

  it("keeps public ownership failures opaque and charges the admission budget", async () => {
    const reset = vi.fn();
    const recordFailure = vi.fn();
    const rateLimiter = createRateLimiter({ reset, recordFailure });
    const harness = attachHarness({
      rateLimiter,
      validationFailure: "credential-replaced",
    });
    harness.sendConnect();

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "invalid-handshake"),
    );
    expect(harness.logWsControl.warn).toHaveBeenCalledWith(
      "worker admission rejected reason=credential-replaced",
    );
    expect(recordFailure).toHaveBeenCalledWith("203.0.113.10", "worker-admission");
    expect(reset).not.toHaveBeenCalled();
    expect(harness.setClient).not.toHaveBeenCalled();
  });

  it.each([["health", {}]])("rejects legacy method %s", async (method, params) => {
    const harness = attachHarness();
    await admit(harness);
    harness.sendRequest(method, params);

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "method-not-allowed"),
    );
    expect(harness.logGateway.warn).toHaveBeenCalledWith(
      "worker protocol request rejected reason=method-not-allowed",
    );
  });

  it("accepts heartbeat", async () => {
    const valid = attachHarness();
    await admit(valid);
    valid.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "busy" });
    await waitForWorkerProtocol(() => expect(valid.responses).toHaveLength(2));
    expect(valid.responses[1]).toMatchObject({
      ok: true,
      payload: { status: "ok", ownerEpoch: 1 },
    });
  });

  it("gates inference independently", async () => {
    const unsupported = attachHarness({
      identity: {
        ...ATTACHED_IDENTITY,
        protocolFeatures: HANDSHAKE.protocolFeatures.filter(
          (feature) => feature !== WORKER_INFERENCE_PROTOCOL_FEATURE,
        ),
      },
    });
    await admit(unsupported);
    unsupported.sendRequest("worker.inference.start", INFERENCE_START);
    await waitForWorkerProtocol(() =>
      expect(unsupported.close).toHaveBeenCalledWith(1008, "method-not-allowed"),
    );
    expect(unsupported.service.startInference).not.toHaveBeenCalled();
  });

  it("acknowledges inference before forwarding synchronous stream frames", async () => {
    const harness = attachHarness({
      identity: ATTACHED_IDENTITY,
      onInferenceLaunch: (sink) => sink.send(INFERENCE_EVENT),
    });
    await admit(harness);
    harness.sendRequest("worker.inference.start", INFERENCE_START);

    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(3));
    expect(harness.responses[1]).toMatchObject({
      ok: true,
      payload: { status: "accepted" },
    });
    expect(harness.responses[2]).toEqual(INFERENCE_EVENT);
    expect(harness.service.startInference).toHaveBeenCalledOnce();

    harness.sendRequest("worker.inference.cancel", INFERENCE_IDS, "cancel-1");
    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(4));
    expect(harness.responses[3]).toMatchObject({
      ok: true,
      payload: { status: "cancelled" },
    });
    expect(harness.service.cancelInference).toHaveBeenCalledWith(ATTACHED_IDENTITY, INFERENCE_IDS);
  });

  it("admits large image transcript frames without enlarging control or text budgets", async () => {
    const image = {
      type: "image",
      data: createNoisyPngBuffer(256, 256).toString("base64"),
      mimeType: "image/png",
    };
    expect(Buffer.byteLength(image.data)).toBeGreaterThan(64 * 1024);
    const transcript = {
      ...TRANSCRIPT_COMMIT,
      messages: [
        {
          role: "toolResult",
          toolName: "read",
          toolCallId: "read-image",
          timestamp: 1,
          isError: false,
          content: [image],
        },
      ],
    };
    const valid = attachHarness();
    await admit(valid);
    valid.sendRequest("worker.transcript.commit", transcript);
    await waitForWorkerProtocol(() => expect(valid.responses).toHaveLength(2));
    expect(valid.service.commitTranscript).toHaveBeenCalledWith(IDENTITY, transcript);
    expect(valid.close).not.toHaveBeenCalled();
    for (const [method, params] of [
      [
        "worker.transcript.commit",
        {
          ...transcript,
          messages: [
            {
              ...transcript.messages[0],
              content: [image, { type: "text", text: "x".repeat(64 * 1024) }],
            },
          ],
        },
      ],
      ["worker.heartbeat", { runEpoch: 1, extra: image.data }],
    ] as const) {
      const oversized = attachHarness();
      await admit(oversized);
      oversized.sendRequest(method, params);
      await waitForWorkerProtocol(() =>
        expect(oversized.close).toHaveBeenCalledWith(1009, "invalid-frame"),
      );
      expect(oversized.service.commitTranscript).not.toHaveBeenCalled();
    }
  });

  it("gates live-event features, schema, and closed errors", async () => {
    const unsupported = attachHarness({
      identity: {
        ...IDENTITY,
        protocolFeatures: HANDSHAKE.protocolFeatures.filter(
          (feature) => feature !== WORKER_LIVE_EVENT_PROTOCOL_FEATURE,
        ),
      },
    });
    await admit(unsupported);
    unsupported.sendRequest("worker.live-event", LIVE_EVENT);
    await waitForWorkerProtocol(() => expect(unsupported.close).toHaveBeenCalled());
    expect(unsupported.service.pushLiveEvent).not.toHaveBeenCalled();

    const resync = attachHarness({
      liveFailure: { reason: "resync-required", ackedSeq: 2, expectedSeq: 3 },
    });
    await admit(resync);
    resync.sendRequest("worker.live-event", { ...LIVE_EVENT, seq: 7 });
    await waitForWorkerProtocol(() =>
      expect(resync.responses[1]).toMatchObject({
        error: { details: { reason: "resync-required" } },
      }),
    );
    expect(resync.service.pushLiveEvent).toHaveBeenCalledOnce();

    const invalid = attachHarness();
    await admit(invalid);
    invalid.sendRequest("worker.live-event", {
      ...LIVE_EVENT,
      event: { kind: "assistant", payload: { delta: "x" } },
    });
    await waitForWorkerProtocol(() =>
      expect(invalid.responses[1]).toMatchObject({
        error: { details: { reason: "invalid-event" } },
      }),
    );
    expect(invalid.service.pushLiveEvent).not.toHaveBeenCalled();
  });

  it("returns closed transcript errors without closing the worker connection", async () => {
    const harness = attachHarness({ commitFailure: "stale-base-leaf" });
    await admit(harness);
    harness.sendRequest("worker.transcript.commit", TRANSCRIPT_COMMIT);

    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(2));
    expect(harness.responses[1]).toMatchObject({
      ok: false,
      error: { details: { reason: "stale-base-leaf" } },
    });
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("rejects structurally invalid transcript batches before application", async () => {
    const harness = attachHarness();
    await admit(harness);
    harness.sendRequest("worker.transcript.commit", {
      ...TRANSCRIPT_COMMIT,
      sessionId: "foreign-session",
    });

    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(2));
    expect(harness.responses[1]).toMatchObject({
      ok: false,
      error: { details: { reason: "invalid-batch" } },
    });
    expect(harness.service.commitTranscript).not.toHaveBeenCalled();
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("closes a replaced worker before parsing a malformed transcript batch", async () => {
    const harness = attachHarness();
    await admit(harness);
    vi.mocked(harness.service.validateWorkerConnection).mockReturnValue("credential-replaced");
    harness.sendRequest("worker.transcript.commit", {
      ...TRANSCRIPT_COMMIT,
      sessionId: "foreign-session",
    });

    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(2));
    expect(harness.responses[1]).toMatchObject({
      ok: false,
      error: { details: { reason: "credential-replaced" } },
    });
    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "credential-replaced"),
    );
    expect(harness.service.commitTranscript).not.toHaveBeenCalled();
  });

  it("keeps an expired credential connected only while its durable turn remains valid", async () => {
    const harness = attachHarness({
      identity: { ...ATTACHED_IDENTITY, credentialExpiresAtMs: Date.now() + 20 },
    });
    await admit(harness);
    vi.mocked(harness.service.validateWorkerConnection).mockClear();

    await waitForWorkerProtocol(() =>
      expect(harness.service.validateWorkerConnection).toHaveBeenCalled(),
    );
    expect(harness.close).not.toHaveBeenCalled();

    vi.mocked(harness.service.validateWorkerConnection).mockReturnValue("credential-expired");
    harness.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "busy" });
    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "credential-expired"),
    );
  });

  it("fences a replaced connection before dispatch", async () => {
    const harness = attachHarness();
    await admit(harness);
    harness.client()!.invalidated = true;
    harness.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "ready" });

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "credential-replaced"),
    );
    expect(harness.service.validateWorkerConnection).toHaveBeenCalledOnce();
  });

  it.each([
    { scenario: "an already-admitted unaudited worker", fence: "none", accepted: true },
    { scenario: "a worker whose exact admitted run closed", fence: "run", accepted: false },
    { scenario: "a worker whose exact placement closed", fence: "placement", accepted: false },
    { scenario: "a worker during a restart signal", fence: "restart", accepted: false },
  ] as const)("handles $scenario while suspension drains", async ({ fence, accepted }) => {
    const templateClaim = ATTACHED_IDENTITY.turnClaim;
    if (!templateClaim) {
      throw new Error("expected attached worker turn claim");
    }
    const preparedRunAdmission = prepareSystemAgentRunAdmission(
      {},
      templateClaim.runId,
      "main",
      "test.worker-suspension",
    );
    const stateDir = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-suspension-"),
    );
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    const placements = createWorkerSessionPlacementStore({ database });
    const session = {
      sessionId: templateClaim.sessionId,
      agentId: "main",
      sessionKey: "agent:main:worker-suspension",
    };
    const active = await advancePlacementFixtureToActive(placements, database, session);
    const claim = await placements.claimTurn({
      ...session,
      claimId: templateClaim.claimId,
      runId: templateClaim.runId,
      owner: placementTurnOwner(active),
    });
    const identity = {
      ...ATTACHED_IDENTITY,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      turnClaim: claim,
    };
    const rootAdmission = tryBeginGatewayRootWorkAdmission();
    if (!rootAdmission) {
      throw new Error("expected parent worker turn root admission");
    }
    let suspension: ReturnType<typeof tryBeginGatewaySuspendAdmission> = null;
    let restartSignal: ReturnType<typeof beginGatewayRestartSignalAdmission> = null;
    try {
      const { runtimeIdentity } = await rootAdmission.run(() =>
        prepareWorkerAgentRuntimeIdentity({
          agentId: session.agentId,
          placements,
          runtimeInstanceId: identity.environmentId,
          sessionKey: session.sessionKey,
          sessionTarget: {
            ...session,
            storePath: path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
          },
          promptCacheContext: { boundaryCount: 0 },
          assertSourceCurrent: () => {},
          turn: {
            preparedRunAdmission,
            runId: claim.runId,
          } as SessionPlacementTurnParams,
          turnClaim: claim,
        }),
      );
      expect(runtimeIdentity.executionIdentityToken).toBeUndefined();
      const harness = attachHarness({ identity });
      await admit(harness);
      suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.drain()).toBe(true);
      if (fence === "run") {
        preparedRunAdmission.close();
      } else if (fence === "placement") {
        await placements.releaseTurn(claim);
      } else if (fence === "restart") {
        restartSignal = beginGatewayRestartSignalAdmission();
        expect(restartSignal).not.toBeNull();
      }

      harness.sendRequest("worker.transcript.commit", {
        ...TRANSCRIPT_COMMIT,
        runEpoch: identity.ownerEpoch,
      });

      if (accepted) {
        await waitForWorkerProtocol(() =>
          expect(harness.service.commitTranscript).toHaveBeenCalledOnce(),
        );
        expect(harness.close).not.toHaveBeenCalled();
        expect(harness.responses[1]).toMatchObject({ ok: true });
      } else {
        await waitForWorkerProtocol(() =>
          expect(harness.close).toHaveBeenCalledWith(1013, "gateway-unavailable"),
        );
        expect(harness.service.commitTranscript).not.toHaveBeenCalled();
      }
    } finally {
      restartSignal?.rollback();
      suspension?.release();
      if (placements.validateTurnClaim(claim)) {
        await placements.releaseTurn(claim);
      }
      preparedRunAdmission.close();
      rootAdmission.release();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
