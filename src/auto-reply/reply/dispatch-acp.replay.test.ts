import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpGatewayStore } from "../../acp/store/store.js";
import { createProjectionRestartHarness } from "../../acp/test-harness/restart-harness.js";
import { AcpDurableProjectionService } from "./dispatch-acp-replay.js";
import { createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

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
    routeMode: "originating",
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
  await Promise.all(
    tempRoots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
  );
});

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
});
