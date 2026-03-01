import { existsSync } from "node:fs";
import { describe, expect, it, beforeEach } from "vitest";
import { runBeforeToolCallHook } from "./pi-tools.before-tool-call.js";
import { __testing as permissionTesting } from "./tool-permission-contracts.js";

function resolveContractsWorkspace(): string | undefined {
  const fromEnv = process.env.OPENCLAW_CONTRACTS_DIR?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

describe("cordazzo-brain contract conformance", () => {
  const workspaceDir = resolveContractsWorkspace();
  const toolPermissionsPath = workspaceDir
    ? `${workspaceDir}/01_agent_os/core/tool_permissions.yaml`
    : undefined;
  const subagentsPath = workspaceDir
    ? `${workspaceDir}/01_agent_os/behavior/subagents_registry.yaml`
    : undefined;
  const canRun =
    !!workspaceDir &&
    !!toolPermissionsPath &&
    !!subagentsPath &&
    existsSync(toolPermissionsPath) &&
    existsSync(subagentsPath);

  beforeEach(() => {
    permissionTesting.clearContractsCache();
  });

  it("requires contract files when conformance is enabled", () => {
    if (process.env.CI === "true" || process.env.OPENCLAW_CONTRACTS_DIR) {
      expect(canRun).toBe(true);
    }
  });

  it.skipIf(!canRun)(
    "enforces executive no-web/no-send and write scopes from canonical contracts",
    async () => {
      const executiveCtx = {
        agentId: "main",
        sessionKey: "agent:main:main:cordazzo-conformance-exec",
        workspaceDir,
      };
      const blockedWeb = await runBeforeToolCallHook({
        toolName: "browser",
        params: { url: "https://example.com" },
        toolCallId: "exec-web-1",
        ctx: executiveCtx,
      });
      expect(blockedWeb.blocked).toBe(true);
      if (blockedWeb.blocked) {
        expect(blockedWeb.reason).toMatch(/forbidden|disabled|max pages/i);
      }

      const blockedSend = await runBeforeToolCallHook({
        toolName: "message",
        params: { action: "send", message: "test", target: "x" },
        toolCallId: "exec-send-1",
        ctx: executiveCtx,
      });
      expect(blockedSend.blocked).toBe(true);

      const allowedWrite = await runBeforeToolCallHook({
        toolName: "write",
        params: { file_path: "executive/summary.md", content: "ok" },
        toolCallId: "exec-write-allowed-1",
        ctx: executiveCtx,
      });
      expect(allowedWrite.blocked).toBe(false);

      const blockedWrite = await runBeforeToolCallHook({
        toolName: "write",
        params: { file_path: "queue/catering_pipeline_builder/out.md", content: "x" },
        toolCallId: "exec-write-blocked-1",
        ctx: executiveCtx,
      });
      expect(blockedWrite.blocked).toBe(true);
      if (blockedWrite.blocked) {
        expect(blockedWrite.reason).toContain("write scope");
      }
    },
  );

  it.skipIf(!canRun)(
    "enforces catering_pipeline_builder web/write/send boundaries from canonical contracts",
    async () => {
      const subagentCtx = {
        agentId: "catering_pipeline_builder",
        sessionKey: "agent:catering_pipeline_builder:subagent:cordazzo-conformance",
        workspaceDir,
      };
      const firstBrowse = await runBeforeToolCallHook({
        toolName: "browser",
        params: { url: "https://example.com/1" },
        toolCallId: "cat-web-1",
        ctx: subagentCtx,
      });
      expect(firstBrowse.blocked).toBe(false);

      const blockedSend = await runBeforeToolCallHook({
        toolName: "message",
        params: { action: "send", message: "test", target: "x" },
        toolCallId: "cat-send-1",
        ctx: subagentCtx,
      });
      expect(blockedSend.blocked).toBe(true);

      const allowedWrite = await runBeforeToolCallHook({
        toolName: "write",
        params: { file_path: "queue/catering_pipeline_builder/run.md", content: "ok" },
        toolCallId: "cat-write-1",
        ctx: subagentCtx,
      });
      expect(allowedWrite.blocked).toBe(false);

      const blockedWrite = await runBeforeToolCallHook({
        toolName: "write",
        params: { file_path: "executive/run.md", content: "x" },
        toolCallId: "cat-write-2",
        ctx: subagentCtx,
      });
      expect(blockedWrite.blocked).toBe(true);
    },
  );

  it.skipIf(!canRun)(
    "enforces cost_controller no-web/no-send and queue-scoped writes from canonical contracts",
    async () => {
      const subagentCtx = {
        agentId: "cost_controller",
        sessionKey: "agent:cost_controller:subagent:cordazzo-conformance",
        workspaceDir,
      };
      const blockedWeb = await runBeforeToolCallHook({
        toolName: "browser",
        params: { url: "https://example.com/blocked" },
        toolCallId: "cost-web-1",
        ctx: subagentCtx,
      });
      expect(blockedWeb.blocked).toBe(true);

      const blockedSend = await runBeforeToolCallHook({
        toolName: "sessions_send",
        params: { sessionKey: "agent:main:main", message: "x" },
        toolCallId: "cost-send-1",
        ctx: subagentCtx,
      });
      expect(blockedSend.blocked).toBe(true);

      const allowedWrite = await runBeforeToolCallHook({
        toolName: "write",
        params: { file_path: "queue/cost_controller/report.md", content: "ok" },
        toolCallId: "cost-write-1",
        ctx: subagentCtx,
      });
      expect(allowedWrite.blocked).toBe(false);

      const blockedWrite = await runBeforeToolCallHook({
        toolName: "write",
        params: { file_path: "queue/catering_pipeline_builder/report.md", content: "x" },
        toolCallId: "cost-write-2",
        ctx: subagentCtx,
      });
      expect(blockedWrite.blocked).toBe(true);
    },
  );
});
