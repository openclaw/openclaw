import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmittedHostCapabilityTestFixture } from "../agents/harness/host-capability.test-support.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

const startTurn = vi.hoisted(() => vi.fn());
const waitForTurn = vi.hoisted(() => vi.fn());

// mock-isolation: Keep real dispatch/caller owners; control only turn acceptance and settlement.
vi.mock("./agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn, waitForTurn }),
}));

describe("in-process agent caller lifetime", () => {
  beforeEach(() => {
    startTurn.mockReset();
    waitForTurn.mockReset();
  });

  it.each(["host", "admission"] as const)(
    "detaches an accepted agent turn from the caller's %s lifetime",
    async (owner) => {
      await withOpenClawTestState({ label: "agent-caller-handoff" }, async (state) => {
        const context = createContext();
        const host = await createAdmittedHostCapabilityTestFixture({
          runId: `caller-${owner}`,
          agentId: "main",
          sessionKey: "agent:main:requester",
          workspaceDir: state.workspaceDir,
        });
        const release = createDeferredCore();
        let continuation: Promise<ReturnType<typeof getGatewayToolCallerIdentity>> | undefined;
        const accepted = { runId: `target-${owner}`, status: "accepted" };
        startTurn.mockImplementation(({ io }) => {
          continuation = (async () => {
            io.emitAcceptance([true, accepted, undefined]);
            await release.promise;
            // Tool-catalog construction captures this same original assertion.
            captureGatewayToolCallerAssertion()?.();
            return getGatewayToolCallerIdentity();
          })();
          void continuation.catch(() => {});
          return continuation;
        });
        const tool: AnyAgentTool = {
          name: "launch_probe",
          label: "Launch probe",
          description: "Launch a synthetic agent turn",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            const caller = getGatewayToolCallerIdentity();
            expect(caller?.operationalRunInstance).toBe(
              host.admittedRunContext.operationalRunInstance,
            );
            const result = await dispatchGatewayMethodInProcess(
              "agent",
              {
                message: "handoff probe",
                idempotencyKey: accepted.runId,
                sessionKey: "agent:main:target",
              },
              { forceSyntheticClient: true, resolveGatewayContext: () => context },
            );
            expect(result).toEqual(accepted);
            expect(getGatewayToolCallerIdentity()).toBe(caller);
            return { content: [], details: {} };
          },
        };
        try {
          const [bound] = host.hostCapabilities.bindToolSurface([tool]);
          await bound!.execute("launch-probe", {});
          if (owner === "host") {
            host.closeHost();
          } else {
            host.closeAdmission();
          }
          release.resolve();
          expect(continuation).toBeDefined();
          await expect(continuation).resolves.toBeUndefined();
        } finally {
          release.resolve();
          await Promise.allSettled(continuation ? [continuation] : []);
          host.closeHost();
          host.closeAdmission();
        }
      });
    },
  );
});
