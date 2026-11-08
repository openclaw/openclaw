import fs from "node:fs/promises";
import { expect, vi } from "vitest";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../config/config.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import { CronService } from "../../cron/service.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";

export const deletionGatewayEnv = {
  OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  OPENCLAW_SKIP_PROVIDERS: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_SKIP_CANVAS_HOST: "1",
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
};

export async function configureDeletionAgents(
  state: OpenClawTestState,
  workspace = state.path("doomed"),
  defaults?: Pick<AgentDefaultsConfig, "skipBootstrap">,
) {
  await state.writeConfig({
    agents: {
      ownership: "explicit",
      ...(defaults ? { defaults } : {}),
      entries: { keeper: { workspace: state.workspaceDir }, doomed: { workspace } },
    },
  });
  await captureRuntimeConfigAsyncReader()();
}

export function createDeletionCron(
  state: OpenClawTestState,
  runIsolatedAgentJob: ConstructorParameters<typeof CronService>[0]["runIsolatedAgentJob"] = vi.fn(
    async () => ({ status: "ok" as const }),
  ),
) {
  const scheduler = createTestGatewayScheduler();
  const cron = new CronService({
    scheduler,
    storePath: state.statePath("cron/jobs.json"),
    cronEnabled: false,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob,
  });
  return {
    scheduler,
    cron,
    context: createDirectChatContext({ cron, getRuntimeConfig }),
    async stop(this: void) {
      cron.stop();
      await cron.waitForIdle();
      await scheduler.stop();
    },
  };
}

export async function expectDeletedStorage(
  state: OpenClawTestState,
  agentId: string,
  workspace: string,
  databasePath: string,
) {
  for (const pathname of [
    workspace,
    state.agentDir(agentId),
    state.sessionsDir(agentId),
    databasePath,
  ]) {
    await expect(fs.stat(pathname)).rejects.toMatchObject({ code: "ENOENT" });
  }
}
