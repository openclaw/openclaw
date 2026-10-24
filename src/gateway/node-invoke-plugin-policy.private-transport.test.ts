import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type { OpenClawPluginNodeInvokePolicyContext } from "../plugins/types.js";
import type { PluginNodeInvokePrivateTransport } from "./node-invoke-plugin-policy.js";
import {
  createContext,
  createDemoPolicy,
  createNodeSession,
  createOperatorClient,
  createPolicyApprovalFixture,
  createRuntimeClient,
  DEMO_COMMAND,
  DEMO_PARAMS,
  invokeDemoPolicy,
  nodeCommandsConfig,
  setDangerousDemoCommandRegistry,
} from "./node-invoke-plugin-policy.test-helpers.js";
import { createApprovalClientLookup } from "./server-methods/approval-request.test-support.js";

function createPrivateTransport() {
  const invoke = vi.fn<PluginNodeInvokePrivateTransport["invoke"]>(async (request) => {
    request.onDispatchReady("private-invoke");
    return { ok: true, payload: { completed: true } };
  });
  return {
    commands: [DEMO_COMMAND],
    isCurrent: (): boolean => true,
    invoke,
  } satisfies PluginNodeInvokePrivateTransport;
}

describe("private node policy transport", () => {
  beforeEach(resetPluginRuntimeStateForTest);
  afterEach(resetPluginRuntimeStateForTest);

  it("uses the registered risk and approval policy without advertising the private capability", async (testContext) => {
    const reviewer = createOperatorClient();
    const node = createNodeSession({ commands: [] });
    const fixture = createPolicyApprovalFixture(
      testContext,
      {},
      {
        nodeSession: node,
        getApprovalClientConnIds: createApprovalClientLookup([reviewer]),
      },
    );
    const { manager, invoke } = fixture;
    await fixture.run(async () => {
      const handle = vi.fn(async (policyContext: OpenClawPluginNodeInvokePolicyContext) => {
        expect(policyContext.risk).toEqual({ level: "high", family: "fixture_mutation" });
        const decision = await policyContext.approvals?.request({
          title: "Private desktop action",
          description: "Approve this action on the selected session desktop",
        });
        if (decision?.decision !== "allow-once") {
          return { ok: false as const, message: "approval required" };
        }
        return await policyContext.invokeNode();
      });
      const registration = createDemoPolicy(handle);
      registration.policy.classifyRisk = vi.fn<
        NonNullable<typeof registration.policy.classifyRisk>
      >(({ command, params }) => {
        expect({ command, params }).toEqual({ command: DEMO_COMMAND, params: DEMO_PARAMS });
        return { level: "high", family: "fixture_mutation" };
      });
      setDangerousDemoCommandRegistry([registration]);
      const privateTransport = createPrivateTransport();
      const onNodeCommandDispatched = vi.fn();
      const { record: approval, pending: result } = await fixture.request(reviewer, {
        nodeSession: node,
        privateTransport,
        deadlineAtMs: performance.now() + 5_000,
        onNodeCommandDispatched,
      });
      expect(privateTransport.invoke).not.toHaveBeenCalled();
      expect(await manager.resolve(approval.id, "allow-once")).toBe(true);
      await expect(result).resolves.toMatchObject({ ok: true, payload: { completed: true } });
      expect(registration.policy.classifyRisk).toHaveBeenCalledOnce();
      expect(handle).toHaveBeenCalledOnce();
      expect(privateTransport.invoke).toHaveBeenCalledOnce();
      expect(privateTransport.invoke.mock.calls[0]?.[0]).not.toHaveProperty("deadlineAtMs");
      expect(onNodeCommandDispatched).toHaveBeenCalledOnce();
      expect((await manager.getSnapshot(approval.id))?.consumedDecision).toBe("allow-once");
      expect(node.commands).toEqual([]);
      expect(invoke).not.toHaveBeenCalled();
    });
  });

  it("rejects private dispatch without a registered policy", async () => {
    setDangerousDemoCommandRegistry([]);
    const { context, invoke } = createContext();
    const privateTransport = createPrivateTransport();

    await expect(invokeDemoPolicy(context, null, { privateTransport })).resolves.toMatchObject({
      ok: false,
      code: "PLUGIN_POLICY_MISSING",
      details: { nodeCommandDispatched: false },
    });
    expect(privateTransport.invoke).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["owner", "capability", "pairing", "approval", "runtime"] as const)(
    "rejects private dispatch when %s changes during policy work",
    async (change) => {
      const node = createNodeSession({ commands: [] });
      let runtimeCurrent = true;
      let approvalCurrent = true;
      const { context, invoke } = createContext({
        nodeSession: node,
        validateAgentRuntimeApprovalAuthority: () => runtimeCurrent,
      });
      const privateTransport = createPrivateTransport();
      setDangerousDemoCommandRegistry([
        createDemoPolicy(async (ctx) => {
          await Promise.resolve();
          switch (change) {
            case "owner":
              privateTransport.isCurrent = () => false;
              break;
            case "capability":
              privateTransport.commands = [];
              break;
            case "pairing":
              node.client.invalidated = true;
              break;
            case "approval":
              approvalCurrent = false;
              break;
            case "runtime":
              runtimeCurrent = false;
              break;
          }
          return await ctx.invokeNode();
        }),
      ]);
      await expect(
        invokeDemoPolicy(
          context,
          createRuntimeClient("private-policy-run", "agent:main:private-policy"),
          {
            nodeSession: node,
            privateTransport,
            isApprovalAuthorityActive: () => approvalCurrent,
          },
        ),
      ).resolves.toMatchObject({ ok: false, details: { nodeCommandDispatched: false } });
      expect(privateTransport.invoke).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it.each(["owner", "plugin", "deny", "approval"] as const)(
    "carries the %s gate through the private transport's final send",
    async (change) => {
      setDangerousDemoCommandRegistry([createDemoPolicy((ctx) => ctx.invokeNode())]);
      const node = createNodeSession({ commands: [] });
      const { context, invoke } = createContext({ nodeSession: node });
      const privateTransport = createPrivateTransport();
      let approvalCurrent = true;
      const execute = vi.fn();
      privateTransport.invoke.mockImplementationOnce(async (request) => {
        await Promise.resolve();
        if (change === "owner") {
          privateTransport.isCurrent = () => false;
        } else if (change === "plugin") {
          setActivePluginRegistry(createEmptyPluginRegistry());
        } else if (change === "deny") {
          context.getRuntimeConfig = () => nodeCommandsConfig({ deny: [DEMO_COMMAND] });
        } else {
          approvalCurrent = false;
        }
        if (!request.isDispatchAuthorized()) {
          return { ok: false, error: { code: "REVOKED", message: "private dispatch revoked" } };
        }
        execute();
        request.onDispatchReady("private-invoke");
        return { ok: true };
      });
      const onNodeCommandDispatched = vi.fn();

      await expect(
        invokeDemoPolicy(context, null, {
          nodeSession: node,
          privateTransport,
          isApprovalAuthorityActive: () => approvalCurrent,
          onNodeCommandDispatched,
        }),
      ).resolves.toMatchObject({
        ok: false,
        code: "REVOKED",
        details: { nodeCommandDispatched: false },
      });
      expect(execute).not.toHaveBeenCalled();
      expect(onNodeCommandDispatched).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
    },
  );
});
