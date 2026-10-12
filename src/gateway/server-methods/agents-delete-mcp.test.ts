import "../../test-utils/prepare-compiled-subprocesses.js";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { startCatalogRecoveryMcpServer } from "../../agents/agent-bundle-mcp-catalog-recovery.test-support.js";
import {
  acquireSessionMcpRuntime,
  disposeAllSessionMcpRuntimes,
  peekSessionMcpRuntime,
  setSessionMcpRuntimeScheduler,
} from "../../agents/agent-bundle-mcp-manager-api.js";
import { releaseSessionMcpRuntime } from "../../agents/agent-bundle-mcp-manager-cleanup.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { drainAgentDeletionRuns } from "./agents-delete-drain.js";

it.each(["keyed", "unkeyed"])(
  "joins an idle %s MCP transport without a session row, preserving a surviving agent",
  async (kind) => {
    await withOpenClawTestState({ label: "agent-delete-mcp" }, async (state) => {
      const termination = createDeferred();
      const doomed = await startCatalogRecoveryMcpServer("doomed", {
        holdTermination: termination.promise,
      });
      const keeper = await startCatalogRecoveryMcpServer("keeper");
      keeper.allowCalls();
      const scheduler = createTestGatewayScheduler();
      let draining: Promise<void> | undefined;
      try {
        await disposeAllSessionMcpRuntimes();
        await setSessionMcpRuntimeScheduler(scheduler);
        const cfg = {
          agents: {
            ownership: "explicit" as const,
            entries: {
              keeper: { workspace: state.workspaceDir },
              doomed: { workspace: state.path("doomed") },
            },
          },
        };
        await state.writeConfig(cfg);
        const runtimes = [];
        for (const [agentId, server] of [
          ["doomed", doomed],
          ["keeper", keeper],
        ] as const) {
          const sessionKey = `agent:${agentId}:idle`;
          if (agentId === "keeper") {
            await replaceSessionEntry(
              { agentId, env: state.env, sessionKey },
              { sessionId: agentId, updatedAt: 1 },
            );
          }
          const lease = await acquireSessionMcpRuntime({
            sessionId: agentId,
            sessionKey: kind === "unkeyed" && agentId === "doomed" ? undefined : sessionKey,
            agentId,
            workspaceDir: state.path(agentId),
            cfg: {
              plugins: { enabled: false },
              mcp: { servers: { fixture: { url: server.url, transport: "streamable-http" } } },
            },
            manifestRegistry: { plugins: [] },
          });
          await lease.runtime.getCatalog();
          await releaseSessionMcpRuntime(lease);
          runtimes.push(lease.runtime);
        }
        const settled = vi.fn();
        draining = drainAgentDeletionRuns("doomed", cfg, createDirectChatContext(), () => {});
        void draining.then(settled, settled);
        await awaitGateBeforeSettlement(
          doomed.terminationStarted,
          draining,
          "agent deletion skipped the idle MCP runtime",
        );
        expect(settled).not.toHaveBeenCalled();
        expect(keeper.terminationCount()).toBe(0);
        await expect(runtimes[1]!.callTool("fixture", "probe", {})).resolves.toMatchObject({
          structuredContent: { revision: "keeper-1" },
        });
        termination.resolve();
        await draining;
        expect(doomed.terminationCount()).toBe(1);
        expect(peekSessionMcpRuntime({ sessionId: "doomed" })).toBeUndefined();
        expect(peekSessionMcpRuntime({ sessionId: "keeper" })).toBe(runtimes[1]);
        expect(keeper.terminationCount()).toBe(0);
      } finally {
        termination.resolve();
        await Promise.allSettled([draining]);
        await disposeAllSessionMcpRuntimes();
        await scheduler.stop();
        await Promise.all([doomed.close(), keeper.close()]);
      }
    });
  },
);
