import path from "node:path";
import {
  formatPluginRuntimeCompatibilityWarning,
  inspectPluginRuntimeCompatibility,
} from "../plugins/plugin-runtime-compatibility.js";
import { defaultRuntime } from "../runtime.js";

export type PluginsRuntimeLintOptions = {
  root?: string;
  json?: boolean;
};

/** Static author diagnostics do not import or activate the inspected plugin. */
export async function runPluginsRuntimeLintCommand(opts: PluginsRuntimeLintOptions): Promise<void> {
  const report = await inspectPluginRuntimeCompatibility({
    packageDir: path.resolve(opts.root ?? process.cwd()),
  });
  if (opts.json) {
    defaultRuntime.writeJson(report);
    return;
  }
  for (const warning of report.warnings) {
    defaultRuntime.log(
      `Runtime compatibility warning: ${formatPluginRuntimeCompatibilityWarning(warning)}`,
    );
  }
  defaultRuntime.log(
    `Inspected ${report.scannedFiles} source files in ${report.scannedPackages} materialized packages. ${report.warnings.length} runtime compatibility warnings.${report.complete ? "" : " Inspection was incomplete."}`,
  );
  defaultRuntime.log(
    "Warnings do not block installation or certify compatibility. Test activation against each supported host runtime.",
  );
}
