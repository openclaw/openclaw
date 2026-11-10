import type { ManagedServiceBoundaryOptions } from "./update-managed-service-handoff-boundary-contract.test-support.js";
import { managedServiceStateUpdateScript } from "./update-managed-service-handoff-state.test-support.js";

/** Retire authority after native inspection, before the real helper can consume its result. */
export function createRecoveryInterruptionPreload(
  params: {
    scriptPath: string;
    paramsPath: string;
    updaterPath: string;
    statePath: string;
    ledgerRuntimeImport: string;
  } & NonNullable<ManagedServiceBoundaryOptions["recoveryInterruption"]>,
) {
  return `if (process.argv[1] === ${JSON.stringify(params.scriptPath)}) {
    const fs = require("node:fs");
    const children = require("node:child_process");
    const spawn = children.spawn;
    let interrupted = false;
    let inspections = 0;
    children.spawn = (command, args, options) => {
      const child = spawn(command, args, options);
      const inspection = (command === "systemctl" && args.includes("show")) ||
        (command === "launchctl" && args[0] === "print");
      if (!inspection || interrupted || !fs.existsSync(${JSON.stringify(params.updaterPath)})) return child;
      inspections += 1;
      if (inspections !== ${params.at === "inspection" ? 1 : params.at === "bootstrap-retry" ? 3 : 2}) return child;
      interrupted = true;
      const emit = child.emit.bind(child);
      child.emit = (event, ...values) => {
        if (event !== "close") return emit(event, ...values);
        void (async () => {
          const params = JSON.parse(fs.readFileSync(${JSON.stringify(params.paramsPath)}, "utf8"));
          ${
            params.effect === "stop-retired"
              ? `${params.ledgerRuntimeImport}
          ledger.recordUpdateRunStep(params.runId, {step:"service-start", status:"completed", endedAtMs:Date.now()});
          ledger.recordUpdateRunVerification(params.runId, {serviceRunning:false});`
              : `const db = new (require("node:sqlite").DatabaseSync)(params.updateLeaseDatabasePath);
          db.prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?").run("replacement-owner", params.updateLeaseKey);
          db.close();`
          }
          ${managedServiceStateUpdateScript(params.statePath, "state.recoveryInterrupted = true;")};
          emit(event, ...values);
        })().catch(error => { console.error(error); process.exitCode = 19; emit(event, ...values); });
        return true;
      };
      return child;
    };
  }`;
}
