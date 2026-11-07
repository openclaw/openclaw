import { AsyncLocalStorage } from "node:async_hooks";
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

  it("rejects a retired caller before agent handoff and preserves caller scope for agent.wait", async () => {
    await withOpenClawTestState({ label: "agent-caller-entry" }, async (state) => {
      const context = createContext();
      const host = await createAdmittedHostCapabilityTestFixture({
        runId: "caller-entry",
        agentId: "main",
        sessionKey: "agent:main:requester",
        workspaceDir: state.workspaceDir,
      });
      let retainedLaunch: (() => Promise<unknown>) | undefined;
      const tool: AnyAgentTool = {
        name: "wait_probe",
        label: "Wait probe",
        description: "Inspect scoped dispatch",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          const caller = getGatewayToolCallerIdentity();
          expect(caller?.operationalRunInstance).toBe(
            host.admittedRunContext.operationalRunInstance,
          );
          waitForTurn.mockImplementation(async () => {
            expect(getGatewayToolCallerIdentity()).toBe(caller);
            captureGatewayToolCallerAssertion()?.();
            return { result: { runId: "waited-run", status: "ok" } };
          });
          await expect(
            dispatchGatewayMethodInProcess(
              "agent.wait",
              { runId: "waited-run" },
              { forceSyntheticClient: true, resolveGatewayContext: () => context },
            ),
          ).resolves.toEqual({ runId: "waited-run", status: "ok" });
          const snapshot = AsyncLocalStorage.snapshot();
          retainedLaunch = () =>
            snapshot(() =>
              dispatchGatewayMethodInProcess(
                "agent",
                { message: "expired probe", idempotencyKey: "expired-probe" },
                { forceSyntheticClient: true, resolveGatewayContext: () => context },
              ),
            );
          return { content: [], details: {} };
        },
      };
      try {
        const [bound] = host.hostCapabilities.bindToolSurface([tool]);
        await bound!.execute("wait-probe", {});
        host.closeHost();
        expect(retainedLaunch).toBeDefined();
        await expect(retainedLaunch!()).rejects.toThrow(
          "agent tool caller authority is no longer active",
        );
        expect(startTurn).not.toHaveBeenCalled();
      } finally {
        host.closeHost();
        host.closeAdmission();
      }
    });
  });
});
