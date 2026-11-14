import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import {
  isPackageActivationComplete,
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-journal.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { triageTestRuntimeEntrypoints } from "./triage-runtime.test-support.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";
import { managedServiceStateUpdateScript } from "./update-managed-service-handoff-state.test-support.js";
import { createRetainedUpdateRecovery } from "./update-retained-recovery.test-support.js";
import { createUpdateRun } from "./update-run-ledger.js";
import { loadPluginCohortRecovery } from "./update-run-recovery-store.js";

export async function prepareInterruptedManagedServiceFixture(params: {
  root: string;
  statePath: string;
  recoveryModulePath: string;
  ledgerRuntimeImport: string;
  runId: string;
  updaterStopped?: "native" | "legacy";
  operatorRestart?: "before-recovery" | "service-inspection";
  cut: "before" | "prepared" | "publishing" | "after" | "risk";
  pluginCohort?: "own" | "foreign" | "risk";
  finalizeFailure?: true;
}) {
  const fixture = await createPackageSwapFixture(params.root);
  const installRoot = fixture.packageRoot;
  const installedRecovery = path.join(installRoot, "dist/cli/daemon-cli.js");
  const recovery = await fs.readFile(params.recoveryModulePath, "utf8");
  const writerDatabasePath = path.join(params.root, "terminal-writer.sqlite");
  const writerCheck = (column: string) => `
    const { DatabaseSync } = await import("node:sqlite");
    using db = new DatabaseSync(${JSON.stringify(writerDatabasePath)});
    db.prepare("SELECT ${column} FROM writer_schema").get();
  `;
  if (params.finalizeFailure) {
    using db = new DatabaseSync(writerDatabasePath);
    db.exec("CREATE TABLE writer_schema (previous INTEGER)");
  }
  const runtimeUrl = JSON.stringify(
    resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.handoffPublication).href,
  );
  const executorImport = `const { withUpdateCommandExecutor } = await import(${runtimeUrl});`;
  const repair = `
    ${params.ledgerRuntimeImport}
    const fs = (await import("node:fs")).default;
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const { inspectUpdateRepairDriverAdmission, settleManagedHandoffPluginCohort,
      assertUpdateRecoveryAdmission } = await import(${runtimeUrl});
    const runId = process.env.OPENCLAW_UPDATE_RUN_ID;
    // Production finalize opens with this helper-owned settlement and admission.
    await settleManagedHandoffPluginCohort();
    await assertUpdateRecoveryAdmission({ env: process.env });
    ${
      params.pluginCohort === "risk"
        ? `ledger.recordUpdateRunVerification(runId, {recovery:{serviceRestartSafe:false,
      reason:"state-migration-started", dataAtRisk:"incomplete-migration"}});
    throw new Error("Doctor failed after recording data risk");`
        : ""
    }
    if (process.argv.slice(2).join(" ") !== "update finalize --yes --json" ||
      inspectUpdateRepairDriverAdmission(ledger.listUpdateRuns({active:true}), runId).kind !== "continuation")
      throw new Error("Repair was not admitted as this helper's continuation");
    ${executorImport}
    await withUpdateCommandExecutor(runId, async executor => {
      const fence = await executor.enter(${JSON.stringify(installRoot)});
      fence.assertCurrent();
      ${managedServiceStateUpdateScript(params.statePath, "state.postCoreRepaired = true; state.repairRunId = runId;")};
      ledger.recordUpdateRunStep(runId, {step:"finalize:doctor",status:"completed"});
    });
    ${
      params.finalizeFailure
        ? `
      const { DatabaseSync } = await import("node:sqlite");
      using db = new DatabaseSync(${JSON.stringify(writerDatabasePath)});
      db.exec("ALTER TABLE writer_schema RENAME COLUMN previous TO candidate");
      throw new Error("Post-core repair failed after schema migration");
    `
        : ""
    }
    console.log(JSON.stringify({status:"ok",coreUpdate:"completed",mode:"finalize"}));
  `;
  const stageRoot = fixture.params.stage.packageRoot;
  if (!stageRoot) {
    throw new Error("Interrupted-update fixture requires a staged package root");
  }
  for (const [directory, version] of [
    [installRoot, "1.0.0"],
    [stageRoot, "2.0.0"],
  ] as const) {
    await fs.mkdir(path.join(directory, "dist/cli"), { recursive: true });
    await fs.writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "openclaw", version, type: "module" }),
    );
    await fs.writeFile(
      path.join(directory, "dist/cli/daemon-cli.js"),
      params.finalizeFailure && version === "2.0.0"
        ? recovery.replace(
            "export const { finishUpdateRun } = ledger;",
            `
          export async function finishUpdateRun(...args) {
            ${writerCheck("candidate")}
            return await ledger.finishUpdateRun(...args);
          }`,
          )
        : recovery,
    );
    await fs.writeFile(path.join(directory, "openclaw.mjs"), repair);
    await writePackageDistInventory(directory);
  }
  const stateEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: params.root,
    OPENCLAW_CONFIG_PATH: path.join(params.root, "openclaw.json"),
  };
  const cohortRunId =
    params.pluginCohort === "foreign"
      ? createUpdateRun({ trigger: "cli" }, { env: stateEnv }).runId
      : params.runId;
  if (params.pluginCohort) {
    reservePluginCohort(stateEnv, cohortRunId, installRoot);
  }
  const operatorRestart = `${params.operatorRestart ? `${managedServiceStateUpdateScript(params.statePath, "state.interruptedRunId = runId;")};` : ""}
    ${params.operatorRestart === "before-recovery" ? 'ledger.recordUpdateRunStep(runId, {step:"service-start", status:"completed", endedAtMs:Date.now()});' : ""}`;
  const updaterScript = `void (async () => {
    ${params.ledgerRuntimeImport}
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(path.join(params.root, "updater-ran"))}, "ran");
    const runId = ${JSON.stringify(params.runId)};
    ${
      params.updaterStopped
        ? `
    ledger.recordUpdateRunVerification(runId, {serviceRunning:true, runningVersion:"1.0.0"});
    ${params.updaterStopped === "native" ? 'ledger.recordUpdateRunStep(runId, {step:"managed-service update handoff", status:"completed", endedAtMs:Date.now()});' : ""}
    ledger.recordUpdateRunPhase(runId, "activating", {target:{installationMethod:${JSON.stringify(params.updaterStopped === "native" ? "npm-global" : "managed-service")}}});
    await new Promise((resolve, reject) => {
      const stop = require("node:child_process").spawn("systemctl", ["--user", "stop", "openclaw-gateway.service"], {stdio:"inherit"});
      stop.once("error", reject).once("exit", code => code === 0 ? resolve() : reject(new Error("updater stop failed")));
    });
    `
        : ""
    }
    ${
      params.cut === "risk"
        ? `ledger.recordUpdateRunVerification(runId, {recovery:{serviceRestartSafe:false, reason:"state-migration-started", dataAtRisk:"unreadable-state"}});
    fs.writeFileSync(${JSON.stringify(installedRecovery)}, 'throw new Error("unverified installed runtime executed");');`
        : ""
    }
    ${
      params.cut === "before" || params.cut === "risk"
        ? ""
        : `
    ${executorImport}
    const { preparePackageActivationJournal, createPackageIntegrityReader, encodePackageActivationLauncher,
      packageActivationRuntimeForTest, createPublicationOwner } = await import(${runtimeUrl});
    await withUpdateCommandExecutor(runId, async executor => {
      const fence = await executor.enter(${JSON.stringify(installRoot)});
      ledger.recordUpdateRunPhase(runId, "activating", {before:{version:"1.0.0"},after:{version:"2.0.0"}});
      const prepared = await preparePackageActivationJournal({
        options:{fence,runtime:packageActivationRuntimeForTest(),onPrepared:()=>{}},
        liveRoot:${JSON.stringify(installRoot)},stageRoot:${JSON.stringify(fixture.params.stage.packageRoot)},
        launcherRoot:${JSON.stringify(fixture.params.stage.layout.binDir)},binDir:${JSON.stringify(path.dirname(fixture.launcher))},
        previous:await createPackageIntegrityReader().tree(${JSON.stringify(installRoot)}),
        launchers:[{name:"openclaw",previous:encodePackageActivationLauncher(await createPackageIntegrityReader().launcher(${JSON.stringify(fixture.launcher)}))}],
      });
      ${
        params.cut === "prepared"
          ? ""
          : params.cut === "after"
            ? "await createPublicationOwner(prepared.anchor, prepared.journal, fence.assertCurrent).publish();"
            : `
      const record = prepared.journal.read();
      prepared.journal.transition(record,"publishing",{kind:"displace"},fence.assertCurrent);
      fs.renameSync(${JSON.stringify(installRoot)}, prepared.anchor + "/previous");
      `
      }
      ${operatorRestart}
      process.kill(process.pid,"SIGKILL");
    });
    `
    }
    ${operatorRestart}
    process.kill(process.pid,"SIGKILL");
  })().catch(error=>{console.error(error);process.exit(18)});`;
  return {
    installRoot,
    updaterScript,
    async prepareStagedRuntime(directory: string) {
      if (!params.finalizeFailure) {
        return;
      }
      // The sealed old writer and installed candidate enforce different schema contracts.
      const runtime = path.join(directory, "runtime/managed-handoff-runtime.mjs");
      const previous = "managed-handoff-runtime-previous.mjs";
      await fs.rename(runtime, path.join(path.dirname(runtime), previous));
      await fs.writeFile(
        runtime,
        `
        export * from "./${previous}";
        import { finishUpdateRun as finish } from "./${previous}";
        export async function finishUpdateRun(...args) {
          ${writerCheck("previous")}
          return await finish(...args);
        }
      `,
      );
    },
    helperParams: {
      recoveryModulePath: installedRecovery,
      finalizeCommandArgv: [
        resolveTestNodeExecPath(),
        path.join(installRoot, "openclaw.mjs"),
        "update",
        "finalize",
        "--yes",
        "--json",
      ],
    },
    async inspect() {
      const anchor = resolvePackageActivationAnchor(installRoot);
      const recorded = await fs.access(resolvePackageActivationJournalPath(anchor)).then(
        () => true,
        () => false,
      );
      return {
        installedVersion: JSON.parse(
          await fs.readFile(path.join(installRoot, "package.json"), "utf8"),
        ).version as string,
        launcher: await fs.readFile(fixture.launcher, "utf8"),
        publicationPending:
          recorded &&
          !isPackageActivationComplete(anchor, openPackageActivationJournal(anchor).read()),
        ...(params.pluginCohort
          ? {
              cohort:
                loadPluginCohortRecovery(cohortRunId, { env: stateEnv })?.cohort.disposition ??
                "settled",
            }
          : {}),
      };
    },
  };
}

/** Reserved before publication, as the killed updater's package transaction does. */
function reservePluginCohort(env: NodeJS.ProcessEnv, runId: string, installRoot: string) {
  const installKey = resolveUpdateInstallRoot(installRoot);
  const runtime = (version: string) => ({
    root: installKey,
    nodePath: process.execPath,
    version,
    buildId: null,
  });
  const reservation = createRetainedUpdateRecovery(
    { runId, from: runtime("1.0.0"), to: runtime("2.0.0") },
    { env },
  );
  writeConfigMachineState(
    "update.pluginCohort." + runId,
    {
      runId,
      transactionId: reservation.transactionId,
      revision: 0,
      disposition: "pending",
      installKey,
      priorArtifacts: [],
      artifacts: [],
      publications: [],
      settledPublications: 0,
    },
    { env },
  );
}
