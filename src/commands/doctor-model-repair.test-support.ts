import "./doctor-retired-models.test-support.js";
import path from "node:path";
import { vi } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobsStorePath, saveCronJobsStore } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { repairCronCodexModelRefsAfterConfigWrite } from "./doctor/cron/legacy-repair.js";
import { maybeRepairCodexSessionRoutes } from "./doctor/shared/codex-route-session-repair.js";
import { repairStaleAgentModelRefs } from "./doctor/shared/stale-agent-model-ref-repair.js";

export const retiredModel = "openai/retired-with-successor";
export const currentModel = "openai/current-model";
export const noSuccessor = "openai/retired-without-successor";

export function cronJob(
  id: string,
  model: string,
  fallbacks?: string[],
  overrides: Partial<CronJob> = {},
): CronJob {
  return {
    id,
    agentId: "main",
    name: "Synthetic reminder",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: "Synthetic reminder",
      model,
      ...(fallbacks ? { fallbacks } : {}),
    },
    state: {},
    ...overrides,
  };
}

export async function seedCronModel(id: string, model: string) {
  const storePath = resolveCronJobsStorePath();
  const job = cronJob(id, model, undefined, {
    schedule: { kind: "every", everyMs: 60000, anchorMs: 1 },
  });
  await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
  return storePath;
}

export function repairConfig(cfg: OpenClawConfig, env: NodeJS.ProcessEnv, providers = ["openai"]) {
  if (cfg.models?.mode !== "replace") {
    vi.spyOn(pluginMetadata, "resolvePluginMetadataSnapshot").mockReturnValueOnce(
      createPluginMetadataSnapshotFixture({ plugins: [{ id: "fixture", providers }] }),
    );
  }
  return repairStaleAgentModelRefs(cfg, { env });
}

function sessionAddress(state: OpenClawTestState, sessionKey: string) {
  return { storePath: path.join(state.sessionsDir(), "sessions.json"), sessionKey, env: state.env };
}
export function readSession(state: OpenClawTestState, sessionKey: string) {
  return loadSessionEntry(sessionAddress(state, sessionKey));
}
export function writeSession(
  state: OpenClawTestState,
  sessionKey: string,
  entry: Omit<SessionEntry, "sessionId" | "updatedAt"> &
    Partial<Pick<SessionEntry, "sessionId" | "updatedAt">>,
) {
  return replaceSessionEntry(sessionAddress(state, sessionKey), {
    sessionId: sessionKey.slice("agent:main:".length),
    updatedAt: 1,
    ...entry,
  });
}

export async function repairPersistedRoutes(cfg: OpenClawConfig, state: OpenClawTestState) {
  await state.writeConfig(cfg);
  const sessions = await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: true });
  const cron = await repairCronCodexModelRefsAfterConfigWrite({
    migrateCodexModelRefs: true,
    cfg,
    repairRetiredModelRefs: true,
  });
  return { sessions, cron };
}
