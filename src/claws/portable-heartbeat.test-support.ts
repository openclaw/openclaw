import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import {
  GatewayProtocolRequestError,
  retainGatewayResponsePayload,
} from "../../packages/gateway-client/src/protocol-request.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { cronJobReadView } from "../cron/job-read-view.js";
import { readDefaultProactiveJobReceiptInDatabase } from "../cron/proactive-job-receipt.kernel.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import { loadCronRows, loadedCronStoreFromRows } from "../cron/store/row-codec.js";
import { clawsAutomationHandlers } from "../gateway/server-methods/claws-automations.js";
import type { RespondFn } from "../gateway/server-methods/types.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { applyClawAddPlan } from "./add.js";
import { clawAutomationMutationResultSchema } from "./automation-mutation-contract.js";
import type { ClawCronGateway } from "./cron.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { resolveClawMonitorCleanupBinding } from "./monitor-cleanup-binding.js";
import { readPortableHeartbeatState } from "./portable-heartbeat-state.js";
import { parseClawManifest } from "./schema.js";
import type { ClawOpenClawProfile, ClawSourceIdentity } from "./types.js";

export function setupPortableHeartbeatFixture() {
  const temps = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(async () => {
      await closeStateDatabaseForTest();
      cleanup();
      resetConfigRuntimeState();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
  });

  async function fixture(
    heartbeat: ClawOpenClawProfile["agent"]["heartbeat"],
    scratch?: string,
    beforeApply?: (plan: Awaited<ReturnType<typeof buildClawAddPlan>>) => Promise<void>,
    throughGateway = false,
  ) {
    const root = temps.make("claw-portable-heartbeat-");
    const sourceRoot = join(root, "source");
    await mkdir(sourceRoot);
    if (scratch !== undefined) {
      await writeFile(join(sourceRoot, "HEARTBEAT.md"), scratch);
    }
    const parsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "worker" },
      workspace: {
        bootstrapFiles: scratch === undefined ? {} : { "HEARTBEAT.md": { source: "HEARTBEAT.md" } },
      },
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }
    const source: ClawSourceIdentity = {
      kind: "package",
      name: "@acme/portable",
      version: "1.0.0",
      packageRoot: sourceRoot,
      manifestPath: join(sourceRoot, "CLAW.md"),
      integrityKind: "artifact",
      integrity: `sha256:${"a".repeat(64)}`,
      byteLength: 100,
    };
    const profile: ClawOpenClawProfile = {
      schemaVersion: 1,
      agent: heartbeat === undefined ? {} : { heartbeat },
    };
    const plan = await buildClawAddPlan({
      manifest: parsed.manifest,
      source,
      openClawProfile: profile,
      context: { workspace: join(root, "workspace") },
    });
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    let config: OpenClawConfig = {};
    const cronGateway = throughGateway ? gatewayForFixture(env, () => config) : undefined;
    await beforeApply?.(plan);
    const install = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      ...(cronGateway ? { cronGateway } : {}),
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });
    const storePath = resolveCronJobsStorePathFromConfig(config, env);
    const db = openOpenClawStateDatabase({ env }).db;
    const receipt = () => readDefaultProactiveJobReceiptInDatabase(db, storePath, "worker");
    const jobs = () =>
      loadedCronStoreFromRows(loadCronRows(db, cronStoreKey(storePath))).store.jobs;
    return {
      root,
      source,
      manifest: parsed.manifest,
      profile,
      plan,
      env,
      config,
      install,
      storePath,
      db,
      receipt,
      jobs,
      cronGateway,
    };
  }

  return fixture;
}

export function gatewayForFixture(
  env: { OPENCLAW_STATE_DIR: string },
  getConfig: () => OpenClawConfig,
  cron: Parameters<
    (typeof clawsAutomationHandlers)["claws.automations.mutate"]
  >[0]["context"]["cron"] = {
    remove: async () => {
      throw new Error("Unexpected portable removal");
    },
  },
  guard?: () => void,
): ClawCronGateway {
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", join(env.OPENCLAW_STATE_DIR, "openclaw.json"));
  const storePath = () => resolveCronJobsStorePathFromConfig(getConfig(), env);
  return {
    add: async () => {
      throw new Error("Unexpected ordinary cron.add");
    },
    remove: async () => {
      throw new Error("Unexpected ordinary cron.remove");
    },
    get: async (id) => {
      const state = await readPortableHeartbeatState("worker", getConfig(), { env });
      return state.job?.id === id ? cronJobReadView(state.job) : undefined;
    },
    list: async () => {
      const state = await readPortableHeartbeatState("worker", getConfig(), { env });
      return { jobs: state.job ? [cronJobReadView(state.job)] : [] };
    },
    mutateAutomation: async (request, options) => {
      let response: { ok: boolean; payload: unknown; error: Parameters<RespondFn>[2] } | undefined;
      await clawsAutomationHandlers["claws.automations.mutate"]({
        context: {
          cron,
          cronStorePath: storePath(),
          getRuntimeConfig: getConfig,
          isConfigReloadSettled: () => true,
        },
        params: { ...request, binding: resolveClawMonitorCleanupBinding(storePath()) },
        signal: options?.signal,
        hasCurrentClientAuthority: () => true,
        sessionMutationCommitGuard: guard,
        respond: (ok, payload, error) => {
          response = { ok, payload, error };
        },
      });
      if (!response) {
        throw new Error("Automation mutation did not respond");
      }
      if (!response.ok) {
        if (!response.error) {
          throw new Error("Automation mutation returned a refusal without an error");
        }
        const error = new GatewayProtocolRequestError(response.error);
        retainGatewayResponsePayload(error, response.payload);
        throw error;
      }
      return clawAutomationMutationResultSchema.parse(response.payload);
    },
  };
}
