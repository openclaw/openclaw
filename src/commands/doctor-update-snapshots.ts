import fs from "node:fs/promises";
import path from "node:path";
import { formatByteSize } from "@openclaw/normalization-core";
import { quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { resolveStateDir } from "../config/paths.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import { resolveNpmGlobalPrefixLayoutFromGlobalRoot } from "../infra/update-npm-prefix.js";
import { isUpdateDoctorLintPass } from "./doctor/shared/update-phase.js";

// Cleanup I/O failures retire snapshots under npm's dashed disposable-name form.
const SNAPSHOT_NAME = /^\.openclaw[.-]package-backup-.*\.databases$/u;
// Package installs keep PostgreSQL captures taken while the Gateway served under the capture root.
const ONLINE_SNAPSHOT_NAME = /^online-.*\.databases$/u;
const MAX_ROOT_ENTRIES = 1024;
const MAX_SIZE_ENTRIES = 4096;
const MAX_DEPTH = 32;
const SCAN_BUDGET_MS = 200;

/** Older snapshots have no durable success receipt; discovery never authorizes removal. */
export async function collectUpdateSnapshotHealthFindings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly HealthFinding[]> {
  // Shipped drivers identify update-time Doctor but do not pass its snapshot path.
  if (isUpdateDoctorLintPass(env)) {
    return [];
  }
  const packageRoot = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
  });
  const layout = packageRoot
    ? resolveNpmGlobalPrefixLayoutFromGlobalRoot(path.dirname(packageRoot))
    : null;
  const roots: [string, RegExp][] = [
    [resolveUpdateCaptureRoot(resolveStateDir(env)), ONLINE_SNAPSHOT_NAME],
  ];
  if (layout) {
    roots.unshift([layout.globalRoot, SNAPSHOT_NAME]);
  }

  const deadline = performance.now() + SCAN_BUDGET_MS;
  const directories: string[] = [];
  let partial = false;
  let rootEntries = 0;
  for (const [rootPath, name] of roots) {
    try {
      const root = await fs.opendir(rootPath);
      for await (const entry of root) {
        if (++rootEntries > MAX_ROOT_ENTRIES || performance.now() > deadline) {
          partial = true;
          break;
        }
        if (entry.isDirectory() && name.test(entry.name)) {
          directories.push(path.join(rootPath, entry.name));
        }
      }
    } catch (error) {
      partial ||= !hasErrnoCode(error, "ENOENT");
    }
  }
  if (directories.length === 0) {
    return partial && layout
      ? [
          {
            checkId: "core/doctor/update-snapshots",
            severity: "warning",
            message: `Inspection was incomplete; retained pre-migration database snapshots may remain. Manually list the npm global root ${layout.globalRoot}, including hidden entries, and check for .openclaw.package-backup-*.databases and .openclaw-package-backup-*.databases directories.`,
          },
        ]
      : [];
  }
  directories.sort();

  let bytes = 0;
  let sizeEntries = 0;
  const pending = directories.map((directory) => ({ directory, depth: 0 }));
  while (pending.length > 0) {
    if (sizeEntries >= MAX_SIZE_ENTRIES || performance.now() > deadline) {
      partial = true;
      break;
    }
    const next = pending.pop()!;
    try {
      // Do not follow snapshot or descendant symlinks into unrelated data.
      if (!(await fs.lstat(next.directory)).isDirectory()) {
        partial = true;
        continue;
      }
      const directory = await fs.opendir(next.directory);
      for await (const entry of directory) {
        if (++sizeEntries > MAX_SIZE_ENTRIES || performance.now() > deadline) {
          partial = true;
          break;
        }
        const entryPath = path.join(next.directory, entry.name);
        if (entry.isDirectory()) {
          if (next.depth < MAX_DEPTH) {
            pending.push({ directory: entryPath, depth: next.depth + 1 });
          } else {
            partial = true;
          }
        } else if (entry.isFile()) {
          const stat = await fs.lstat(entryPath);
          if (stat.isFile()) {
            bytes += stat.size;
          }
        }
      }
    } catch {
      partial = true;
    }
  }

  const size = formatByteSize(bytes, {
    style: "iec",
    maxUnit: "tera",
    separator: " ",
    fractionDigits: 1,
  });
  const commands = directories.map((directory) =>
    process.platform === "win32"
      ? `Remove-Item -LiteralPath ${quotePowerShellArg(directory)} -Recurse -Force`
      : `rm -rf -- '${directory.replaceAll("'", "'\\''")}'`,
  );
  return [
    {
      checkId: "core/doctor/update-snapshots",
      severity: "warning",
      message: [
        `${partial ? "At least " : ""}${directories.length} retained pre-migration database snapshot director${directories.length === 1 ? "y" : "ies"}: ${partial ? "at least " : ""}${bytes} bytes (${size}) in regular files.`,
        ...(partial
          ? ["Inspection was bounded or incomplete; paths and size may be partial."]
          : []),
        "Doctor cannot prove these updates succeeded and never removes these snapshots, including with --fix.",
        "Before manual removal, confirm no update is in progress and no recovery needs these snapshots; inspect the corresponding update reports first.",
        ...commands,
      ].join("\n"),
    },
  ];
}
