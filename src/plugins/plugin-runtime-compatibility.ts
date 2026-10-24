import fs from "node:fs/promises";
import path from "node:path";
import { walkDirectory } from "@openclaw/fs-safe/walk";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { tryReadJson } from "../infra/json-files.js";
import {
  collectInstalledRuntimePackageGraph,
  type InstalledRuntimePackageGraph,
} from "./installed-package-runtime-graph.js";
import {
  analyzePluginRuntimeCompatibility,
  type RuntimeCompatibilityRule,
} from "./plugin-runtime-compatibility-analysis.js";

export type PluginRuntimeCompatibilityWarning = {
  ruleId: RuntimeCompatibilityRule | "scan-incomplete";
  packageName: string;
  packageVersion?: string;
  file: string;
  line: number;
  column: number;
  message: string;
  reference?: string;
};

export type PluginRuntimeCompatibilityReport = {
  complete: boolean;
  scannedPackages: number;
  scannedFiles: number;
  warnings: PluginRuntimeCompatibilityWarning[];
};

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_WARNINGS = 100;
const ignoredDirectories = new Set([
  "node_modules",
  ".git",
  "test",
  "tests",
  "__tests__",
  "fixtures",
  "coverage",
]);

function isSourceFile(name: string): boolean {
  return (
    /\.[cm]?[jt]sx?$/u.test(name) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(name) &&
    !/\.d\.[cm]?ts$/u.test(name)
  );
}

export async function inspectPluginRuntimeCompatibility(params: {
  packageDir: string;
}): Promise<PluginRuntimeCompatibilityReport> {
  try {
    const graph = await collectInstalledRuntimePackageGraph(params);
    return await scanPluginRuntimeCompatibility(graph);
  } catch (error) {
    return {
      complete: false,
      scannedPackages: 0,
      scannedFiles: 0,
      warnings: [
        {
          ruleId: "scan-incomplete",
          packageName: path.basename(params.packageDir),
          file: "package.json",
          line: 1,
          column: 1,
          message: `Runtime dependency inspection could not finish: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}. Inspect installed dependencies and retry.`,
        },
      ],
    };
  }
}

/** Scan only materialized package roots supplied by the install graph owner. */
export async function scanPluginRuntimeCompatibility(
  graph: InstalledRuntimePackageGraph,
): Promise<PluginRuntimeCompatibilityReport> {
  const report: PluginRuntimeCompatibilityReport = {
    complete: true,
    scannedPackages: 0,
    scannedFiles: 0,
    warnings: [],
  };
  let totalBytes = 0;
  let stopped = false;
  for (const packageDir of graph.packageDirs) {
    if (stopped) {
      break;
    }
    const manifest = asNullableRecord(
      await tryReadJson<unknown>(path.join(packageDir, "package.json")).catch(() => null),
    );
    const identity = {
      packageName: typeof manifest?.name === "string" ? manifest.name : path.basename(packageDir),
      ...(typeof manifest?.version === "string" ? { packageVersion: manifest.version } : {}),
    };
    const incomplete = (file: string, message: string) => {
      report.complete = false;
      if (report.warnings.length <= MAX_WARNINGS) {
        report.warnings.push({
          ...identity,
          ruleId: "scan-incomplete",
          file,
          line: 1,
          column: 1,
          message:
            report.warnings.length === MAX_WARNINGS
              ? "Additional runtime compatibility diagnostics were omitted; inspect remaining package files separately."
              : message,
        });
      }
    };
    if (!manifest) {
      incomplete(
        "package.json",
        "Package manifest could not be read as an object; runtime dependency coverage is incomplete.",
      );
    }
    for (const message of graph.incomplete.get(packageDir) ?? []) {
      incomplete("package.json", message);
    }
    report.scannedPackages += 1;
    let depthLimited = false;
    const walked = await walkDirectory(packageDir, {
      maxEntries: MAX_FILES * 10,
      symlinks: "include",
      include: (entry) => {
        if (entry.kind !== "symlink") {
          return entry.kind !== "directory" && isSourceFile(entry.name);
        }
        if (ignoredDirectories.has(entry.name)) {
          return false;
        }
        return (
          isSourceFile(entry.name) ||
          fs.stat(entry.path).then(
            (target) => target.isDirectory(),
            () => true,
          )
        );
      },
      descend: (entry) => {
        if (ignoredDirectories.has(entry.name)) {
          return false;
        }
        if (entry.depth >= 64) {
          depthLimited = true;
          return false;
        }
        return true;
      },
    });
    if (walked.truncated || depthLimited || walked.failedDirs.length) {
      incomplete(
        ".",
        "Some package directories could not be inspected; runtime compatibility coverage is incomplete.",
      );
    }
    for (const entry of walked.entries.toSorted((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    )) {
      if (
        report.scannedFiles >= MAX_FILES ||
        totalBytes >= MAX_TOTAL_BYTES ||
        report.warnings.length >= MAX_WARNINGS
      ) {
        incomplete(
          entry.relativePath,
          "Runtime compatibility lint reached its inspection limit; inspect the remaining package files separately.",
        );
        stopped = true;
        break;
      }
      if (entry.kind !== "file") {
        incomplete(
          entry.relativePath,
          "Source and directory symlinks are not followed by runtime compatibility lint; inspect their targets separately.",
        );
        continue;
      }
      try {
        const stat = await fs.stat(entry.path);
        if (stat.size > MAX_FILE_BYTES) {
          incomplete(
            entry.relativePath,
            "Source file exceeds the runtime compatibility lint size limit; inspect it separately.",
          );
          continue;
        }
        const source = await fs.readFile(entry.path, "utf8");
        totalBytes += Buffer.byteLength(source);
        report.scannedFiles += 1;
        for (const warning of analyzePluginRuntimeCompatibility(source, entry.relativePath)) {
          if (report.warnings.length >= MAX_WARNINGS) {
            incomplete(
              entry.relativePath,
              "Additional runtime compatibility warnings were omitted; inspect this package separately.",
            );
            stopped = true;
            break;
          }
          report.warnings.push({
            ...identity,
            file: entry.relativePath.split(path.sep).join("/"),
            ...warning,
          });
        }
      } catch {
        incomplete(
          entry.relativePath,
          "Source could not be read or parsed; runtime compatibility coverage is incomplete.",
        );
      }
    }
  }
  return report;
}

export function formatPluginRuntimeCompatibilityWarning(
  warning: PluginRuntimeCompatibilityWarning,
): string {
  const packageLabel = `${warning.packageName}${warning.packageVersion ? `@${warning.packageVersion}` : ""}`;
  const reference = warning.reference ? ` (${warning.reference})` : "";
  return sanitizeTerminalText(
    `[${warning.ruleId}] ${packageLabel} ${warning.file}:${warning.line}:${warning.column}${reference}: ${warning.message}`,
  );
}
