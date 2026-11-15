import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import { createExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import { configureRuntimeActionDecisionSink } from "../audit/runtime-action-decision.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { ApprovalObserverClosedError } from "./exec-approval-lifecycle.js";
import { applyPluginNodeInvokePolicy } from "./node-invoke-plugin-policy.js";
import {
  createNodeSession,
  createRuntimeClient,
} from "./node-invoke-plugin-policy.test-helpers.js";
import type { NodeInvokeResult } from "./node-registry.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

const PLUGIN_ID = "secret-demo-plugin";
const COMMAND = "secret.demo.read";
let receipts: DecisionReceiptV1[];
let clearReceipts: () => void;
let authorityScenario: Promise<void> | undefined;

function fixture(commands = [COMMAND], runId = "run-node-receipt") {
  const node = createNodeSession({
    nodeId: "secret-node-id",
    declaredCommands: commands,
    commands,
  });
  const client = createRuntimeClient(runId, "agent:main:test", {
    lifecycleGeneration: "test-generation",
    claimId: "test-claim",
  });
  const identity = client.internal?.agentRuntimeIdentity;
  assert(identity, "Missing test runtime identity");
  identity.executionIdentity = createExecutionIdentityAdmissionToken(runId, {
    contextId: `context-${runId}`,
    executionId: `execution-${runId}`,
    now: 100,
  });
  const invoke = vi.fn(
    async (params?: {
      onDispatchReady?: (invokeId: string) => void;
    }): Promise<NodeInvokeResult> => {
      params?.onDispatchReady?.("invoke-1");
      return { ok: true, payload: { ok: true }, payloadJSON: null, error: null };
    },
  );
  const context = {
    getRuntimeConfig: () => ({ gateway: { nodes: { commands: { allow: [COMMAND] } } } }),
    nodeRegistry: { get: () => node, invoke },
    validateAgentRuntimeApprovalAuthority: () => true,
  } as unknown as GatewayRequestContext;
  return {
    context,
    invoke,
    run: () =>
      applyPluginNodeInvokePolicy({
        context,
        client: {
          ...client,
          connId: "caller-conn",
          connect: { client: { id: "caller" }, scopes: ["operator.admin"] },
        } as unknown as GatewayClient,
        nodeSession: node,
        command: COMMAND,
        params: { private: "arguments" },
      }),
  };
}

function registerPolicy(handle: PluginRegistry["nodeInvokePolicies"][number]["policy"]["handle"]) {
  const registry = createEmptyPluginRegistry();
  registry.nodeInvokePolicies.push({
    pluginId: PLUGIN_ID,
    policy: { commands: [COMMAND], handle },
    pluginConfig: {},
    source: "test",
  });
  setActivePluginRegistry(registry);
}

function expectedReceipt(outcome: string, reasonCode: string, coverageState = "enforced") {
  return { decision: { outcome, reasonCode }, enforcement: { coverageState } };
}

describe("plugin node action receipts", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    receipts = [];
    clearReceipts = configureRuntimeActionDecisionSink((receipt) => {
      receipts.push(receipt);
      return true;
    });
  });
  afterEach(async () => {
    // Join the original scenario before removing its receipt sink and registry.
    await Promise.allSettled(authorityScenario ? [authorityScenario] : []);
    authorityScenario = undefined;
    clearReceipts();
    resetPluginRuntimeStateForTest();
  });

  it("records gate enforcement and successful action as attribution only", async () => {
    registerPolicy((ctx) => ctx.invokeNode());
    await expect(fixture().run()).resolves.toMatchObject({ ok: true });
    expect(receipts).toMatchObject([
      expectedReceipt("allowed", "node_dispatch_gate_allowed"),
      expectedReceipt("allowed", "node_action_completed", "attribution-only"),
    ]);
    const serialized = JSON.stringify(receipts);
    expect(serialized).not.toContain(PLUGIN_ID);
    expect(serialized).not.toContain(COMMAND);
    expect(serialized).not.toContain("secret-node-id");
  });

  it("records unknown when the policy omits the expected node callback", async () => {
    registerPolicy(async () => ({ ok: true, payload: "done" }));
    const { invoke, run } = fixture();
    await run();
    expect(invoke).not.toHaveBeenCalled();
    expect(receipts).toMatchObject([
      {
        ...expectedReceipt("unknown", "node_action_callback_missing", "unknown"),
        missingEvidence: ["node.action_callback"],
      },
    ]);
  });

  it("records node capability denial at the owning dispatch gate", async () => {
    registerPolicy((ctx) => ctx.invokeNode());
    const { run, invoke } = fixture([]);
    await expect(run()).resolves.toMatchObject({ ok: false, code: "NODE_COMMAND_REVOKED" });
    expect(invoke).not.toHaveBeenCalled();
    expect(receipts).toMatchObject([expectedReceipt("denied", "node_command_revoked")]);
  });

  it("does not turn a closed approval observation into a denied policy receipt", async () => {
    const closed = new ApprovalObserverClosedError();
    registerPolicy(async () => {
      throw closed;
    });
    await expect(fixture().run()).rejects.toBe(closed);
    expect(receipts).toEqual([]);
  });

  it.for(["allowed", "denied", "throws"] as const)(
    "does not attribute a late %s policy result after runtime authority closes",
    (outcome, testContext) => {
      const policyStarted = createDeferred();
      const policyWait = createDeferred();
      const lateError = new Error("late policy failure");
      let authorityActive = true;
      let operation: ReturnType<ReturnType<typeof fixture>["run"]> | undefined;
      authorityScenario = runQaGatewayTestFixture(
        testContext,
        async () => {
          registerPolicy(async () => {
            policyStarted.resolve();
            await policyWait.promise;
            if (outcome === "throws") {
              throw lateError;
            }
            return outcome === "allowed"
              ? { ok: true, payload: "done" }
              : { ok: false, code: "PLUGIN_DENIED", message: "denied" };
          });
          const { context, invoke, run } = fixture(undefined, `run-node-policy-${outcome}`);
          context.validateAgentRuntimeApprovalAuthority = () => authorityActive;
          operation = run();
          await withinTest(
            awaitGateBeforeSettlement(
              policyStarted.promise,
              operation,
              "Plugin invocation ended before policy entry",
            ),
            testContext.signal,
          );
          authorityActive = false;
          policyWait.resolve();
          await withinTest(
            outcome === "throws"
              ? expect(operation).rejects.toBe(lateError)
              : expect(operation).resolves.toMatchObject({ ok: outcome === "allowed" }),
            testContext.signal,
          );
          expect(invoke).not.toHaveBeenCalled();
          expect(receipts).toEqual([]);
        },
        () => {
          authorityActive = false;
          policyWait.resolve();
        },
        () => Promise.allSettled(operation ? [operation] : []),
      );
      return authorityScenario;
    },
  );
});
