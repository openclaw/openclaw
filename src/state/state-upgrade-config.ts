import fs from "node:fs";
import path from "node:path";
import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";
import JSON5 from "json5";
import { readConfigIncludeFileWithGuards, resolveConfigIncludes } from "../config/includes.js";
import { coerceConfig } from "../config/io.read-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { fileStamp, fsyncPath, isSqliteFile, type UpgradeOp } from "./state-upgrade-tree.js";

export function readUpgradeConfig(configPath: string): {
  config: OpenClawConfig;
  files: Map<string, { raw: string; canonicalPath: string }>;
} {
  const files = new Map<string, { raw: string; canonicalPath: string }>();
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    files.set(configPath, { raw, canonicalPath: fs.realpathSync(configPath) });
    // Doctor owns validation and migration; retain its authored inputs, not a flattened config.
    const config = coerceConfig(
      resolveConfigIncludes(JSON5.parse(raw), configPath, {
        readFile: (file) => fs.readFileSync(file, "utf8"),
        readFileWithGuards: (params) => {
          let canonicalPath = params.resolvedPath;
          const included = readConfigIncludeFileWithGuards({
            ...params,
            onResolvedPath: (resolved) => {
              canonicalPath = resolved;
            },
          });
          files.set(params.resolvedPath, { raw: included, canonicalPath });
          return included;
        },
        parseJson: (text) => JSON5.parse(text),
      }),
    );
    return { config, files };
  } catch {
    return { config: {}, files };
  }
}

/** Stage only authored config dependencies, including inputs excluded by the state copy. */
export function copyUpgradeConfigInputs(params: {
  configPath: string;
  shadowConfig: string;
  workDir: string;
  files: ReadonlyMap<string, { raw: string; canonicalPath: string }>;
  baseline?: Map<string, string | undefined>;
}): Map<string, string> {
  const configDir = path.dirname(params.configPath);
  const shadowDir = path.dirname(params.shadowConfig);
  const inputs = new Map([[params.configPath, params.shadowConfig]]);
  for (const [file, { raw, canonicalPath }] of params.files) {
    const relative = path.relative(configDir, file);
    // An absolute alias stays inside the private tree at its admitted canonical location.
    const within =
      relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    const target = path.join(
      shadowDir,
      within ? relative : path.relative(fs.realpathSync(configDir), canonicalPath),
    );
    // copyTree retains dependency-directory symlinks. Materialize only this input
    // path before writing so a retained link can never redirect staging into live state.
    let parent = params.workDir;
    for (const part of path.relative(params.workDir, path.dirname(target)).split(path.sep)) {
      parent = path.join(parent, part);
      if (fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) {
        fs.unlinkSync(parent);
      }
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    }
    // Replace the private inode rather than truncating a copied read-only file.
    fs.rmSync(target, { force: true });
    fs.writeFileSync(target, raw, { mode: fs.statSync(file).mode & 0o7777 });
    params.baseline?.set(target, fileStamp(target));
    inputs.set(file, target);
  }
  return inputs;
}

/** Replace a path prefix in a non-SQLite file or a symlink target. */
export function rewriteFilePrefix(file: string, source: string, destination: string): boolean {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(file);
    if (!target.includes(source)) {
      return false;
    }
    fs.rmSync(file);
    fs.symlinkSync(target.replaceAll(source, destination), file);
    return true;
  }
  const bytes = fs.readFileSync(file);
  // JSON may mix escaped Windows paths and forward-slash includes. Match every
  // spelling against the original bytes so replacement text is never rewritten.
  const replacements = new Map([
    [JSON.stringify(source).slice(1, -1), JSON.stringify(destination).slice(1, -1)],
    [source, destination],
    [source.replaceAll("\\", "/"), destination.replaceAll("\\", "/")],
  ]);
  const parts: Buffer[] = [];
  let start = 0;
  while (start < bytes.length) {
    let at = -1;
    let from = "";
    let to = "";
    for (const [candidate, replacement] of replacements) {
      const next = bytes.indexOf(candidate, start);
      if (next >= 0 && (at < 0 || next < at)) {
        at = next;
        from = candidate;
        to = replacement;
      }
    }
    if (at < 0) {
      break;
    }
    parts.push(bytes.subarray(start, at), Buffer.from(to));
    start = at + Buffer.byteLength(from);
  }
  if (parts.length === 0) {
    return false;
  }
  parts.push(bytes.subarray(start));
  // Replace read-only private copies without changing their live originals.
  fs.rmSync(file);
  fs.writeFileSync(file, Buffer.concat(parts), { mode: stat.mode & 0o7777 });
  return true;
}

/** Refuse an unpublishable config before any database swap becomes durable. */
export function configPublicationRefusal(
  inputs: ReadonlyMap<string, string>,
  ops: readonly UpgradeOp[],
  requirePlanned: boolean,
): string | undefined {
  const mounts = new Set(
    process.platform === "linux"
      ? fs
          .readFileSync("/proc/self/mountinfo", "utf8")
          .split("\n")
          .map((line) => decodeMountInfoPath(line.split(" ")[4] ?? ""))
      : [],
  );
  for (const [file, target] of inputs) {
    if (
      !fs.existsSync(target) ||
      !fs.existsSync(file) ||
      fs.readFileSync(file).equals(fs.readFileSync(target))
    ) {
      continue;
    }
    if (
      mounts.has(fs.realpathSync(file)) ||
      (requirePlanned && !ops.some((op) => op.live === file))
    ) {
      return (
        "Changed config " +
        file +
        " cannot be safely published. Run openclaw doctor --fix before retrying. Nothing live was changed."
      );
    }
  }
  return undefined;
}

export function stageUpgradeConfigs(
  configInputs: ReadonlyMap<string, string>,
  configFiles: ReadonlyMap<string, { canonicalPath: string }>,
  ops: UpgradeOp[],
  workDir: string,
  stagedConfigs: Set<string>,
): void {
  // A workspace include can be on another filesystem even when the root is not.
  // Stage its planned writes (including Doctor backups) beside their destinations.
  const configDirectories = new Set(
    [...configInputs.keys()].flatMap((file) => [
      path.dirname(file),
      path.dirname(configFiles.get(file)?.canonicalPath ?? file),
    ]),
  );
  for (const op of ops) {
    if (op.next && configDirectories.has(path.dirname(op.live)) && !isSqliteFile(op.next)) {
      const staged = path.join(
        path.dirname(op.live),
        `.${path.basename(op.live)}${path.basename(workDir)}`,
      );
      stagedConfigs.add(staged);
      fs.cpSync(op.next, staged, { verbatimSymlinks: true });
      op.next = staged;
    }
    if (op.next && fs.statSync(op.next, { throwIfNoEntry: false })?.isFile()) {
      fsyncPath(op.next);
      fsyncPath(path.dirname(op.next), true);
    }
  }
}
