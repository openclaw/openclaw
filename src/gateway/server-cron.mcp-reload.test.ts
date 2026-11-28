import { expect, test, vi } from "vitest";
import { cleanupTempDirs } from "../../test/helpers/temp-dir.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agents/agent-bundle-mcp-manager.test-support.js";
import { createMcpProbeFixture } from "../agents/agent-bundle-mcp-probe.test-support.js";
import { createDefaultDeps } from "../cli/deps.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { buildGatewayCronService } from "./server-cron.js";

test("a running cron service can call an MCP server added after startup", async ({
  onTestFinished,
}) => {
  const tempDirs: string[] = [];
  onTestFinished(() => cleanupTempDirs(tempDirs));
  onTestFinished(clearRuntimeConfigSnapshot);
  await bindSessionMcpRuntimeTestScheduler();
  const fixture = await createMcpProbeFixture(tempDirs);
  await withOpenClawTestState({ prefix: "cron-mcp-reload-" }, async (state) => {
    const cfg = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      plugins: { enabled: false },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const { cron } = buildGatewayCronService({
      cfg,
      storePath: state.path("cron", "jobs.json"),
      scheduler: createTestGatewayScheduler(),
      deps: createDefaultDeps(),
      broadcast: vi.fn(),
    });
    try {
      const next = { ...cfg, ...fixture.config() };
      setRuntimeConfigSnapshot(next, next);
      const job = await cron.add({
        name: "MCP after reload",
        enabled: true,
        schedule: { kind: "every", everyMs: 30_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        agentId: "main",
        payload: { kind: "systemEvent", text: "must not fire", toolsAllow: ["healthy__probe"] },
        trigger: {
          script: "await MCP.healthy.probe({}); return { fire: false, state: 'called' };",
        },
      });
      await cron.run(job.id, "force");
      expect((await cron.readJob(job.id))?.state).toMatchObject({ triggerState: "called" });
    } finally {
      await cron.stopAndDrain?.();
    }
  });
});
