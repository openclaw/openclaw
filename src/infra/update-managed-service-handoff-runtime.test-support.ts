import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { triageTestRuntimeEntrypoints } from "./triage-runtime.test-support.js";
import type { ManagedServiceBoundaryOptions } from "./update-managed-service-handoff-boundary-contract.test-support.js";
import { prepareManagedServiceRecoveryClockPreload } from "./update-managed-service-handoff-command.test-support.js";
import {
  prepareManagedServiceTriageClockPreload,
  type ManagedServiceManagerBoundaryResult,
} from "./update-managed-service-handoff-lifecycle.test-support.js";
import { managedServiceStateUpdateScript } from "./update-managed-service-handoff-state.test-support.js";

export async function prepareManagedServiceRuntimeFixture({
  recoveryModulePath,
  statePath,
  configPath,
  validationReleasePath,
  activationGatePath,
  activationReleasePath,
  ledger,
  options,
}: {
  recoveryModulePath: string;
  statePath: string;
  configPath: string;
  validationReleasePath: string;
  activationGatePath: string;
  activationReleasePath: string;
  ledger: boolean;
  options?: Pick<
    ManagedServiceBoundaryOptions,
    "replaceLedgerWriter" | "requester" | "cancelAtActivation"
  >;
}) {
  const appendRuntime = (source: string) => fs.appendFile(recoveryModulePath, source);
  // Source children run from the helper's durable cwd, outside this checkout.
  const sourceRuntimeImport = `
    const { register } = await import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)});
    register({ tsconfig: ${JSON.stringify(path.resolve("tsconfig.json"))} });
  `;
  const ledgerRuntimeImport = `
    const ledger = await import(${JSON.stringify(resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.updateRunLedger).href)});
  `;
  if (ledger) {
    await appendRuntime(`
      ${ledgerRuntimeImport}
      export const { adoptUpdateRun, getUpdateRun, recordUpdateRunStep, recordUpdateRunVerification } = ledger;
      ${options?.replaceLedgerWriter ? 'export function finishUpdateRun() { throw new Error("the previous runtime must not finalize the candidate"); }' : "export const { finishUpdateRun } = ledger;"}
    `);
  }
  if (options?.requester) {
    await fs.writeFile(statePath, "{}");
    if (options.requester.authorizationSource?.startsWith("profile:")) {
      await appendRuntime(`
        const requesterRuntime = await import(${JSON.stringify(resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.requester).href)});
        export const { prepareManagedUpdateRequesterIdentity } = requesterRuntime;
      `);
      return { sourceRuntimeImport, ledgerRuntimeImport };
    }
    await fs.writeFile(
      configPath,
      JSON.stringify({
        commands: { ownerAllowFrom: ["slack:owner"] },
        channels: { slack: { enabled: true } },
      }),
    );
    await appendRuntime(`
      export async function isManagedUpdateRequesterOwner(requester) {
        const state = ${managedServiceStateUpdateScript(statePath, "state.ownerChecked = true;")};
        ${
          options.cancelAtActivation === "requester"
            ? `if (fs.existsSync(${JSON.stringify(validationReleasePath)})) {
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
    `);
  }
  return { sourceRuntimeImport, ledgerRuntimeImport };
}

export async function prepareManagedServiceSpawn(
  root: string,
  scriptPath: string,
  childEnv: NodeJS.ProcessEnv,
  options:
    | Pick<
        ManagedServiceBoundaryOptions,
        "beforeParkNotice" | "finalizationWorkMs" | "recoveryHang" | "triageHang"
      >
    | undefined,
  commandClocks: {
    recoveryCommandArgv: string[];
    recoveryTimeoutMs: number;
    triageCommandArgv: string[];
    triageInputPath: string;
  },
) {
  let env = childEnv;
  const statePath = path.join(root, "manager-state.json");
  const installPreload = async (name: string, source: string) => {
    const preloadPath = path.join(root, `${name}-clock-preload.cjs`);
    await fs.writeFile(
      preloadPath,
      `if (process.argv[1] === ${JSON.stringify(scriptPath)}) {
      const fs = require("node:fs");
      const setTimeout = global.setTimeout;
${source}
    }`,
    );
    env = { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require ${preloadPath}`.trim() };
  };
  if (options?.finalizationWorkMs !== undefined) {
    // Terminal input lives with the staged helper, not the emulated install root.
    const terminalPath = path.join(path.dirname(scriptPath), "terminal-result.json");
    // Model cold finalizer startup only in the helper; its native child and lease stay real.
    await installPreload(
      "finalization",
      `
      const children = require("node:child_process");
      const spawn = children.spawn;
      let finalizer;
      children.spawn = (command, args, options) => {
        const child = spawn(command, args, options);
        try {
          const input = args.at(-1);
          if (input === ${JSON.stringify(terminalPath)} || (input.startsWith("[") && JSON.parse(input).at(-1) === ${JSON.stringify(terminalPath)})) {
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
    `,
    );
  }
  const deadlinePath = path.join(root, "notice-deadline.json");
  const releasePath = path.join(root, "notice-deadline-release");
  if (options?.beforeParkNotice === "stalled") {
    // Keep other processes and deadlines native; release only after the parent observes the notice.
    await installPreload(
      "notice",
      `
      const clearTimeout = global.clearTimeout;
      let captured, poll;
      global.clearTimeout = (timer) => {
        if (timer === captured) clearInterval(poll);
        return clearTimeout(timer);
      };
      global.setTimeout = (callback, delay, ...args) => {
        const timer = setTimeout(callback, delay, ...args);
        if (delay !== 10_000) return timer;
        if (captured) throw new Error("duplicate pre-park notice deadline");
        captured = timer;
        fs.writeFileSync(${JSON.stringify(deadlinePath)}, JSON.stringify({ requestedMs: delay }));
        poll = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(releasePath)})) return;
          global.clearTimeout(timer);
          callback.apply(timer, args);
        }, 5);
        return timer;
      };
    `,
    );
  }
  if (options?.recoveryHang) {
    env = await prepareManagedServiceRecoveryClockPreload(
      {
        root,
        scriptPath,
        statePath,
        timeoutMs: commandClocks.recoveryTimeoutMs,
      },
      commandClocks.recoveryCommandArgv,
      env,
    );
  }
  if (options?.triageHang) {
    env = await prepareManagedServiceTriageClockPreload(
      { root, scriptPath, statePath },
      commandClocks.triageCommandArgv,
      commandClocks.triageInputPath,
      env,
    );
  }
  const readDeadline = async (name: string) =>
    JSON.parse(await fs.readFile(path.join(root, `${name}-deadline.json`), "utf8"));
  return {
    env,
    async readCommandDeadlines(): Promise<
      Pick<ManagedServiceManagerBoundaryResult, "recoveryDeadline" | "triageDeadline">
    > {
      return {
        ...(options?.recoveryHang ? { recoveryDeadline: await readDeadline("recovery") } : {}),
        ...(options?.triageHang ? { triageDeadline: await readDeadline("triage") } : {}),
      };
    },
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
