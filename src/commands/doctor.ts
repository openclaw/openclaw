import { resolveInstalledPluginIndexStorePath } from "../plugins/installed-plugin-index-store-path.js";
import type { RuntimeEnv } from "../runtime.js";
import { runPostUpgradeProbes } from "./doctor-post-upgrade.js";
import type { DoctorOptions } from "./doctor-prompter.js";

export async function doctorCommand(runtime?: RuntimeEnv, options?: DoctorOptions): Promise<void> {
  if (options?.postUpgrade) {
    const installsPath = resolveInstalledPluginIndexStorePath();
    const report = await runPostUpgradeProbes({ installsPath });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const f of report.findings) {
        console.log(`[${f.level}] ${f.code}: ${f.message}`);
      }
      if (report.findings.length === 0) {
        console.log("post-upgrade: no findings");
      }
    }
    const hasError = report.findings.some((f) => f.level === "error");
    runtime?.exit(hasError ? 1 : 0);
    return;
  }
  const doctorHealth = await import("../flows/doctor-health.js");
  await doctorHealth.doctorCommand(runtime, options);
}
