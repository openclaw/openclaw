import path from "node:path";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { createDefaultProactiveJob } from "../cron/default-proactive-job.js";
import { saveCronJobsStore } from "../cron/store.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { loadGatewayTestConfig } from "./test-helpers.config-runtime.js";
import { testState } from "./test-helpers.runtime-state.js";

/** Deferred Hook notices need a real future session turn; startup no longer creates one. */
export async function prepareScheduledHookReceiversForTest(
  targets: Array<{ agentId: string; sessionKey: string }> = [],
): Promise<() => void> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Scheduled Hook fixture requires its isolated config path");
  }
  const cfg = loadGatewayTestConfig();
  const nowMs = Date.now();
  const jobs = listAgentIds(cfg).map((agentId) =>
    createDefaultProactiveJob(cfg, agentId, nowMs, 86_400_000),
  );
  for (const { agentId, sessionKey } of targets) {
    jobs.push({
      ...createDefaultProactiveJob(cfg, agentId, nowMs, 86_400_000),
      sessionKey,
      sessionTarget: `session:${sessionKey}`,
    });
  }
  const storePath = path.join(path.dirname(configPath), "cron", "hook-receivers.json");
  await saveCronJobsStore(storePath, { version: 1, jobs });
  const previous = { enabled: testState.cronEnabled, storePath: testState.cronStorePath };
  const env = captureEnv(["OPENCLAW_SKIP_CRON"]);
  testState.cronEnabled = true;
  testState.cronStorePath = storePath;
  setTestEnvValue("OPENCLAW_SKIP_CRON", "0");
  return () => {
    testState.cronEnabled = previous.enabled;
    testState.cronStorePath = previous.storePath;
    env.restore();
  };
}
