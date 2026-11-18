import { afterEach, expect, test, vi } from "vitest";
import {
  claimAgentRunApprovalAuthority,
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
} from "../../infra/agent-run-registry.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { createAgentRuntimeAuthorityGuard } from "./agent-runtime-authority.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

afterEach(() => resetAgentRunRegistryForTest());

test.each(["run release", "tool abort"])(
  "admitted effects keep policy but remain fenced by %s",
  (closure) => {
    let sourceAllowed = true;
    const assertSource = vi.fn(() => {
      if (!sourceAllowed) {
        throw new Error("operator role changed");
      }
    });
    const instance = { runId: "guard-run", instanceId: "guard-instance" };
    const root = claimAgentRunDelegatedAuthority(instance, assertSource);
    const tool = new AbortController();
    const delegated = claimAgentRunApprovalAuthority(root, [tool.signal]);
    const client = {
      internal: {
        agentRuntimeIdentity: {
          kind: "agentRuntime",
          agentId: "main",
          sessionKey: "agent:main:guard",
          operationalRunInstance: instance,
          delegatedAuthority: { kind: "local", ...delegated },
        },
      },
    } as GatewayClient;
    const context = {
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    } as GatewayRequestContext;
    const respond = vi.fn();
    const guard = createAgentRuntimeAuthorityGuard(client, context, respond);
    expect(guard.ensureActive()).toBe(true);
    assertSource.mockClear();

    sourceAllowed = false;
    expect(guard.commitGuard).toBeTypeOf("function");
    expect(() => guard.commitGuard?.()).not.toThrow();
    expect(assertSource).not.toHaveBeenCalled();

    if (closure === "run release") {
      releaseAgentRunDelegatedAuthority(root);
    } else {
      tool.abort();
    }
    expect(() => guard.commitGuard?.()).toThrow("agent runtime authority is no longer active");
    expect(createAgentRuntimeAuthorityGuard(client, context, respond).ensureActive()).toBe(false);
  },
);
