/** Doctor-owned migration from workspace TOOLS.md into the AGENTS.md Tools section. */
import { isUtf8 } from "node:buffer";
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readRegularFile } from "@openclaw/fs-safe/advanced";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { note } from "../../packages/terminal-core/src/note.js";
import { DEFAULT_AGENTS_FILENAME, DEFAULT_TOOLS_FILENAME } from "../agents/workspace.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { publishFileNoClobber, syncDirectoryIfSupported } from "../infra/directory-durability.js";
import { formatErrorMessage as errorMessage } from "../infra/errors.js";
import { shortenHomePath } from "../utils.js";
import { noteDoctorMigrationResult } from "./doctor-migration-notes.js";
import {
  describeToolsMdMergedBootstrapLimits,
  resolveToolsMdMigrationWorkspaceTargets,
} from "./doctor-tools-md-migration-budget.js";
import { shouldMergeToolsMd } from "./doctor-tools-md-migration-content.js";
import { rewriteLegacyAgentsToolsGuidance as rewriteLegacyToolsGuidance } from "./doctor-tools-md-migration-guidance.js";

const MIGRATED_SUBSECTION_HEADING = "### Local notes (migrated from TOOLS.md)";
const NO_CLOBBER_PUBLICATION = {
  strategy: "link-or-copy",
  durability: "degrade",
} as const;

type ToolsMdMigrationResult = {
  changes: string[];
  warnings: string[];
};

type ToolsMdSource = {
  path: string;
  content: string;
  sha256: string;
  stat: syncFs.Stats;
};

type MigrationFileSnapshot = {
  content: string;
  stat?: syncFs.Stats;
};

type PosixFilePermissions = Pick<syncFs.Stats, "uid" | "gid" | "mode">;

function sameFileIdentity(left?: syncFs.Stats, right?: syncFs.Stats): boolean {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function samePosixPermissions(left: PosixFilePermissions, right: PosixFilePermissions): boolean {
  return (
    left.uid === right.uid &&
    left.gid === right.gid &&
    (left.mode & 0o7777) === (right.mode & 0o7777)
  );
}

function addsPosixReaders(
  source: PosixFilePermissions,
  destination: PosixFilePermissions,
): boolean {
  // Owner and group membership take precedence over other bits, including denied owner reads.
  for (const uid of new Set([source.uid, destination.uid, undefined])) {
    for (const sourceGroup of [false, true]) {
      for (const destinationGroup of [false, true]) {
        if (source.gid === destination.gid && sourceGroup !== destinationGroup) {
          continue;
        }
        const sourceBit = uid === source.uid ? 0o400 : sourceGroup ? 0o040 : 0o004;
        const destinationBit = uid === destination.uid ? 0o400 : destinationGroup ? 0o040 : 0o004;
        if ((destination.mode & destinationBit) !== 0 && (source.mode & sourceBit) === 0) {
          return true;
        }
      }
    }
  }
  return false;
}

async function assertSourceReadersPreserved(
  source: ToolsMdSource,
  destination: PosixFilePermissions,
): Promise<void> {
  const current = await readMigrationFileSnapshot(source.path);
  if (
    current.content !== source.content ||
    !current.stat ||
    !sameFileIdentity(current.stat, source.stat) ||
    !samePosixPermissions(current.stat, source.stat)
  ) {
    throw new Error("TOOLS.md changed during migration");
  }
  if (addsPosixReaders(current.stat, destination)) {
    throw new Error(
      "Merging TOOLS.md would grant additional POSIX readers. Review both files' owners, groups, and read permissions before rerunning doctor.",
    );
  }
}

async function readMigrationFileSnapshot(
  filePath: string,
  allowMissing = false,
): Promise<MigrationFileSnapshot> {
  let stat: syncFs.Stats;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: "" };
    }
    throw error;
  }
  if (!stat.isFile() || stat.nlink > 1) {
    throw new Error(
      `${path.basename(filePath)} must be an unlinked regular file for automatic migration`,
    );
  }
  const file = await readRegularFile({ filePath });
  const currentStat = await fs.lstat(filePath);
  if (
    file.stat.nlink !== 1 ||
    !sameFileIdentity(file.stat, stat) ||
    !sameFileIdentity(currentStat, file.stat)
  ) {
    throw new Error(`${path.basename(filePath)} changed while opening it for migration`);
  }
  if (!isUtf8(file.buffer)) {
    throw new Error(
      `${path.basename(filePath)} must be valid UTF-8. The file was left untouched. Preserve a byte-for-byte copy, recover or convert it using its known original encoding, then rerun ${formatCliCommand("openclaw doctor --fix")}.`,
    );
  }
  return { content: file.buffer.toString("utf8"), stat: currentStat };
}

async function readToolsMd(workspaceDir: string): Promise<ToolsMdSource | undefined> {
  const entries = await fs.readdir(workspaceDir).catch(() => [] as string[]);
  const betaArtifacts = entries.filter(
    (entry) =>
      entry.startsWith(`${DEFAULT_TOOLS_FILENAME}.doctor-importing-`) ||
      entry.startsWith(`${DEFAULT_AGENTS_FILENAME}.doctor-backup-`),
  );
  if (betaArtifacts.length > 0) {
    throw new Error(
      `Interrupted v2026.7.2-beta.5 migration artifact(s) left untouched: ${betaArtifacts.join(", ")}. Restore the desired file manually before rerunning doctor.`,
    );
  }
  const toolsPath = path.join(workspaceDir, DEFAULT_TOOLS_FILENAME);
  const snapshot = await readMigrationFileSnapshot(toolsPath, true);
  if (!snapshot.stat) {
    return undefined;
  }
  return {
    path: toolsPath,
    content: snapshot.content,
    sha256: sha256Hex(snapshot.content),
    stat: snapshot.stat,
  };
}

function appendWithSpacing(before: string, addition: string, after = ""): string {
  const spacing = (text: string) =>
    text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  const prefix = before.length === 0 ? "" : spacing(before);
  const suffix = after.length === 0 ? "" : spacing(addition);
  return `${before}${prefix}${addition}${suffix}${after}`;
}

function mergeToolsMdIntoAgentsMd(agentsContent: string, toolsContent: string): string {
  const mergedAgentsContent = rewriteLegacyAgentsToolsGuidance(agentsContent);
  const headingIndex = mergedAgentsContent.indexOf(MIGRATED_SUBSECTION_HEADING);
  if (headingIndex >= 0 && mergedAgentsContent.includes(toolsContent)) {
    return mergedAgentsContent;
  }
  const block =
    headingIndex >= 0 ? toolsContent : `${MIGRATED_SUBSECTION_HEADING}\n\n${toolsContent}`;
  const insertAt =
    headingIndex >= 0
      ? headingIndex + MIGRATED_SUBSECTION_HEADING.length
      : findToolsSection(mergedAgentsContent)?.insertAt;
  if (insertAt === undefined) {
    return appendWithSpacing(mergedAgentsContent, `## Tools\n\n${block}`);
  }
  return appendWithSpacing(
    mergedAgentsContent.slice(0, insertAt),
    block,
    mergedAgentsContent.slice(insertAt),
  );
}

function rewriteLegacyAgentsToolsGuidance(content: string): string {
  const rewritten = rewriteLegacyToolsGuidance(content);
  return rewritten === content ? content : ensureLocalNotesHeading(rewritten);
}

function findToolsSection(content: string): { headingEnd: number; insertAt: number } | undefined {
  let offset = 0;
  let headingEnd = 0;
  let fence: { marker: "`" | "~"; length: number } | undefined;
  for (const lineWithEnding of content.match(/.*(?:\n|$)/gu) ?? []) {
    if (lineWithEnding === "") {
      continue;
    }
    const line = lineWithEnding.replace(/\n$/u, "");
    const fenceRun = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    const closingFenceRun = /^\s*(`{3,}|~{3,})\s*$/u.exec(line)?.[1];
    const marker = fenceRun?.[0] as "`" | "~" | undefined;
    if (marker && !fence) {
      fence = { marker, length: fenceRun!.length };
    } else if (
      closingFenceRun &&
      fence &&
      closingFenceRun[0] === fence.marker &&
      closingFenceRun.length >= fence.length
    ) {
      fence = undefined;
    } else if (!fence) {
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
      if (heading) {
        const depth = heading[1]!.length;
        if (headingEnd > 0 && depth <= 2) {
          return { headingEnd, insertAt: offset };
        }
        if (depth === 2 && heading[2]!.trim().toLowerCase() === "tools") {
          headingEnd = offset + lineWithEnding.length;
        }
      }
    }
    offset += lineWithEnding.length;
  }
  return headingEnd > 0 ? { headingEnd, insertAt: content.length } : undefined;
}

function ensureLocalNotesHeading(content: string): string {
  const section = findToolsSection(content);
  if (!section) {
    return content;
  }
  const body = content.slice(section.headingEnd, section.insertAt);
  if (/^###\s+Local notes(?:\s|$)/imu.test(body)) {
    return content;
  }
  return `${content.slice(0, section.headingEnd)}\n### Local notes\n${content.slice(section.headingEnd)}`;
}

async function writeAgentsAtomically(params: {
  agentsPath: string;
  expected: string;
  content: string;
  importedSource?: ToolsMdSource;
}): Promise<void> {
  const snapshot = await readMigrationFileSnapshot(params.agentsPath, true);
  if (snapshot.content !== params.expected) {
    throw new Error("AGENTS.md changed during TOOLS.md migration");
  }
  const stat = snapshot.stat;
  const mode = stat?.mode ?? 0o600;
  const tempPath = `${params.agentsPath}.doctor-writing-${process.pid}-${Date.now()}`;
  try {
    let prepared: syncFs.Stats;
    {
      await using handle = await fs.open(tempPath, "wx", 0o600);
      await handle.writeFile(params.content, "utf8");
      if (process.platform !== "win32" && stat) {
        // Changing the owner must not grant the new UID the staging file's owner-read bit.
        await handle.chmod(0o000);
        await handle.chown(stat.uid, stat.gid);
      }
      if (process.platform !== "win32" && params.importedSource) {
        await assertSourceReadersPreserved(params.importedSource, stat ?? (await handle.stat()));
      }
      if (stat) {
        await handle.chmod(mode);
      }
      prepared = await handle.stat();
      if (process.platform !== "win32" && stat && !samePosixPermissions(prepared, stat)) {
        throw new Error("AGENTS.md ownership or permissions could not be preserved");
      }
      await handle.sync();
    }
    // Doctor is a single-operator flow. This final snapshot catches edits before
    // commit without retaining the retired cross-process claim protocol.
    const current = await readMigrationFileSnapshot(params.agentsPath, true);
    if (
      current.content !== params.expected ||
      !sameFileIdentity(current.stat, stat) ||
      (process.platform !== "win32" &&
        current.stat &&
        stat &&
        !samePosixPermissions(current.stat, stat))
    ) {
      throw new Error("AGENTS.md changed during TOOLS.md migration");
    }
    if (process.platform !== "win32" && params.importedSource) {
      await assertSourceReadersPreserved(params.importedSource, prepared);
    }
    await fs.rename(tempPath, params.agentsPath);
    await syncDirectoryIfSupported(path.dirname(params.agentsPath));
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

async function recoverInterruptedAgentsWrite(agentsPath: string): Promise<void> {
  const dir = path.dirname(agentsPath);
  const prefix = `${path.basename(agentsPath)}.doctor-writing-`;
  const entries = (await fs.readdir(dir).catch(() => [] as string[])).filter((entry) =>
    entry.startsWith(prefix),
  );
  for (const entry of entries) {
    const tempPath = path.join(dir, entry);
    const stat = await fs.lstat(tempPath);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`interrupted AGENTS.md write must be an unlinked regular file: ${tempPath}`);
    }
    await fs.rm(tempPath);
  }
  if (entries.length > 0) {
    await syncDirectoryIfSupported(dir);
  }
}

async function removeToolsSource(source: ToolsMdSource, workspaceDir: string): Promise<void> {
  const current = await readMigrationFileSnapshot(source.path);
  if (sha256Hex(current.content) !== source.sha256) {
    throw new Error("TOOLS.md changed during migration");
  }
  // The original bytes are durable in both the archive and merged AGENTS.md;
  // the single-operator migration deliberately has no concurrent-writer claim.
  const currentStat = syncFs.lstatSync(source.path);
  if (
    !current.stat ||
    !sameFileIdentity(currentStat, current.stat) ||
    !sameFileIdentity(currentStat, source.stat)
  ) {
    throw new Error("TOOLS.md changed during migration");
  }
  syncFs.unlinkSync(source.path);
  await syncDirectoryIfSupported(workspaceDir);
}

async function archiveSource(params: {
  agentId: string;
  source: ToolsMdSource;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const safeAgentId = params.agentId.replace(/[^A-Za-z0-9._-]+/g, "-");
  const archivePath = path.join(
    resolveStateDir(params.env),
    "backups",
    "tools-md-migration",
    `${safeAgentId}-${params.source.sha256}.md`,
  );
  const archiveDir = path.dirname(archivePath);
  await fs.mkdir(archiveDir, { recursive: true, mode: 0o700 });
  const tempPath = `${archivePath}.doctor-writing-${process.pid}-${Date.now()}`;
  try {
    {
      await using handle = await fs.open(tempPath, "wx", 0o600);
      await handle.writeFile(params.source.content, "utf8");
      await handle.sync();
    }
    await publishFileNoClobber(tempPath, archivePath, NO_CLOBBER_PUBLICATION);
    await fs.rm(tempPath);
    await syncDirectoryIfSupported(archiveDir);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    if (sha256Hex(await fs.readFile(archivePath, "utf8")) !== params.source.sha256) {
      throw new Error(`TOOLS.md migration archive collision at ${archivePath}`, { cause: error });
    }
  }
}

export async function collectToolsMdMigrationFindings(
  cfg: OpenClawConfig,
): Promise<readonly HealthFinding[]> {
  const MIGRATION_FINDING_DEFAULTS = {
    checkId: "core/doctor/tools-md-migration",
    severity: "warning",
    fixHint: `Run ${formatCliCommand("openclaw doctor --fix")} to merge TOOLS.md into AGENTS.md.`,
  } as const;
  const findings: HealthFinding[] = [];
  for (const target of resolveToolsMdMigrationWorkspaceTargets(cfg)) {
    try {
      const source = await readToolsMd(target.workspaceDir);
      if (source) {
        findings.push({
          ...MIGRATION_FINDING_DEFAULTS,
          target: target.primaryAgentId,
          path: source.path,
          message: `Agent "${target.primaryAgentId}" still stores local tool notes in TOOLS.md.`,
          requirement: "legacy-tools-md",
        });
        if (shouldMergeToolsMd(source.content)) {
          const agentsPath = path.join(target.workspaceDir, DEFAULT_AGENTS_FILENAME);
          const agentsContent = (await readMigrationFileSnapshot(agentsPath, true)).content;
          const mergedChars = mergeToolsMdIntoAgentsMd(agentsContent, source.content).length;
          for (const budget of describeToolsMdMergedBootstrapLimits({
            cfg,
            agentIds: target.agentIds,
            mergedChars,
          })) {
            findings.push({
              ...MIGRATION_FINDING_DEFAULTS,
              target: budget.agentId,
              path: agentsPath,
              message: budget.message,
              requirement: "tools-md-merged-bootstrap-limit",
            });
          }
        }
      }
    } catch (error) {
      findings.push({
        ...MIGRATION_FINDING_DEFAULTS,
        target: target.primaryAgentId,
        path: path.join(target.workspaceDir, DEFAULT_TOOLS_FILENAME),
        message: `Agent "${target.primaryAgentId}" TOOLS.md cannot be migrated: ${errorMessage(error)}`,
        severity: "error",
        requirement: "tools-md-migration-blocked",
      });
    }
  }
  return findings;
}

export async function maybeMigrateToolsMd(params: {
  cfg: OpenClawConfig;
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<ToolsMdMigrationResult> {
  const env = params.env ?? process.env;
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const target of resolveToolsMdMigrationWorkspaceTargets(params.cfg)) {
    try {
      const source = await readToolsMd(target.workspaceDir);
      if (!source) {
        continue;
      }
      if (!params.shouldRepair) {
        note(
          `${shortenHomePath(source.path)} will be archived and merged into AGENTS.md when customized.`,
          "TOOLS.md migration preview",
        );
        continue;
      }

      const shouldMerge = shouldMergeToolsMd(source.content);
      await archiveSource({ agentId: target.primaryAgentId, source, env });
      const agentsPath = path.join(target.workspaceDir, DEFAULT_AGENTS_FILENAME);
      await recoverInterruptedAgentsWrite(agentsPath);
      const agentsContent = (await readMigrationFileSnapshot(agentsPath, true)).content;
      const merged = shouldMerge
        ? mergeToolsMdIntoAgentsMd(agentsContent, source.content)
        : rewriteLegacyAgentsToolsGuidance(agentsContent);
      if (merged !== agentsContent) {
        await writeAgentsAtomically({
          agentsPath,
          expected: agentsContent,
          content: merged,
          importedSource:
            shouldMerge && !agentsContent.includes(source.content) ? source : undefined,
        });
        if ((await readMigrationFileSnapshot(agentsPath)).content !== merged) {
          throw new Error("AGENTS.md changed after TOOLS.md migration was written");
        }
      }
      // Fence an earlier AGENTS rename before the durable source unlink, including reruns.
      await syncDirectoryIfSupported(target.workspaceDir);
      await removeToolsSource(source, target.workspaceDir);
      changes.push(
        shouldMerge
          ? `Merged ${shortenHomePath(source.path)} into AGENTS.md and archived the original.`
          : `Removed untouched ${shortenHomePath(source.path)} after archiving it.`,
      );
    } catch (error) {
      warnings.push(
        `Agent "${target.primaryAgentId}" TOOLS.md was not migrated: ${errorMessage(error)}`,
      );
    }
  }
  noteDoctorMigrationResult({ changes, warnings }, { changesTitle: "TOOLS.md migration" });
  return { changes, warnings };
}
