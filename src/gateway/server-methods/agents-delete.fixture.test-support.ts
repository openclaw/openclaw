import fs from "node:fs/promises";
import { expect, vi } from "vitest";
import { getRuntimeConfig } from "../../config/config.js";
import { CronService } from "../../cron/service.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";

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
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob,
  });
  return { scheduler, cron, context: createDirectChatContext({ cron, getRuntimeConfig }) };
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
