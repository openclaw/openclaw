import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpGatewayStore } from "../../acp/store/store.js";
import { createProjectionRestartHarness } from "../../acp/test-harness/restart-harness.js";
import { createAcpDispatchDeliveryCoordinator } from "./dispatch-acp-delivery.js";
import { AcpDurableProjectionService } from "./dispatch-acp-replay.js";
import { createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

const routeMocks = vi.hoisted(() => ({
  routeReply: vi.fn(async (_params: unknown) => ({ ok: true, messageId: "mock" })),
}));

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as { payload: unknown };
    return params.payload;
  }),
}));

const zodMocks = vi.hoisted(() => {
  const createSchema = (): unknown =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "parse") {
            return (value: unknown) => value;
          }
          if (prop === "safeParse") {
            return (value: unknown) => ({ success: true, data: value });
          }
          if (prop === "spa") {
            return async (value: unknown) => ({ success: true, data: value });
          }
          return (..._args: unknown[]) => createSchema();
        },
      },
    );
  const z = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "coerce") {
          return new Proxy(
            {},
            {
              get:
                () =>
                (..._args: unknown[]) =>
                  createSchema(),
            },
          );
        }
        if (prop === "ZodIssueCode") {
          return {};
        }
        return (..._args: unknown[]) => createSchema();
      },
    },
  );
  return { z };
});

vi.mock("./route-reply.js", () => ({
  routeReply: (params: unknown) => routeMocks.routeReply(params),
}));

vi.mock("../../tts/tts.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));

vi.mock("zod", () => zodMocks);

const tempRoots: string[] = [];

async function createStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-replay-"));
  tempRoots.push(root);
  return new AcpGatewayStore({
    storePath: path.join(root, "acp", "gateway-node-runtime-store.json"),
  });
}

async function seedTerminalRun(params: {
  store: AcpGatewayStore;
  sessionKey: string;
  runId: string;
  targetId?: string;
  channel: string;
  to: string;
  routeMode?: "originating" | "session";
  text: string;
  now: number;
  terminalKind?: "completed" | "failed";
}) {
  const lease = await params.store.acquireLease({
    sessionKey: params.sessionKey,
    nodeId: "node-1",
    leaseId: `${params.runId}-lease`,
    now: params.now,
  });
  await params.store.startRun({
    sessionKey: params.sessionKey,
    runId: params.runId,
    requestId: params.runId,
    now: params.now + 1,
  });
  await params.store.recordRunDeliveryTarget({
    sessionKey: params.sessionKey,
    runId: params.runId,
    targetId: params.targetId ?? "primary",
    channel: params.channel,
    to: params.to,
    routeMode: params.routeMode ?? "originating",
    now: params.now + 2,
  });
  await params.store.appendWorkerEvent({
    nodeId: "node-1",
    sessionKey: params.sessionKey,
    runId: params.runId,
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
    seq: 1,
    event: {
      type: "text_delta",
      text: params.text,
      tag: "agent_message_chunk",
    },
    now: params.now + 3,
  });
  await params.store.resolveTerminal({
    nodeId: "node-1",
    sessionKey: params.sessionKey,
    runId: params.runId,
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
    terminalEventId: `${params.runId}-terminal`,
    finalSeq: 1,
    terminal: {
      kind: params.terminalKind ?? "completed",
      ...(params.terminalKind === "failed"
        ? {
            errorCode: "ACP_TURN_FAILED",
            errorMessage: "terminal failure",
          }
        : {
            stopReason: "done",
          }),
    },
    now: params.now + 4,
  });
}

afterEach(async () => {
  routeMocks.routeReply.mockReset();
  routeMocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });
  ttsMocks.maybeApplyTtsToPayload.mockClear();
  await Promise.all(
    tempRoots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
  );
});

function createDispatcherStub() {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
}

describe("AcpDurableProjectionService", () => {
  it("keeps run-scoped delivery targets isolated across multiple runs on one session", async () => {
    const store = await createStore();
    const sessionKey = "agent:main:acp:test-session";
    await seedTerminalRun({
      store,
      sessionKey,
      runId: "run-a",
      channel: "telegram",
      to: "telegram:a",
      text: "alpha",
      now: 10,
    });
    await seedTerminalRun({
      store,
      sessionKey,
      runId: "run-b",
      channel: "discord",
      to: "discord:b",
      text: "bravo",
      now: 30,
    });

    const harness = createProjectionRestartHarness();
    const service = new AcpDurableProjectionService({
      store,
      coordinatorFactory: harness.createCoordinatorFactory(),
    });
    const cfg = createAcpTestConfig();

    await Promise.all([
      service.ensureProjection({
        cfg,
        target: (await store.getRunDeliveryTarget("run-a", "primary"))!,
        shouldSendToolSummaries: true,
        restartMode: true,
      }),
      service.ensureProjection({
        cfg,
        target: (await store.getRunDeliveryTarget("run-b", "primary"))!,
        shouldSendToolSummaries: true,
        restartMode: true,
      }),
    ]);

    expect(harness.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetKey: "run-a:primary",
          payload: expect.objectContaining({ text: expect.stringContaining("alpha") }),
        }),
        expect.objectContaining({
          targetKey: "run-b:primary",
          payload: expect.objectContaining({ text: expect.stringContaining("bravo") }),
        }),
      ]),
    );
  });

  it("replays only the unfinished remainder when restart lands mid-event projection", async () => {
    const baselineStore = await createStore();
    await seedTerminalRun({
      store: baselineStore,
      sessionKey: "agent:main:acp:test-session",
      runId: "run-partial",
      channel: "telegram",
      to: "telegram:a",
      text: "partial body",
      now: 10,
      terminalKind: "failed",
    });

    const baselineHarness = createProjectionRestartHarness();
    const baselineService = new AcpDurableProjectionService({
      store: baselineStore,
      coordinatorFactory: baselineHarness.createCoordinatorFactory(),
    });
    const cfg = createAcpTestConfig({
      acp: {
        enabled: true,
        stream: {
          coalesceIdleMs: 0,
          maxChunkChars: 64,
        },
      },
    });
    await baselineService.ensureProjection({
      cfg,
      target: (await baselineStore.getRunDeliveryTarget("run-partial", "primary"))!,
      shouldSendToolSummaries: true,
      restartMode: true,
    });
    const baselineDeliveries = baselineHarness.deliveries.map((entry) => ({
      kind: entry.kind,
      payload: entry.payload,
    }));
    expect(baselineDeliveries.length).toBeGreaterThan(1);

    const restartedStore = await createStore();
    await seedTerminalRun({
      store: restartedStore,
      sessionKey: "agent:main:acp:test-session",
      runId: "run-partial",
      channel: "telegram",
      to: "telegram:a",
      text: "partial body",
      now: 10,
      terminalKind: "failed",
    });
    await restartedStore.recordProjectorCheckpoint({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-partial",
      targetId: "primary",
      cursorSeq: 1,
      deliveredEffectCount: 1,
      now: 20,
    });

    const restartHarness = createProjectionRestartHarness();
    const restartedService = new AcpDurableProjectionService({
      store: restartedStore,
      coordinatorFactory: restartHarness.createCoordinatorFactory(),
    });
    await restartedService.ensureProjection({
      cfg,
      target: (await restartedStore.getRunDeliveryTarget("run-partial", "primary"))!,
      shouldSendToolSummaries: true,
      restartMode: true,
    });

    expect(restartHarness.createdInstanceIds[0]).not.toBe(baselineHarness.createdInstanceIds[0]);
    expect(
      restartHarness.deliveries.map((entry) => ({
        kind: entry.kind,
        payload: entry.payload,
      })),
    ).toEqual(baselineDeliveries.slice(1));
  });

  it("does not advance the projector checkpoint before confirmed live session-route delivery", async () => {
    const store = await createStore();
    await seedTerminalRun({
      store,
      sessionKey: "agent:main:acp:test-session",
      runId: "run-session-live",
      channel: "discord",
      to: "discord:session-thread",
      routeMode: "session",
      text: "session lane body",
      now: 10,
    });

    let resolveRouteReply!: (value: { ok: true; messageId: string }) => void;
    routeMocks.routeReply.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRouteReply = resolve;
        }),
    );

    const cfg = createAcpTestConfig();
    const service = new AcpDurableProjectionService({
      store,
      coordinatorFactory: ({ target, restartMode }) =>
        createAcpDispatchDeliveryCoordinator({
          cfg,
          target,
          dispatcher: createDispatcherStub(),
          inboundAudio: false,
          shouldRouteToOriginating: false,
          restartMode,
        }),
    });

    const projectionPromise = service.ensureProjection({
      cfg,
      target: (await store.getRunDeliveryTarget("run-session-live", "primary"))!,
      shouldSendToolSummaries: true,
      restartMode: false,
    });

    await vi.waitFor(() => expect(routeMocks.routeReply).toHaveBeenCalledTimes(1));
    expect(await store.getCheckpoint("projector:run-session-live:primary")).toBeNull();

    resolveRouteReply({ ok: true, messageId: "session-live-1" });
    await projectionPromise;

    expect(await store.getCheckpoint("projector:run-session-live:primary")).toMatchObject({
      runId: "run-session-live",
      cursorSeq: 1,
      deliveredEffectCount: 1,
    });
  });

  it("replays missing session-route output after restart when no checkpoint was durably recorded", async () => {
    const store = await createStore();
    await seedTerminalRun({
      store,
      sessionKey: "agent:main:acp:test-session",
      runId: "run-session-replay",
      channel: "discord",
      to: "discord:session-thread",
      routeMode: "session",
      text: "replay me",
      now: 10,
    });

    const cfg = createAcpTestConfig();
    const service = new AcpDurableProjectionService({
      store,
      coordinatorFactory: ({ target, restartMode }) =>
        createAcpDispatchDeliveryCoordinator({
          cfg,
          target,
          dispatcher: createDispatcherStub(),
          inboundAudio: false,
          shouldRouteToOriginating: false,
          restartMode,
        }),
    });

    await service.ensureProjection({
      cfg,
      target: (await store.getRunDeliveryTarget("run-session-replay", "primary"))!,
      shouldSendToolSummaries: true,
      restartMode: true,
    });

    expect(routeMocks.routeReply).toHaveBeenCalledTimes(1);
    expect(routeMocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "discord:session-thread",
        payload: expect.objectContaining({ text: "replay me" }),
      }),
    );
    expect(await store.getCheckpoint("projector:run-session-replay:primary")).toMatchObject({
      runId: "run-session-replay",
      cursorSeq: 1,
      deliveredEffectCount: 1,
    });
  });
});
