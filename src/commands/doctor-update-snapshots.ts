import fs from "node:fs/promises";
import path from "node:path";
import { formatByteSize } from "@openclaw/normalization-core";
import { quotePowerShellArg } from "../cli/quote-cli-arg.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { resolveNpmGlobalPrefixLayoutFromGlobalRoot } from "../infra/update-npm-prefix.js";
import { isUpdateDoctorLintPass } from "./doctor/shared/update-phase.js";

const SNAPSHOT_NAME = /^\.openclaw\.package-backup-.*\.databases$/u;
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
  if (!layout) {
    return [];
  }

  const deadline = performance.now() + SCAN_BUDGET_MS;
  const directories: string[] = [];
  let partial = false;
  let rootEntries = 0;
  try {
    const root = await fs.opendir(layout.globalRoot);
    for await (const entry of root) {
      if (++rootEntries > MAX_ROOT_ENTRIES || performance.now() > deadline) {
        partial = true;
        break;
      }
      if (entry.isDirectory() && SNAPSHOT_NAME.test(entry.name)) {
        directories.push(path.join(layout.globalRoot, entry.name));
      }
    }
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return [];
    }
    partial = true;
  }
  if (directories.length === 0) {
    return partial
      ? [
          {
            checkId: "core/doctor/update-snapshots",
            severity: "warning",
            message: `Inspection was incomplete; retained pre-migration database snapshots may remain. Manually list the npm global root ${layout.globalRoot}, including hidden entries, and check for .openclaw.package-backup-*.databases directories.`,
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
