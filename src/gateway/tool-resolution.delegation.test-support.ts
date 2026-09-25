import { expect, it, type Mock } from "vitest";
import type { createInheritedToolPolicyMatcher } from "../agents/inherited-tool-policy.js";
import type { InheritedToolPolicyV2 } from "../agents/inherited-tool-policy.schema.js";
import {
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "./mcp-http.runtime.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

export function registerGatewayDelegationCaptureTests({
  readInheritedPolicy,
  readInheritedMatcher,
  createLazyExecToolMock,
}: {
  readInheritedPolicy: () => Promise<InheritedToolPolicyV2>;
  readInheritedMatcher: () => Promise<ReturnType<typeof createInheritedToolPolicyMatcher>>;
  createLazyExecToolMock: Mock;
}): void {
  it.each([
    { mode: "exact", allow: undefined, expected: [true, true, true] },
    { mode: "exact", allow: ["sessions_spawn", "write"], expected: [true, false, false] },
    { mode: "policy", allow: ["sessions_spawn", "write"], expected: [true, true, false] },
    { mode: "exact", allow: ["sessions_spawn", "browser"], expected: [false, false, true] },
    { mode: "exact", allow: [], expected: [false, false, false] },
    { mode: "policy", allow: [], expected: [false, false, false] },
  ] as const)(
    "retains $mode MCP grant policy independently of native availability: $allow",
    async ({ mode, allow, expected }) => {
      const resolve =
        mode === "exact" ? resolveMcpLoopbackScopedTools : resolveMcpLoopbackPolicyTools;
      const result = await resolve({
        cfg: { tools: { allow: ["sessions_spawn", "write", "browser"] } },
        context: {
          sessionKey: "agent:main:main",
          senderIsOwner: true,
          toolsAllow: allow === undefined ? undefined : [...allow],
        },
      });
      // Browser is configured but absent from this owner's concrete tool bundle.
      expect(result.tools.some((tool) => tool.name === "browser")).toBe(false);
      const inherited = await readInheritedMatcher();
      expect(["write", "apply_patch", "browser"].map((name) => inherited({ name }))).toEqual(
        expected,
      );
    },
  );

  it("captures the scheduled host and approval floor without creating a node escape", async () => {
    const result = resolveGatewayScopedTools({
      cfg: {},
      sessionKey: "agent:main:cron:scheduled",
      surface: "loopback",
      senderIsOwner: true,
      execSession: { permissionMode: "full" },
      execOverrides: { mode: "full" },
      includeNodeExecTool: true,
      nodeExecAvailable: () => true,
      scheduledToolPolicy: {
        version: 1,
        mode: "trusted",
        execTarget: { host: "gateway", ask: "always" },
      },
    });
    expect((await readInheritedPolicy()).parameters.exec).toContainEqual(
      expect.objectContaining({
        host: "gateway",
        security: "full",
        ask: "always",
        autoReview: false,
        bypassHostApprovalFloors: false,
      }),
    );
    expect(result.tools.some((tool) => tool.name === "exec")).toBe(false);
    expect(createLazyExecToolMock).not.toHaveBeenCalled();
  });
}
