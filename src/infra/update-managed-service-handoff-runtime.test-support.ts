import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { triageTestRuntimeEntrypoints } from "./triage-runtime.test-support.js";
import type {
  ManagedRepairBoundary,
  ManagedServiceBoundaryOptions,
} from "./update-managed-service-handoff-boundary-contract.test-support.js";
import {
  managedRepairConfig,
  prepareManagedRepairSpawnEnv,
} from "./update-managed-service-handoff-repair.test-support.js";
import { managedServiceStateUpdateScript } from "./update-managed-service-handoff-state.test-support.js";

export async function prepareManagedServiceRuntimeFixture(params: {
  recoveryModulePath: string;
  statePath: string;
  configPath: string;
  activationGatePath: string;
  activationReleasePath: string;
  ledger: boolean;
  options?: {
    replaceLedgerWriter?: boolean;
    requester?: { channel?: string; accountId?: string; senderId?: string };
    cancelAtActivation?: "requester" | "inspection";
    repair?: ManagedRepairBoundary;
  };
}) {
  const {
    recoveryModulePath,
    statePath,
    configPath,
    activationGatePath,
    activationReleasePath,
    ledger,
    options,
  } = params;
  // Source children run from the helper's durable cwd, outside this checkout.
  const sourceRuntimeImport = `
    const { register } = await import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)});
    register({ tsconfig: ${JSON.stringify(path.resolve("tsconfig.json"))} });
  `;
  const ledgerRuntimeImport = `
    const ledger = await import(${JSON.stringify(resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.updateRunLedger).href)});
  `;
  if (ledger) {
    await fs.appendFile(
      recoveryModulePath,
      `
      ${ledgerRuntimeImport}
      export const { adoptUpdateRun, getUpdateRun, recordUpdateRunStep, recordUpdateRunVerification } = ledger;
      ${options?.replaceLedgerWriter ? 'export function finishUpdateRun() { throw new Error("the previous runtime must not finalize the candidate"); }' : "export const { finishUpdateRun } = ledger;"}
    `,
    );
  }
  if (options?.requester) {
    await fs.writeFile(statePath, "{}");
    await fs.writeFile(
      configPath,
      JSON.stringify(
        options.repair
          ? managedRepairConfig(options.repair.baseUrl)
          : {
              commands: { ownerAllowFrom: ["slack:owner"] },
              channels: { slack: { enabled: true } },
            },
      ),
    );
    await fs.appendFile(
      recoveryModulePath,
      `
      export async function isManagedUpdateRequesterOwner(requester) {
        const state = ${managedServiceStateUpdateScript(
          statePath,
          `state.ownerChecked = true;
          ${options.cancelAtActivation === "requester" ? "state.ownerChecks = (state.ownerChecks || 0) + 1;" : ""}`,
        )};
        ${
          options.cancelAtActivation === "requester"
            ? `if (state.ownerChecks === 2) {
          fs.writeFileSync(${JSON.stringify(activationGatePath)}, "requester");
          while (!fs.existsSync(${JSON.stringify(activationReleasePath)})) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        return true;`
            : `const runtime = await import(${JSON.stringify(new URL("../../dist/cli/daemon-cli.js", import.meta.url).href)});
        return runtime.isManagedUpdateRequesterOwner(requester);`
        }
      }
    `,
    );
  }
  return { sourceRuntimeImport, ledgerRuntimeImport };
}

export async function prepareManagedServiceSpawn(
  root: string,
  scriptPath: string,
  childEnv: NodeJS.ProcessEnv,
  options?: Pick<
    ManagedServiceBoundaryOptions,
    "repair" | "beforeParkNotice" | "finalizationWorkMs"
  >,
) {
  let env = options?.repair ? await prepareManagedRepairSpawnEnv(root, childEnv) : childEnv;
  if (options?.finalizationWorkMs !== undefined) {
    const preloadPath = path.join(root, "finalization-clock-preload.cjs");
    const statePath = path.join(root, "manager-state.json");
    const modulePath = path.join(root, "recovery-health.mjs");
    // Model cold finalizer startup only in the helper; its native child and lease stay real.
    await fs.writeFile(
      preloadPath,
      `if (process.argv[1] === ${JSON.stringify(scriptPath)}) {
      const fs = require("node:fs");
      const children = require("node:child_process");
      const spawn = children.spawn;
      const setTimeout = global.setTimeout;
      let finalizer;
      children.spawn = (command, args, options) => {
        const child = spawn(command, args, options);
        try {
          let payload = JSON.parse(args.at(-1));
          if (Array.isArray(payload) && payload[0] !== ${JSON.stringify(modulePath)})
            payload = JSON.parse(payload.at(-1));
          if (Array.isArray(payload) && payload[0] === ${JSON.stringify(modulePath)}) {
            finalizer = child;
            child.once("close", () => { if (finalizer === child) finalizer = undefined; });
          }
        } catch {}
        return child;
      };
      global.setTimeout = (callback, delay, ...args) => {
        if (finalizer && typeof delay === "number" && delay >= 1000) {
          finalizer = undefined;
          const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));
          state.finalizationBudgetMs = delay;
          fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
          return setTimeout(callback, delay < ${options.finalizationWorkMs} ? 0 : delay, ...args);
        }
        return setTimeout(callback, delay, ...args);
      };
    }`,
    );
    env = { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require ${preloadPath}`.trim() };
  }
  const deadlinePath = path.join(root, "notice-deadline.json");
  const releasePath = path.join(root, "notice-deadline-release");
  if (options?.beforeParkNotice === "stalled") {
    const preloadPath = path.join(root, "notice-clock-preload.cjs");
    // Keep other processes and deadlines native; release only after the parent observes the notice.
    const source = `if (process.argv[1] === ${JSON.stringify(scriptPath)}) {
      const fs = require("node:fs");
      const setTimeout = global.setTimeout;
      const clearTimeout = global.clearTimeout;
      const polls = new Map();
      let captured = false;
      global.clearTimeout = (timer) => {
        clearInterval(polls.get(timer));
        polls.delete(timer);
        return clearTimeout(timer);
      };
      global.setTimeout = (callback, delay, ...args) => {
        const timer = setTimeout(callback, delay, ...args);
        if (delay !== 10_000) return timer;
        if (captured) throw new Error("duplicate pre-park notice deadline");
        captured = true;
        fs.writeFileSync(${JSON.stringify(deadlinePath)}, JSON.stringify({ requestedMs: delay }));
        const poll = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(releasePath)})) return;
          global.clearTimeout(timer);
          callback.apply(timer, args);
        }, 5);
        polls.set(timer, poll);
        return timer;
      };
    }`;
    await fs.writeFile(preloadPath, source);
    env = { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require ${preloadPath}`.trim() };
  }
  return {
    env,
    releaseNoticeDeadline: async (parentSignal: NodeJS.Signals | null) => {
      expect(parentSignal).toBeNull();
      await expect(
        fs.readFile(deadlinePath, "utf8").then((value) => JSON.parse(value)),
        "expected one captured 10,000ms pre-park deadline",
      ).resolves.toEqual({ requestedMs: 10_000 });
      await fs.writeFile(releasePath, "release");
    },
  };
}

export async function prepareManagedServiceBoundaryFiles({
  root,
  statePath,
  options,
}: {
  root: string;
  statePath: string;
  options?: ManagedServiceBoundaryOptions;
}) {
  const recoveryModulePath = path.join(root, "recovery-health.mjs");
  const stateDatabasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: root });
  const consumeNotification = `const db = new (require("node:sqlite").DatabaseSync)(${JSON.stringify(stateDatabasePath)}); const cleared = db.prepare("DELETE FROM gateway_restart_sentinel WHERE sentinel_key = 'current'").run(); db.close(); if (cleared.changes !== 1) throw new Error("expected one published notification before recovery consumed it"); ${managedServiceStateUpdateScript(statePath, "state.consumedNotifications = Number(cleared.changes)")};`;
  if (options?.updaterNotification) {
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  }
  await fs.writeFile(
    recoveryModulePath,
    `
    import fs from "node:fs";
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    export async function waitForGatewayUpdateRecovery(expectedVersion, expectedBuildId) {
      ${managedServiceStateUpdateScript(
        statePath,
        `
      state.healthProbed = true;
      state.healthProbeCount = (state.healthProbeCount || 0) + 1;
      state.expectedVersion = expectedVersion;
      state.expectedBuildId = expectedBuildId;
      `,
      )};
      ${options?.updaterNotification === "consumed" ? consumeNotification : ""}
      ${options?.diagnosticReadFailure === "after-recovery" ? `{ const db = new (require("node:sqlite").DatabaseSync)(${JSON.stringify(stateDatabasePath)}); db.exec("ALTER TABLE gateway_restart_sentinel RENAME COLUMN thread_id TO unreadable_thread_id"); db.close(); }` : ""}
      const fault = ${JSON.stringify(options?.gatewayHealth)};
      if (fault === "throw") throw new Error("readiness probe unavailable");
      return { healthy: !["unready", "wrong-version", "wrong-build", "exited"].includes(fault),
        runtime: { status: fault === "exited" ? "stopped" : "running", pid: fault === "exited" ? null : ${process.pid} },
        gatewayVersion: fault === "wrong-version" ? "0.0.1" : expectedVersion,
        gatewayBuildId: fault === "wrong-build" ? "another-build-same-version" : expectedBuildId };
    }
  `,
  );
  const invocationCwd = options?.relativeInput ? path.join(root, "invoking-directory") : undefined;
  if (invocationCwd) {
    await fs.mkdir(invocationCwd);
    await fs.writeFile(path.join(invocationCwd, "update-input.txt"), "selected target");
  }
  return { recoveryModulePath, stateDatabasePath, consumeNotification, invocationCwd };
}
