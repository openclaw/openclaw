import { expect, vi } from "vitest";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  createGatewayMethodRegistry,
  createCoreGatewayMethodDescriptors,
} from "../gateway/methods/registry.js";
import { handleGatewayRequest, coreGatewayHandlers } from "../gateway/server-methods.js";
import type { GatewayClient, GatewayRequestContext } from "../gateway/server-methods/types.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

export async function withReadState(run: () => Promise<void>) {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    try {
      await run();
    } finally {
      const holders = getActiveGatewayRootWorkHolders();
      if (holders.length) {
        console.info("Task read cleanup joining owners:", holders);
      }
      await closeOpenClawStateDatabaseAsync();
      expect(
        getActiveGatewayRootWorkCount(),
        JSON.stringify(getActiveGatewayRootWorkHolders()),
      ).toBe(0);
    }
  });
}

export async function requestTasks(ownerKey: string, respond = vi.fn()) {
  const client: GatewayClient = {
    connId: "task-read-fixture",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.read"],
    },
  };
  await handleGatewayRequest({
    req: {
      type: "req",
      id: "task-read",
      method: "tasks.list",
      params: { limit: 5, sessionKey: ownerKey },
    },
    client,
    context: { getRuntimeConfig: () => ({}) } as GatewayRequestContext,
    methodRegistry: createGatewayMethodRegistry(
      createCoreGatewayMethodDescriptors(coreGatewayHandlers),
    ),
    isWebchatConnect: () => false,
    respond,
  });
  return respond;
}

export function resetReadState() {
  vi.restoreAllMocks();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  resetGatewayWorkAdmission();
  subagentRuns.clear();
}

export function createReadTask(runId: string) {
  return createTaskFixture("cli", {
    runId,
    task: "Read accepted events",
    status: "running",
    notifyPolicy: "silent",
    deliveryStatus: "not_applicable",
  });
}
