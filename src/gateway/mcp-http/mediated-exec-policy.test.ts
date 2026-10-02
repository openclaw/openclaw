import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import "../../agents/test-helpers/fast-coding-tools.js";
import "../../agents/test-helpers/fast-openclaw-tools.js";
import { resolveMcpLoopbackScopedTools } from "../mcp-http.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const callGatewayTool = vi.hoisted(() =>
  vi.fn(async () => ({ id: "review-approval", decision: null })),
);
vi.mock("../../agents/tools/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/tools/gateway.js")>()),
  callGatewayTool,
}));

describe("CLI mediated exec policy", () => {
  beforeEach(() => {
    callGatewayTool.mockClear();
  });

  it.each([
    { security: "deny" as const, ask: "off" as const },
    { security: "allowlist" as const, ask: "always" as const },
  ])("keeps cron exec policy $security/$ask", async ({ security, ask }) => {
    const root = tempDirs.make("openclaw-mediated-exec-policy-");
    const scope = await resolveMcpLoopbackScopedTools({
      cfg: {
        plugins: { enabled: false },
        tools: {
          exec: { host: "gateway" as const, security, ask },
        },
      },
      context: {
        sessionKey: "agent:main:cron:review",
        workspaceDir: root,
        senderIsOwner: false,
        trigger: "cron",
        toolsAllow: ["exec"],
      },
    });
    const exec = scope.tools.find((tool) => tool.name === "exec")!;
    await expect(exec.execute("denied-command", { command: "printf review" })).rejects.toThrow(
      /denied|security=deny/,
    );
    if (ask === "always") {
      expect(callGatewayTool).toHaveBeenCalledWith(
        "exec.approval.request",
        expect.anything(),
        expect.objectContaining({ security, ask, deliverToApprovalClientsOnly: true }),
        expect.anything(),
      );
    } else {
      expect(callGatewayTool).not.toHaveBeenCalled();
    }
  });
});
