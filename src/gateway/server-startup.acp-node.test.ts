import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpGatewayStore } from "../acp/store/store.js";
import { createProjectionRestartHarness } from "../acp/test-harness/restart-harness.js";
import { createAcpTestConfig } from "../auto-reply/reply/test-fixtures/acp-runtime.js";
import { startAcpNodeProjectionRecovery } from "./server-startup.acp-node.js";

const tempRoots: string[] = [];

async function createStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-startup-"));
  tempRoots.push(root);
  return new AcpGatewayStore({
    storePath: path.join(root, "acp", "gateway-node-runtime-store.json"),
  });
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
  );
});

describe("startAcpNodeProjectionRecovery", () => {
  it("discovers terminal-persisted but unprojected runs from durable state on startup", async () => {
    const store = await createStore();
    const lease = await store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-1",
      now: 10,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      requestId: "run-1",
      now: 11,
    });
    await store.recordRunDeliveryTarget({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      targetId: "primary",
      channel: "telegram",
      to: "telegram:a",
      routeMode: "originating",
      now: 12,
    });
    await store.appendWorkerEvent({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      seq: 1,
      event: {
        type: "text_delta",
        text: "startup replay",
        tag: "agent_message_chunk",
      },
      now: 13,
    });
    await store.resolveTerminal({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      terminalEventId: "term-1",
      finalSeq: 1,
      terminal: {
        kind: "completed",
      },
      now: 14,
    });

    const harness = createProjectionRestartHarness();
    const result = await startAcpNodeProjectionRecovery({
      cfg: createAcpTestConfig(),
      store,
      coordinatorFactory: harness.createCoordinatorFactory(),
    });

    expect(result.started).toContain("run-1:primary");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetKey: "run-1:primary",
          payload: expect.objectContaining({
            text: expect.stringContaining("startup replay"),
          }),
          restartMode: true,
        }),
      ]),
    );
    expect(harness.createdInstanceIds).toHaveLength(1);
  });
});
