// Stages inbound media into sandbox workspaces before agent execution.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { safeFileURLToPath } from "@openclaw/fs-safe/advanced";
import { isInboundPathAllowed } from "@openclaw/media-core/inbound-path-policy";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { assertSandboxPath } from "../../agents/sandbox-paths.js";
import { ensureSandboxWorkspaceForSession, resolveSandboxContext } from "../../agents/sandbox.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { slugifySessionKey } from "../../agents/sandbox/shared.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { root as fsRoot, FsSafeError, readLocalFileSafely } from "../../infra/fs-safe.js";
import { retryAsync } from "../../infra/retry.js";
import { normalizeScpRemoteHost, normalizeScpRemotePath } from "../../infra/scp-host.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { resolveChannelRemoteInboundAttachmentRoots } from "../../media/channel-inbound-roots.js";
import { normalizeMediaFacts } from "../../media/media-facts.js";
import {
  buildInboundMediaUriFromPath,
  resolveInboundMediaReference,
} from "../../media/media-reference.js";
import {
  STAGED_INPUT_MAX_BYTES,
  STAGED_INPUT_GITIGNORE,
  ensureStagedInputDirectory,
  stagedInputDirectory,
  stagedInputFileName,
} from "../../media/staged-inputs.js";
import { getMediaDir, saveMediaBuffer } from "../../media/store.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { CONFIG_DIR } from "../../utils.js";
import type { RuntimeMsgContext as MsgContext, TemplateContext } from "../templating.js";

/** Maximum size of one file copied into an agent sandbox or staging workspace. */
export const SANDBOX_MEDIA_MAX_BYTES = STAGED_INPUT_MAX_BYTES;
const SCP_STDERR_TAIL_CHARS = 16_384;

// Attachment indexes are the staging identity. Callers use this map to detect
// partial failures without matching rewritten strings back to source paths.
export type StageSandboxMediaResult = {
  staged: ReadonlyMap<number, string>;
};

const EMPTY_STAGE_RESULT: StageSandboxMediaResult = { staged: new Map() };

export async function stageSandboxMedia(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  workspaceDir: string;
  skillsSnapshot?: SkillSnapshot;
  remoteMediaMode?: "sandbox-or-cache" | "cache";
  abortSignal?: AbortSignal;
}): Promise<StageSandboxMediaResult> {
  const { ctx, sessionCtx, cfg, sessionKey, workspaceDir, abortSignal } = params;
  abortSignal?.throwIfAborted();
  const media = normalizeMediaFacts(ctx.media);
  const pathEntries = media.flatMap((fact, index) =>
    fact.path ? [{ index, path: fact.path }] : [],
  );
  if (pathEntries.length === 0 || !sessionKey) {
    if (pathEntries.length === 0 && media.length > 0) {
      console.warn(`Staging skipped: ${media.length} media fact(s) have no path`);
    }
    return EMPTY_STAGE_RESULT;
  }

  const remoteWorkspace = getAgentWorkspaceAccess(workspaceDir, "prepareTurnAttachments");
  if (remoteWorkspace?.prepareTurnAttachments && !ctx.MediaRemoteHost) {
    // Keep managed originals on Gateway; the admitted turn transfers them to the Harness.
    // This is an intentional handoff, not a failure — keep it at debug level.
    logVerbose("Inbound media staging skipped: remote workspace owns attachment preparation");
    return EMPTY_STAGE_RESULT;
  }
  const forceRemoteCache =
    ctx.MediaRemoteHost &&
    (remoteWorkspace?.prepareTurnAttachments || params.remoteMediaMode === "cache");
  const sandboxParams = {
    config: cfg,
    agentId: params.agentId,
    sessionKey,
    workspaceDir,
    skillsSnapshot: params.skillsSnapshot,
  };
  const sshSandbox =
    !forceRemoteCache &&
    resolveSandboxConfigForAgent(
      cfg,
      resolveSessionAgentId({ sessionKey, config: cfg, agentId: params.agentId }),
    ).backend === "ssh"
      ? await resolveSandboxContext(sandboxParams)
      : null;
  const sandbox = forceRemoteCache
    ? null
    : (sshSandbox ?? (await ensureSandboxWorkspaceForSession(sandboxParams)));
  const remoteBridge = sshSandbox?.fsBridge;
  if (sshSandbox && !remoteBridge) {
    throw new Error("SSH sandbox has no filesystem bridge for inbound media staging");
  }

  // For remote attachments without sandbox, use ~/.openclaw/media (not agent workspace for privacy).
  // Managed local inbound refs are already in OpenClaw's media store; when no sandbox is
  // active, copy them into the runner workspace so host-mode shell/doc readers get a path.
  const remoteMediaCacheDir = ctx.MediaRemoteHost
    ? path.join(CONFIG_DIR, "media", "remote-cache", slugifySessionKey(sessionKey))
    : null;
  const effectiveWorkspaceDir = sandbox?.workspaceDir ?? remoteMediaCacheDir ?? workspaceDir;
  if (!effectiveWorkspaceDir) {
    console.warn("Inbound media staging skipped: no workspace directory resolved");
    return EMPTY_STAGE_RESULT;
  }

  if (!remoteBridge) {
    await fs.mkdir(effectiveWorkspaceDir, { recursive: true });
  }
  const remoteAttachmentRoots = ctx.MediaRemoteHost
    ? (resolveChannelRemoteInboundAttachmentRoots({ cfg, ctx }) ?? [])
    : [];

  const usedNames = new Set<string>();
  const staged = new Map<number, string>();
  const stagedUrls = new Map<number, string>();
  const inputDirectory = stagedInputDirectory(crypto.randomUUID());
  let stagingReady = false;
  const prepareDestination = async () => {
    if (!stagingReady) {
      // Keep the privacy marker ahead of file publication, after source validation.
      if (remoteBridge) {
        if (!remoteBridge.createFileExclusive) {
          throw new Error("SSH sandbox filesystem does not support exclusive input staging");
        }
        abortSignal?.throwIfAborted();
        const created = await remoteBridge.createFileExclusive({
          filePath: `${inputDirectory}/.gitignore`,
          data: STAGED_INPUT_GITIGNORE,
          signal: abortSignal,
        });
        if (created !== "created") {
          throw new Error("Input staging directory is not owned by OpenClaw");
        }
      } else {
        await ensureStagedInputDirectory(effectiveWorkspaceDir, inputDirectory, abortSignal);
      }
      stagingReady = true;
    }
  };

  for (const entry of pathEntries) {
    abortSignal?.throwIfAborted();
    const source = await resolveStageableMediaSource(entry.path);
    if (!source) {
      console.warn(`Staging skipped for ${entry.path}: unable to resolve a stageable source`);
      continue;
    }
    const allowed = await isAllowedSourcePath({
      source,
      mediaRemoteHost: ctx.MediaRemoteHost,
      remoteAttachmentRoots,
    });
    if (!allowed) {
      console.warn(`Inbound media staging skipped for ${source}: source path is not allowed`);
      continue;
    }
    const fileName = allocateStagedFileName(source, usedNames);
    // Keep published relative paths portable; resolve the native destination below.
    const relativeDest = path.posix.join(inputDirectory, fileName);
    const dest = path.join(effectiveWorkspaceDir, relativeDest);
    let downloadedMediaUri: string | undefined;
    const stageSource = async (sourcePath: string) => {
      if (remoteBridge) {
        const { buffer } = await readLocalFileSafely({
          filePath: sourcePath,
          maxBytes: SANDBOX_MEDIA_MAX_BYTES,
        });
        abortSignal?.throwIfAborted();
        await prepareDestination();
        abortSignal?.throwIfAborted();
        if (!remoteBridge.createFileExclusive) {
          throw new Error("SSH sandbox filesystem does not support exclusive input staging");
        }
        const created = await remoteBridge.createFileExclusive({
          filePath: relativeDest,
          data: buffer,
          signal: abortSignal,
        });
        if (created !== "created") {
          throw new Error("Input staging file already exists");
        }
        if (ctx.MediaRemoteHost) {
          // The SCP temp copy is removed below; Gateway preprocessing and
          // history still need an original outside the remote-only workspace.
          const saved = await saveMediaBuffer(
            buffer,
            media[entry.index]?.contentType,
            "inbound",
            SANDBOX_MEDIA_MAX_BYTES,
            path.basename(source),
            undefined,
            { assertCommitAllowed: () => abortSignal?.throwIfAborted() },
          );
          downloadedMediaUri = buildInboundMediaUriFromPath(saved.path);
        }
      } else {
        const root = await fsRoot(effectiveWorkspaceDir);
        const { buffer } = await readLocalFileSafely({
          filePath: sourcePath,
          maxBytes: SANDBOX_MEDIA_MAX_BYTES,
        });
        // A completed read must not start a new copy after cancellation.
        abortSignal?.throwIfAborted();
        await prepareDestination();
        abortSignal?.throwIfAborted();
        await root.create(relativeDest, buffer);
      }
    };

    try {
      if (ctx.MediaRemoteHost) {
        await stageRemoteFileIntoRoot({
          remoteHost: ctx.MediaRemoteHost,
          remotePath: source,
          abortSignal,
          stageDownloadedFile: stageSource,
        });
      } else {
        const copySource = await fs.realpath(source).catch(() => source);
        await stageSource(copySource);
      }
    } catch (err) {
      if (abortSignal?.aborted && Object.is(err, abortSignal.reason)) {
        throw err;
      }
      if (err instanceof FsSafeError && err.code === "too-large") {
        console.warn(`Inbound media staging skipped for ${fileName}: ${err.message}`);
      } else {
        console.warn(`Failed to stage inbound media path ${source}: ${String(err)}`);
      }
      continue;
    }

    // For sandbox use relative path, for remote cache use absolute path
    const stagedPath = sandbox ? relativeDest : dest;
    staged.set(entry.index, stagedPath);
    const originalUrl = media[entry.index]?.url;
    const rewritesUrl = await isUrlAliasForStagedSource({
      url: originalUrl,
      sourcePath: entry.path,
      source,
      mediaRemoteHost: ctx.MediaRemoteHost,
    });
    // Keep the managed original fetchable after history redacts the runner's
    // private staged path. A remote host's path is not a local store reference.
    const inboundUri =
      downloadedMediaUri ??
      (!ctx.MediaRemoteHost && (!originalUrl || rewritesUrl)
        ? buildInboundMediaUriFromPath(source)
        : undefined);
    if (inboundUri || rewritesUrl) {
      stagedUrls.set(entry.index, inboundUri ?? stagedPath);
    }
  }

  // Path checks and alias resolution can finish after cancellation. Fence even
  // an empty result so callers cannot start the next preprocessing phase.
  abortSignal?.throwIfAborted();
  if (staged.size === 0) {
    return { staged };
  }

  const nextMedia = [...media];
  for (const [index, stagedPath] of staged) {
    const fact = nextMedia[index];
    if (fact) {
      nextMedia[index] = {
        ...fact,
        path: stagedPath,
        ...(stagedUrls.has(index) ? { url: stagedUrls.get(index) } : {}),
        workspaceDir: effectiveWorkspaceDir,
        staged: true,
      };
    }
  }
  ctx.media = nextMedia;
  if (sessionCtx !== ctx) {
    sessionCtx.media = nextMedia;
  }

  return { staged };
}

async function isUrlAliasForStagedSource(params: {
  url?: string;
  sourcePath: string;
  source: string;
  mediaRemoteHost?: string;
}): Promise<boolean> {
  const url = normalizeOptionalString(params.url);
  if (!url) {
    return false;
  }
  if (url === params.sourcePath) {
    return true;
  }
  const sourceAbsolutePath = resolveAbsolutePath(params.sourcePath);
  const urlAbsolutePath = resolveAbsolutePath(url);
  if (
    sourceAbsolutePath &&
    urlAbsolutePath &&
    path.normalize(sourceAbsolutePath) === path.normalize(urlAbsolutePath)
  ) {
    return true;
  }
  // Non-identical remote references belong to the remote host; resolving them
  // against local storage could rewrite an unrelated local file by accident.
  if (params.mediaRemoteHost) {
    return false;
  }
  const urlSource = await resolveStageableMediaSource(url);
  if (!urlSource) {
    return false;
  }
  const [sourceIdentity, urlIdentity] = await Promise.all([
    resolveLocalSourceIdentity(params.source),
    resolveLocalSourceIdentity(urlSource),
  ]);
  return sourceIdentity === urlIdentity;
}

async function resolveLocalSourceIdentity(sourcePath: string): Promise<string> {
  return await fs.realpath(sourcePath).catch(() => path.resolve(sourcePath));
}

async function resolveStageableMediaSource(value: string): Promise<string | null> {
  const raw = value.trim();
  if (!raw) {
    return null;
  }
  const inboundReference = await resolveInboundMediaReference(raw).catch(() => null);
  return inboundReference?.physicalPath ?? resolveAbsolutePath(raw);
}

async function stageRemoteFileIntoRoot(params: {
  remoteHost: string;
  remotePath: string;
  abortSignal?: AbortSignal;
  stageDownloadedFile: (sourcePath: string) => Promise<void>;
}): Promise<void> {
  const { abortSignal } = params;
  const safeRemoteHost = normalizeScpRemoteHost(params.remoteHost);
  if (!safeRemoteHost) {
    throw new Error("invalid remote host for SCP");
  }
  const safeRemotePath = normalizeScpRemotePath(params.remotePath);
  if (!safeRemotePath) {
    throw new Error("invalid remote path for SCP");
  }
  const tmpRoot = resolvePreferredOpenClawTmpDir();
  await fs.mkdir(tmpRoot, { recursive: true });
  const tmpDir = await fs.mkdtemp(path.join(tmpRoot, "stage-sandbox-media-"));
  const tmpPath = path.join(tmpDir, "download");
  try {
    await retryAsync(
      async () => {
        if (abortSignal?.aborted) {
          return;
        }
        const result = await runCommandWithTimeout(
          [
            "scp",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "--",
            `${safeRemoteHost}:${safeRemotePath}`,
            tmpPath,
          ],
          {
            // The runner owns both descendants and settlement before temp cleanup.
            signal: abortSignal,
            killProcessTree: true,
            // Four UTF-8 bytes retain the existing UTF-16 diagnostic tail bound.
            maxOutputBytes: { stdout: 1, stderr: SCP_STDERR_TAIL_CHARS * 4 },
          },
        );
        if (result.code !== 0) {
          // A late abort can coexist with a concrete failed exit; keep that error.
          if (result.code === null && result.termination === "signal" && abortSignal?.aborted) {
            return;
          }
          const stderr = sliceUtf16Safe(result.stderr, -SCP_STDERR_TAIL_CHARS).trim();
          throw new Error(`scp failed (${result.code}): ${stderr}`);
        }
      },
      { attempts: 3, label: "remote inbound media SCP", shouldRetry: () => !abortSignal?.aborted },
    );
    // Preserve arbitrary abort reasons outside retry's Error normalization.
    abortSignal?.throwIfAborted();
    await params.stageDownloadedFile(tmpPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function resolveAbsolutePath(value: string): string | null {
  let resolved = value.trim();
  if (!resolved) {
    return null;
  }
  if (/^file:/iu.test(resolved)) {
    try {
      resolved = safeFileURLToPath(resolved);
    } catch {
      return null;
    }
  }
  if (!path.isAbsolute(resolved)) {
    return null;
  }
  return resolved;
}

async function isAllowedSourcePath(params: {
  source: string;
  mediaRemoteHost?: string;
  remoteAttachmentRoots: readonly string[];
}): Promise<boolean> {
  if (params.mediaRemoteHost) {
    if (
      !isInboundPathAllowed({
        filePath: params.source,
        roots: params.remoteAttachmentRoots,
      })
    ) {
      logVerbose(`Blocking remote media staging from disallowed attachment path: ${params.source}`);
      return false;
    }
    return true;
  }
  const inboundReference = await resolveInboundMediaReference(params.source).catch(() => null);
  if (inboundReference) {
    return true;
  }
  const mediaDir = getMediaDir();
  const canonicalMediaDir = await fs.realpath(mediaDir).catch(() => mediaDir);
  if (
    !isInboundPathAllowed({
      filePath: params.source,
      roots: [mediaDir, canonicalMediaDir],
    })
  ) {
    logVerbose(`Blocking attempt to stage media from outside media directory: ${params.source}`);
    return false;
  }
  try {
    const canonicalSource = await fs.realpath(params.source).catch(() => params.source);
    await assertSandboxPath({
      filePath: canonicalSource,
      cwd: canonicalMediaDir,
      root: canonicalMediaDir,
    });
    return true;
  } catch {
    logVerbose(`Blocking attempt to stage media from outside media directory: ${params.source}`);
    return false;
  }
}

function allocateStagedFileName(source: string, usedNames: Set<string>): string {
  const baseName = stagedInputFileName(path.basename(source));
  const parsed = path.parse(baseName);
  let fileName = baseName;
  let suffix = 1;
  while (usedNames.has(fileName)) {
    fileName = `${parsed.name}-${suffix}${parsed.ext}`;
    suffix += 1;
  }
  usedNames.add(fileName);
  return fileName;
}
