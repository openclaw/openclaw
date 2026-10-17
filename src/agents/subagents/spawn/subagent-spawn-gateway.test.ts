import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperatorScope } from "../../../gateway/method-scopes.js";
import { captureGatewayOperatorRunAuthority } from "../../../gateway/operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { resolveSubagentRunDurationMs } from "../registry/subagent-run-timeout.js";
import {
  callNativeSubagentGateway,
  resolveSubagentAgentGatewayTimeoutMs,
} from "./subagent-spawn-gateway.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

const startTurn = vi.hoisted(() => vi.fn());
// mock-isolation: Observe real admission without starting model execution or retaining turn state.
vi.mock("../../../gateway/agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn, waitForTurn: vi.fn() }),
}));

vi.mock("./subagent-spawn.runtime.js", async () => {
  const dispatch = await import("../../../gateway/server-plugin-in-process-dispatch.js");
  const scopes = await import("../../../gateway/method-scopes.js");
  return {
    ...scopes,
    dispatchGatewayMethodInProcess: dispatch.dispatchGatewayMethodInProcess,
    hasInProcessGatewayContext: () => Boolean(dispatch.getInProcessGatewayRequestContext()),
    callGateway: vi.fn(),
    ensureContextEnginesInitialized: vi.fn(),
    forkSessionEntryFromParent: vi.fn(),
    getGlobalHookRunner: vi.fn(),
    getRuntimeConfig: vi.fn(),
    prepareModelChoice: vi.fn(),
    resolveContextEngine: vi.fn(),
  };
});

vi.mock("../../tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));

afterEach(() => {
  spawnTesting.setDepsForTest();
  startTurn.mockReset();
});

describe("native subagent Gateway transport ownership", () => {
  it.each<{
    name: string;
    source: string[];
    explicit?: OperatorScope[];
    systemCeiling?: string[];
    expected?: string[];
  }>([
    {
      name: "inherited approvals",
      source: ["operator.write", "operator.approvals"],
      expected: ["operator.write", "operator.approvals"],
    },
    { name: "write without approvals", source: ["operator.write"], expected: ["operator.write"] },
    {
      name: "explicit write ceiling on admin",
      source: ["operator.admin"],
      explicit: ["operator.write"],
      expected: ["operator.write"],
    },
    { name: "explicit empty ceiling", source: ["operator.admin"], explicit: [] },
    {
      name: "System write ceiling",
      source: ["operator.write", "operator.approvals"],
      systemCeiling: ["operator.write"],
      expected: ["operator.write"],
    },
    {
      name: "System empty ceiling",
      source: ["operator.write", "operator.approvals"],
      systemCeiling: [],
    },
  ])("preserves $name through native child admission", async (testCase) => {
    const context = createContext();
    const source = createOperatorClient({
      profileName: "native-approval-owner",
      scopes: testCase.source,
    });
    const captured = await captureGatewayOperatorRunAuthority({ client: source, context });
    expect(captured).toBeDefined();
    const client = {
      ...source,
      connect: { ...source.connect, scopes: testCase.systemCeiling ?? testCase.source },
      internal: {
        operatorRunAuthority: captured!.authority,
        ...(testCase.systemCeiling ? { operatorRoleActor: { kind: "system" as const } } : {}),
      },
    };
    const result = { runId: "native-approval-run", status: "accepted" };
    // The real dispatcher and facade own scope admission; execution stops at startTurn.
    startTurn.mockImplementation(async ({ principal, io }) => {
      expect(principal.connect.scopes).toEqual(testCase.expected);
      expect(principal.internal.operatorRunAuthority.scopes).toEqual(testCase.expected);
      io.emitAcceptance([true, result, undefined]);
    });
    try {
      const launch = withPluginRuntimeGatewayRequestScope(
        { client, context, isWebchatConnect: () => false },
        () =>
          callNativeSubagentGateway({
            method: "agent",
            params: { message: "request native child work", idempotencyKey: result.runId },
            scopes: testCase.explicit,
          }),
      );
      if (testCase.expected) {
        await expect(launch).resolves.toEqual({ response: result, registrationRequired: true });
        expect(startTurn).toHaveBeenCalledOnce();
      } else {
        await expect(launch).rejects.toThrow("missing scope: operator.write");
        expect(startTurn).not.toHaveBeenCalled();
      }
    } finally {
      captured?.release();
    }
  });

  it("caps Gateway timer delays without shortening semantic run durations", () => {
    const thirtyDaysSeconds = 30 * 24 * 60 * 60;

    expect(resolveSubagentAgentGatewayTimeoutMs(thirtyDaysSeconds)).toBe(300_000);
    expect(resolveSubagentRunDurationMs(thirtyDaysSeconds)).toBe(2_592_000_000);
  });

  it.each(["caller", "captured", "scoped"])(
    "rejects a retired %s binding without opening a socket",
    async (binding) => {
      const callGateway = vi.fn<() => void>();
      spawnTesting.setDepsForTest({
        callGateway: async <T>() => {
          callGateway();
          return { runId: "wrong-gateway", status: "accepted" } as T;
        },
      });
      const resolver = () => undefined;
      const launch = () =>
        callNativeSubagentGateway(
          {
            method: "agent",
            params: { message: "must not launch", idempotencyKey: "closed-owner" },
          },
          undefined,
          binding === "captured" ? resolver : undefined,
        );
      const result =
        binding === "caller"
          ? withGatewayToolCallerIdentity(
              { agentId: "main", sessionKey: "agent:main:main", gatewayContextResolver: resolver },
              launch,
            )
          : binding === "scoped"
            ? withPluginRuntimeGatewayRequestScope(
                { resolveGatewayContext: resolver, isWebchatConnect: () => false },
                launch,
              )
            : launch();

      await expect(result).rejects.toThrow("instance binding");
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it("preserves acceptance when the source closes after the child is admitted", async () => {
    let current = true;
    const assertDispatchCurrent = () => {
      if (!current) {
        throw new Error("source closed");
      }
    };
    spawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => true,
      dispatchGatewayMethodInProcess: async <T>(
        _method: string,
        _params: Record<string, unknown>,
      ) => {
        assertDispatchCurrent();
        current = false;
        return { runId: "accepted-child", status: "accepted" } as T;
      },
    });
    await expect(
      callNativeSubagentGateway({
        method: "agent",
        params: { message: "start", idempotencyKey: "accepted-child" },
        assertDispatchCurrent,
      }),
    ).resolves.toMatchObject({
      response: { runId: "accepted-child" },
    });
  });

  it("keeps socket dispatch available when no Gateway owner was bound", async () => {
    const callGateway = vi.fn<() => void>();
    spawnTesting.setDepsForTest({
      callGateway: async <T>() => {
        callGateway();
        return { runId: "remote-run", status: "accepted" } as T;
      },
    });

    await expect(
      callNativeSubagentGateway({
        method: "agent",
        params: { message: "standalone", idempotencyKey: "remote-run" },
      }),
    ).resolves.toEqual({
      response: { runId: "remote-run", status: "accepted" },
      registrationRequired: false,
    });
    expect(callGateway).toHaveBeenCalledOnce();
  });
});
