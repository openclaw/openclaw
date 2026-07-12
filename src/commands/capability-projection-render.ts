import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import type { CapabilityProjectionReport } from "./capability-projection-model.js";
import { CapabilityProjectionReportSchema } from "./capability-projection-schema.js";

function escapeMarkdown(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", " ");
}

function state(value: { value: string }): string {
  return value.value;
}

export function renderCapabilityProjectionJson(report: CapabilityProjectionReport): string {
  const validated = CapabilityProjectionReportSchema.parse(report);
  return `${JSON.stringify(validated, null, 2)}\n`;
}

export function renderCapabilityProjectionMarkdown(report: CapabilityProjectionReport): string {
  const validated = CapabilityProjectionReportSchema.parse(report);
  const lines = [
    "# Capability Projection Report",
    "",
    `- Schema: \`${validated.schema}@${validated.schemaVersion}\``,
    `- Report ID: \`${validated.reportId}\``,
    `- Generated: \`${validated.generatedAt}\``,
    `- Agent: \`${escapeMarkdown(validated.target.agentId)}\``,
    `- Session: \`${escapeMarkdown(validated.target.sessionKey)}\``,
    `- Run: \`${escapeMarkdown(validated.target.runId ?? "unknown")}\``,
    `- Confidence: \`${validated.overallConfidence.level}\``,
    "",
    "## Capability summary",
    "",
    "| Capability | Configured | Runtime loaded | Policy allowed | Turn projected | Callability |",
    "|---|---|---|---|---|---|",
  ];
  for (const capability of validated.capabilities) {
    const callability = Object.entries(capability.callabilityCounts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => `${name}:${count}`)
      .join(", ");
    lines.push(
      `| ${capability.name} | ${state(capability.summary.configured)} | ${state(capability.summary.runtimeLoaded)} | ${state(capability.summary.policyAllowed)} | ${state(capability.summary.turnProjected)} | ${escapeMarkdown(callability)} |`,
    );
  }
  for (const capability of validated.capabilities) {
    lines.push(
      "",
      `## ${capability.name}`,
      "",
      `<!-- capability:${capability.name} -->`,
      "",
      "| Tool | Configured | Loaded | Allowed | Projected | Callability | Mismatches |",
      "|---|---|---|---|---|---|---|",
    );
    for (const tool of capability.tools) {
      lines.push(
        `| ${escapeMarkdown(tool.name)} <!-- tool:${escapeMarkdown(tool.name)} --> | ${state(tool.configured)} | ${state(tool.runtimeLoaded)} | ${state(tool.policyAllowed)} | ${state(tool.turnProjected)} | ${tool.callabilityStatus} | ${tool.mismatchCodes.join(", ")} |`,
      );
    }
  }
  lines.push("", "## Collection errors", "");
  if (validated.collectionErrors.length === 0) {
    lines.push("None.");
  } else {
    for (const error of validated.collectionErrors) {
      lines.push(`- \`${escapeMarkdown(error.code)}\`: ${escapeMarkdown(error.message)}`);
    }
  }
  lines.push("", "## Evidence index", "");
  for (const evidence of validated.evidence) {
    lines.push(
      `- \`${escapeMarkdown(evidence.id)}\` rank ${evidence.rank}: ${evidence.kind} (${evidence.status}, ${evidence.periodRelation})`,
    );
  }
  lines.push(
    "",
    "## Redaction",
    "",
    `Policy: \`${validated.redaction.policy}\`.`,
    "",
    ...validated.redaction.notes.map((note) => `- ${escapeMarkdown(note)}`),
    "",
  );
  return `${lines.join("\n")}\n`;
}

export function assertCapabilityProjectionParity(
  report: CapabilityProjectionReport,
  markdown: string,
): void {
  for (const capability of report.capabilities) {
    if (!markdown.includes(`<!-- capability:${capability.name} -->`)) {
      throw new Error("Capability projection Markdown parity check failed");
    }
    for (const tool of capability.tools) {
      if (!markdown.includes(`<!-- tool:${escapeMarkdown(tool.name)} -->`)) {
        throw new Error("Capability projection Markdown parity check failed");
      }
    }
  }
}

type PublicationFs = Pick<
  typeof fs,
  | "chmod"
  | "lstat"
  | "mkdir"
  | "readFile"
  | "readlink"
  | "realpath"
  | "rename"
  | "rm"
  | "symlink"
  | "writeFile"
>;

async function ensureOutputDirectory(
  fsImpl: PublicationFs,
  root: string,
  outputDir: string,
): Promise<void> {
  const rootStat = await fsImpl.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Capability projection output root is not a real directory");
  }
  const realRoot = await fsImpl.realpath(root);
  const relative = path.relative(root, outputDir);
  let cursor = realRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await fsImpl.lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Capability projection output path contains a non-directory component");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await fsImpl.mkdir(cursor, { mode: 0o700 });
    }
  }
  if (outputDir !== root) {
    await fsImpl.chmod(outputDir, 0o700);
  }
}

export async function publishCapabilityProjectionPair(params: {
  report: CapabilityProjectionReport;
  outputRoot: string;
  outputDir: string;
  fsImpl?: PublicationFs;
  platform?: NodeJS.Platform;
}): Promise<{ jsonPath: string; markdownPath: string }> {
  if ((params.platform ?? process.platform) !== "linux") {
    throw new Error("Atomic capability projection publication is supported on Linux only");
  }
  const fsImpl = params.fsImpl ?? fs;
  const root = path.resolve(params.outputRoot);
  const outputDir = path.resolve(params.outputDir);
  if (outputDir !== root && !isPathInside(root, outputDir)) {
    throw new Error("Capability projection output path escaped the approved root");
  }
  await ensureOutputDirectory(fsImpl, root, outputDir);
  const json = renderCapabilityProjectionJson(params.report);
  const markdown = renderCapabilityProjectionMarkdown(params.report);
  assertCapabilityProjectionParity(params.report, markdown);
  const jsonPath = path.join(outputDir, "current-turn.json");
  const markdownPath = path.join(outputDir, "current-turn.md");
  const versionsDir = path.join(outputDir, ".versions");
  const nonce = `${process.pid}-${Date.now()}`;
  const contentHash = createHash("sha256").update(json).update("\0").update(markdown).digest("hex");
  const versionName = `${params.report.reportId}-${contentHash.slice(0, 16)}`;
  const versionDir = path.join(versionsDir, versionName);
  const stagedVersionDir = path.join(versionsDir, `.${versionName}.${nonce}.tmp`);
  const currentPointer = path.join(outputDir, ".current");
  const stagedPointer = `${currentPointer}.${nonce}.tmp`;
  const stableLinks = [
    { path: jsonPath, target: path.join(".current", "current-turn.json") },
    { path: markdownPath, target: path.join(".current", "current-turn.md") },
  ];
  const createdLinks: string[] = [];
  try {
    try {
      await fsImpl.mkdir(versionsDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const versionsStat = await fsImpl.lstat(versionsDir);
      if (versionsStat.isSymbolicLink() || !versionsStat.isDirectory()) {
        throw new Error("Capability projection versions path is not a real directory");
      }
    }
    await fsImpl.chmod(versionsDir, 0o700);
    await fsImpl.mkdir(stagedVersionDir, { mode: 0o700 });
    await fsImpl.writeFile(path.join(stagedVersionDir, "current-turn.json"), json, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fsImpl.writeFile(path.join(stagedVersionDir, "current-turn.md"), markdown, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fsImpl.chmod(path.join(stagedVersionDir, "current-turn.json"), 0o600);
    await fsImpl.chmod(path.join(stagedVersionDir, "current-turn.md"), 0o600);
    await fsImpl.rename(stagedVersionDir, versionDir).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      await fsImpl.rm(stagedVersionDir, { recursive: true, force: true });
    });
    try {
      const currentStat = await fsImpl.lstat(currentPointer);
      if (!currentStat.isSymbolicLink()) {
        throw new Error("Capability projection current pointer is not a symlink");
      }
      const currentTarget = await fsImpl.readlink(currentPointer);
      if (!/^\.versions\/cpr-v1-[a-f0-9]{16}-[a-f0-9]{16}$/u.test(currentTarget)) {
        throw new Error("Capability projection current pointer has an unexpected target");
      }
      const currentVersionDir = path.resolve(outputDir, currentTarget);
      if (!isPathInside(versionsDir, currentVersionDir)) {
        throw new Error("Capability projection current pointer escaped the versions directory");
      }
      const currentVersionStat = await fsImpl.lstat(currentVersionDir);
      if (currentVersionStat.isSymbolicLink() || !currentVersionStat.isDirectory()) {
        throw new Error("Capability projection current pointer target is not a real directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    for (const link of stableLinks) {
      try {
        const existingTarget = await fsImpl.readlink(link.path);
        if (existingTarget !== link.target) {
          throw new Error("Capability projection output link has an unexpected target");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        const stagedLink = `${link.path}.${nonce}.tmp`;
        await fsImpl.symlink(link.target, stagedLink);
        await fsImpl.rename(stagedLink, link.path);
        createdLinks.push(link.path);
      }
    }
    await fsImpl.symlink(path.join(".versions", versionName), stagedPointer);
    // Readers resolve this pointer once before opening either format. Renaming
    // it is the sole visibility commit, so it never names a partial pair.
    await fsImpl.rename(stagedPointer, currentPointer);
    return { jsonPath, markdownPath };
  } catch (error) {
    await fsImpl.rm(stagedPointer, { force: true }).catch(() => undefined);
    await fsImpl.rm(stagedVersionDir, { recursive: true, force: true }).catch(() => undefined);
    for (const link of createdLinks) {
      await fsImpl.rm(link, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}
