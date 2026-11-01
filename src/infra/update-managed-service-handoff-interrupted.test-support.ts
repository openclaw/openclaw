import fs from "node:fs/promises";
import path from "node:path";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.js";
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
import { managedServiceStateUpdateScript } from "./update-managed-service-handoff-state.test-support.js";

export async function prepareInterruptedManagedServiceFixture(params: {
  root: string;
  statePath: string;
  recoveryModulePath: string;
  ledgerRuntimeImport: string;
  runId: string;
  updaterStopped?: "native" | "legacy";
  cut: "before" | "prepared" | "publishing" | "after" | "risk";
}) {
  const fixture = await createPackageSwapFixture(params.root);
  const installRoot = fixture.packageRoot;
  const installedRecovery = path.join(installRoot, "dist/cli/daemon-cli.js");
  const recovery = await fs.readFile(params.recoveryModulePath, "utf8");
  const runtimeUrl = JSON.stringify(
    resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.handoffPublication).href,
  );
  const executorImport = `const { withUpdateCommandExecutor } = await import(${runtimeUrl});`;
  const repair = `
    ${params.ledgerRuntimeImport}
    const fs = (await import("node:fs")).default;
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const { inspectUpdateRepairDriverAdmission } = await import(${runtimeUrl});
    const runId = process.env.OPENCLAW_UPDATE_RUN_ID;
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
    await fs.writeFile(path.join(directory, "dist/cli/daemon-cli.js"), recovery);
    await fs.writeFile(path.join(directory, "openclaw.mjs"), repair);
    await writePackageDistInventory(directory);
  }
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
      process.kill(process.pid,"SIGKILL");
    });
    `
    }
    process.kill(process.pid,"SIGKILL");
  })().catch(error=>{console.error(error);process.exit(18)});`;
  return {
    installRoot,
    updaterScript,
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
      };
    },
  };
}
