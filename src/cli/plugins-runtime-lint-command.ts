import path from "node:path";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { collectInstalledRuntimePackageGraph } from "../plugins/installed-package-runtime-graph.js";
import {
  formatPluginRuntimeCompatibilityWarning,
  scanPluginRuntimeCompatibility,
  type PluginRuntimeCompatibilityReport,
} from "../plugins/plugin-runtime-compatibility.js";
import { defaultRuntime } from "../runtime.js";

export type PluginsRuntimeLintOptions = {
  root?: string;
  json?: boolean;
};

/** Static author diagnostics do not import or activate the inspected plugin. */
export async function runPluginsRuntimeLintCommand(opts: PluginsRuntimeLintOptions): Promise<void> {
  const packageDir = path.resolve(opts.root ?? process.cwd());
  let report: PluginRuntimeCompatibilityReport;
  try {
    const graph = await collectInstalledRuntimePackageGraph({ packageDir });
    report = await scanPluginRuntimeCompatibility(graph);
  } catch (error) {
    report = {
      complete: false,
      scannedPackages: 0,
      scannedFiles: 0,
      warnings: [
        {
          ruleId: "scan-incomplete",
          packageName: path.basename(packageDir),
          file: "package.json",
          line: 1,
          column: 1,
          message: `Runtime dependency inspection could not finish: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}. Inspect installed dependencies and retry.`,
        },
      ],
    };
  }
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
