import { createHash } from "node:crypto";
import { closeSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { openLocalAgentAvatarFile } from "../agents/identity-avatar-file.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readFileDescriptorBoundedSync } from "../infra/file-descriptor-read.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { AVATAR_MAX_BYTES, isAvatarDataUrl, isAvatarHttpUrl } from "../shared/avatar-policy.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveUserPath } from "../utils.js";
import { readClawStatus } from "./lifecycle-state.js";
import { parseClawManifest } from "./schema.js";
import {
  CLAW_BOOTSTRAP_FILE_NAMES,
  CLAW_OUTPUT_STABILITY,
  CLAW_SCHEMA_VERSION,
  type ClawAgent,
  type ClawBootstrapFileName,
  type ClawManifest,
} from "./types.js";

export const CLAW_EXPORT_RESULT_SCHEMA_VERSION = "openclaw.clawExportResult.v1" as const;
const MAX_EXPORT_FILE_BYTES = 1024 * 1024;

type AgentConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

export type ClawExportResult = {
  schemaVersion: typeof CLAW_EXPORT_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  agentId: string;
  outputDirectory: string;
  manifest: ClawManifest;
  filesWritten: string[];
};

export class ClawExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawExportError";
  }
}

function portableAgent(agent: AgentConfig, avatar: string | undefined): ClawAgent {
  const identity = {
    ...(agent.identity?.name ? { name: agent.identity.name } : {}),
    ...(agent.identity?.theme ? { theme: agent.identity.theme } : {}),
    ...(agent.identity?.emoji ? { emoji: agent.identity.emoji } : {}),
    ...(avatar ? { avatar } : {}),
  };
  const tools = {
    ...(agent.tools?.allow?.length ? { allow: agent.tools.allow } : {}),
    ...(agent.tools?.deny?.length ? { deny: agent.tools.deny } : {}),
  };
  return {
    id: agent.id,
    ...(agent.name ? { name: agent.name } : {}),
    ...(agent.description ? { description: agent.description } : {}),
    ...(Object.keys(identity).length > 0 ? { identity } : {}),
    ...(agent.groupChat?.mentionPatterns?.length
      ? { groupChat: { mentionPatterns: agent.groupChat.mentionPatterns } }
      : {}),
    ...(agent.sandbox
      ? {
          sandbox: {
            ...(agent.sandbox.mode ? { mode: agent.sandbox.mode } : {}),
            ...(agent.sandbox.scope ? { scope: agent.sandbox.scope } : {}),
            ...(agent.sandbox.workspaceAccess
              ? { workspaceAccess: agent.sandbox.workspaceAccess }
              : {}),
          },
        }
      : {}),
    ...(Object.keys(tools).length > 0 ? { tools } : {}),
    ...(agent.heartbeat
      ? {
          heartbeat: {
            ...(agent.heartbeat.every ? { every: agent.heartbeat.every } : {}),
            ...(agent.heartbeat.activeHours
              ? {
                  activeHours: {
                    ...(agent.heartbeat.activeHours.start
                      ? { start: agent.heartbeat.activeHours.start }
                      : {}),
                    ...(agent.heartbeat.activeHours.end
                      ? { end: agent.heartbeat.activeHours.end }
                      : {}),
                    ...(agent.heartbeat.activeHours.timezone
                      ? { timezone: agent.heartbeat.activeHours.timezone }
                      : {}),
                  },
                }
              : {}),
            ...(agent.heartbeat.lightContext !== undefined
              ? { lightContext: agent.heartbeat.lightContext }
              : {}),
            ...(agent.heartbeat.isolatedSession !== undefined
              ? { isolatedSession: agent.heartbeat.isolatedSession }
              : {}),
            ...(agent.heartbeat.skipWhenBusy !== undefined
              ? { skipWhenBusy: agent.heartbeat.skipWhenBusy }
              : {}),
            ...(agent.heartbeat.timeoutSeconds !== undefined
              ? { timeoutSeconds: agent.heartbeat.timeoutSeconds }
              : {}),
          },
        }
      : {}),
    ...(agent.humanDelay
      ? {
          humanDelay: {
            ...(agent.humanDelay.mode ? { mode: agent.humanDelay.mode } : {}),
            ...(agent.humanDelay.minMs !== undefined ? { minMs: agent.humanDelay.minMs } : {}),
            ...(agent.humanDelay.maxMs !== undefined ? { maxMs: agent.humanDelay.maxMs } : {}),
          },
        }
      : {}),
  };
}

function normalizedRelativePath(value: string): string {
  return value.split(sep).join("/");
}

function readPortableAvatar(params: {
  config: OpenClawConfig;
  agent: AgentConfig;
  workspace: string;
}): { source?: string; sidecar?: { path: string; content: Buffer } } {
  const source = params.agent.identity?.avatar?.trim();
  if (!source) {
    return {};
  }
  if (isAvatarHttpUrl(source) || isAvatarDataUrl(source)) {
    return { source };
  }
  const opened = openLocalAgentAvatarFile({
    cfg: params.config,
    agentId: params.agent.id,
    source,
  });
  if (!opened.ok) {
    return {};
  }
  try {
    const content = readFileDescriptorBoundedSync(opened.file.fd, AVATAR_MAX_BYTES);
    const path = normalizedRelativePath(relative(params.workspace, opened.file.path));
    return { source: path, sidecar: { path, content } };
  } catch {
    return {};
  } finally {
    closeSync(opened.file.fd);
  }
}

function derivativePackageVersion(manifest: ClawManifest, contents: ExportContent[]): string {
  const hash = createHash("sha256").update(JSON.stringify(manifest));
  for (const file of contents.toSorted((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path).update("\0").update(file.content).update("\0");
  }
  return `0.0.0-export.${hash.digest("hex").slice(0, 12)}`;
}

type ExportContent = { path: string; content: Buffer };

export async function exportClawAgent(
  agentId: string,
  outputDirectory: string,
  options: OpenClawStateDatabaseOptions & { config: OpenClawConfig },
): Promise<ClawExportResult> {
  const status = await readClawStatus(agentId, options);
  const record = status.records.find((candidate) => candidate.install.agentId === agentId);
  if (!record) {
    throw new ClawExportError(
      "claw_not_found",
      `No installed Claw agent matches ${JSON.stringify(agentId)}.`,
    );
  }
  const agent = options.config.agents?.list?.find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new ClawExportError(
      "agent_missing",
      `Installed Claw agent ${JSON.stringify(agentId)} is missing from config.`,
    );
  }
  const unavailable = record.workspaceFiles.filter(
    (file) => file.state === "missing" || file.state === "unsafe",
  );
  if (unavailable.length > 0) {
    throw new ClawExportError(
      "workspace_files_unavailable",
      `Cannot export unavailable managed files: ${unavailable.map((file) => file.path).join(", ")}.`,
    );
  }

  const workspace = await fsSafeRoot(record.install.workspace, {
    hardlinks: "reject",
    maxBytes: MAX_EXPORT_FILE_BYTES,
    symlinks: "reject",
  });
  const contents: ExportContent[] = await Promise.all(
    record.workspaceFiles.map(async (file) => ({
      path: normalizedRelativePath(file.path),
      content: await workspace.readBytes(file.path, { maxBytes: MAX_EXPORT_FILE_BYTES }),
    })),
  );
  const avatar = readPortableAvatar({
    config: options.config,
    agent,
    workspace: record.install.workspace,
  });
  const managedPaths = new Set(contents.map((file) => file.path));
  if (avatar.sidecar && !managedPaths.has(avatar.sidecar.path)) {
    contents.push(avatar.sidecar);
  }
  const bootstrapFiles: ClawManifest["workspace"]["bootstrapFiles"] = {};
  const files: ClawManifest["workspace"]["files"] = [];
  for (const file of contents) {
    const source = `workspace/${file.path}`;
    if (CLAW_BOOTSTRAP_FILE_NAMES.includes(file.path as ClawBootstrapFileName)) {
      bootstrapFiles[file.path as ClawBootstrapFileName] = { source };
    } else {
      files.push({ source, path: file.path });
    }
  }
  const manifest: ClawManifest = {
    schemaVersion: CLAW_SCHEMA_VERSION,
    agent: portableAgent(agent, avatar.source),
    workspace: { bootstrapFiles, files },
    packages: record.packages
      .map((pkg) => ({ kind: pkg.kind, source: pkg.source, ref: pkg.ref, version: pkg.version }))
      .toSorted((left, right) =>
        `${left.kind}:${left.ref}`.localeCompare(`${right.kind}:${right.ref}`),
      ),
    mcpServers: {},
    cronJobs: [],
  };
  const parsed = parseClawManifest(manifest);
  if (!parsed.ok) {
    throw new ClawExportError(
      "export_manifest_invalid",
      parsed.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    );
  }

  const target = resolve(resolveUserPath(outputDirectory));
  await mkdir(dirname(target), { recursive: true });
  try {
    await mkdir(target);
  } catch (error) {
    throw new ClawExportError(
      "output_collision",
      `Export directory ${JSON.stringify(target)} must not already exist: ${(error as Error).message}`,
    );
  }
  const filesWritten: string[] = [];
  try {
    const output = await fsSafeRoot(target, {
      hardlinks: "reject",
      maxBytes: MAX_EXPORT_FILE_BYTES,
      symlinks: "reject",
    });
    for (const file of contents) {
      const path = `workspace/${file.path}`;
      await output.write(path, file.content, { mkdir: true, overwrite: false });
      filesWritten.push(path);
    }
    const exactRecordedState =
      record.install.status === "complete" &&
      record.agentState === "present" &&
      record.workspaceFiles.every((file) => file.state === "unchanged") &&
      record.packages.every((pkg) => pkg.status === "complete") &&
      (!agent.identity?.avatar?.trim() || Boolean(avatar.source)) &&
      (!avatar.sidecar || managedPaths.has(avatar.sidecar.path));
    const preservePackageName = exactRecordedState && record.install.claw.kind === "package";
    const packageJson = {
      name: preservePackageName
        ? record.install.claw.name
        : `openclaw-claw-${record.install.agentId}`,
      version: exactRecordedState
        ? record.install.claw.version
        : derivativePackageVersion(manifest, contents),
      type: "module",
      openclaw: { claw: "openclaw.claw.json" },
    };
    await output.write("package.json", Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`), {
      overwrite: false,
    });
    filesWritten.push("package.json");
    await output.write(
      "openclaw.claw.json",
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
      { overwrite: false },
    );
    filesWritten.push("openclaw.claw.json");
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw new ClawExportError(
      "export_write_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  return {
    schemaVersion: CLAW_EXPORT_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    agentId,
    outputDirectory: target,
    manifest,
    filesWritten,
  };
}
