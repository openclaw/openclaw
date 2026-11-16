import { randomUUID } from "node:crypto";
import { onTestFinished, vi } from "vitest";
import { createMockSubsystemLogger } from "../../test/helpers/mock-subsystem-logger.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import {
  releaseSessionControllerClaim,
  retireSessionControllerInput,
} from "../sessions/session-controller.mailbox.js";
import type { RpcSourceRef } from "../sessions/session-controller.rpc-sources.js";
import { getRpcSourceProjectSessionActive } from "../sessions/session-controller.rpc-sources.js";
import { registerChatAbortController } from "./chat-abort.js";
import type { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import { createSubscriptionTestParams } from "./server-runtime-subscriptions.params.test-support.js";

export { waitForFast } from "../../test/helpers/vitest-wait.js";

export function createSubscriptionTestFixture() {
  const warn = vi.fn();
  const log = createMockSubsystemLogger("gateway-test", { isEnabled: () => true, warn });
  return {
    log,
    warn,
    createParams: () => createSubscriptionTestParams(log),
  };
}

export function registerSubscriptionChatRun(
  _params: Parameters<typeof startGatewayEventSubscriptions>[0],
  input: Omit<Parameters<typeof registerChatAbortController>[0], "timeoutMs">,
) {
  const registration = registerChatAbortController({
    ...input,
    target:
      input.target ??
      captureSessionTarget({
        storeScope: `/synthetic/subscription/${randomUUID()}/sessions`,
        sessionKey: input.sessionKey ?? "agent:main:subscription",
        agentId: input.agentId,
        incarnation: input.sessionId,
      }),
    timeoutMs: 60_000,
  });
  if (!registration.entry) {
    throw new Error("expected registered chat abort controller");
  }
  registration.initializeTiming();
  const entry = registration.entry;
  onTestFinished(async () => {
    const claim = entry.input.claim;
    claim?.operation?.complete();
    if (claim) {
      releaseSessionControllerClaim(claim);
      await Promise.allSettled([claim.settlement.promise]);
    }
    registration.cleanup();
    retireSessionControllerInput(entry.input);
    await Promise.allSettled([entry.input.settlement.promise]);
  });
  return { ...registration, entry };
}

export function readLifecycleState(entry: RpcSourceRef) {
  return {
    projectSessionActive: getRpcSourceProjectSessionActive(entry),
    projectSessionTerminalPending: entry.adapter.projectSessionTerminalPending,
    projectSessionTerminalObservedAt: entry.adapter.projectSessionTerminalObservedAt,
    projectSessionTerminalPersistence: entry.adapter.projectSessionTerminalPersistence,
    projectSessionTerminalPersisted: entry.adapter.projectSessionTerminalPersisted,
    retirementRequested: entry.input.retirementRequested,
  };
}

export function lifecycleState(
  projectSessionActive: boolean | undefined,
  projectSessionTerminalPending?: boolean,
  projectSessionTerminalObservedAt?: number,
  projectSessionTerminalPersistence?: Promise<void>,
  projectSessionTerminalPersisted?: boolean,
  retirementRequested?: boolean,
): ReturnType<typeof readLifecycleState> {
  return {
    projectSessionActive,
    projectSessionTerminalPending,
    projectSessionTerminalObservedAt,
    projectSessionTerminalPersistence,
    projectSessionTerminalPersisted,
    retirementRequested,
  };
}
