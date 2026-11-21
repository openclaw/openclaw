import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { configDefaults } from "vitest/config";
import type { CliOptions, Reporter } from "vitest/node";

type ReporterReference = Reporter | [string, Record<string, unknown>];

const redactingReporterPath = fileURLToPath(new URL("./redacting-reporter.ts", import.meta.url));

function normalizeReporters(reporters: CliOptions["reporters"]): ReporterReference[] {
  const entries = Array.isArray(reporters) ? reporters : reporters ? [reporters] : [];
  return entries.flatMap((entry): ReporterReference[] => {
    if (typeof entry === "string") {
      return [[entry, {}]];
    }
    if (!Array.isArray(entry)) {
      return [entry];
    }
    const [name, originalOptions] = entry;
    const options: Record<string, unknown> = { ...originalOptions };
    if (name === redactingReporterPath && Array.isArray(options.reporters)) {
      return normalizeReporters(options.reporters);
    }
    return [[name, options]];
  });
}

export function createRedactingReporterPlugin(): Plugin {
  return {
    name: "openclaw:redacting-test-reporters",
    enforce: "post",
    config: {
      order: "post",
      handler(config) {
        const test: CliOptions = (config.test ??= {});
        let reporters = normalizeReporters(test.reporters ?? configDefaults.reporters);
        const cliReporters = [test.reporter ?? []]
          .flat()
          .map((name) => (/^\.\.?\//u.test(name) ? path.resolve(name) : name));
        if (cliReporters.length) {
          const configuredOptions = new Map(
            reporters.flatMap((entry) => (Array.isArray(entry) ? [entry] : [])),
          );
          reporters = [...new Set(cliReporters)]
            .filter(Boolean)
            .map((name) => [name, configuredOptions.get(name) ?? {}]);
        }
        // The wrapper hides reporter instances from Vitest's native merge guard.
        if (
          test.mergeReports &&
          reporters.some((entry) => Array.isArray(entry) && entry[0] === "blob")
        ) {
          throw new Error(
            "Cannot merge reports when `--reporter=blob` is used. Remove blob reporter from the config first.",
          );
        }
        // Vitest applies its CLI reporter alias after Vite hooks; consume it here
        // so explicit CLI choices pass through the same output owner as defaults.
        delete test.reporter;
        test.reporters = [[redactingReporterPath, { reporters }]];
      },
    },
  };
}
