import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { safeFileURLToPath } from "@openclaw/fs-safe/advanced";
import { isInboundPathAllowed } from "@openclaw/media-core/inbound-path-policy";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { assertSandboxPath } from "../../agents/sandbox-paths.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import {
  prepareSandboxWorkspaceForSession,
  resolveSandboxContext,
} from "../../agents/sandbox/context.js";
import { slugifySessionKey } from "../../agents/sandbox/shared.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { isAbortError } from "../../infra/abort-signal.js";
import {
  root as fsRoot,
  FsSafeError,
  openLocalFileSafely,
  readLocalFileSafely,
} from "../../infra/fs-safe.js";
import { retryAsync } from "../../infra/retry.js";
import { normalizeScpRemoteHost, normalizeScpRemotePath } from "../../infra/scp-host.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { resolveChannelRemoteInboundAttachmentRoots } from "../../media/channel-inbound-roots.js";
import { resolveStagedInputMaxBytes } from "../../media/configured-max-bytes.js";
import { buildInboundMediaUriFromPath } from "../../media/inbound-media-path.js";
import { normalizeMediaFacts } from "../../media/media-facts.js";
import { parseInboundMediaUri, resolveInboundMediaReference } from "../../media/media-reference.js";
import {
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

const SCP_STDERR_TAIL_CHARS = 16_384;

// Attachment indexes are the staging identity. Callers use this map to detect
// partial failures without matching rewritten strings back to source paths.
export type StageSandboxMediaResult = {
  staged: ReadonlyMap<number, string>;
};

const EMPTY_STAGE_RESULT: StageSandboxMediaResult = { staged: new Map() };

type StageSandboxMediaParams = {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  workspaceDir: string;
  skillsSnapshot?: SkillSnapshot;
  /** Borrowed from the caller, which retains and disposes its live workspace ownership. */
  preparedWorkspace?: NonNullable<Awaited<ReturnType<typeof prepareSandboxWorkspaceForSession>>>;
  remoteMediaMode?: "sandbox-or-cache" | "cache";
  abortSignal?: AbortSignal;
  assertCurrent?: () => void;
  awaitSessionDiffBaseline?: () => Promise<void>;
};

function isManagedInboundMedia(fact: { url?: string }): boolean {
  try {
    return Boolean(fact.url && parseInboundMediaUri(fact.url));
  } catch {
    return false;
  }
}

function isManagedInboundPdf(fact: { url?: string; contentType?: string }): boolean {
  const mime = fact.contentType?.trim().toLowerCase();
  return (
    isManagedInboundMedia(fact) &&
    (mime === "application/pdf" ||
      mime?.endsWith("+pdf") === true ||
      path.extname(fact.url!.split(/[?#]/u)[0] ?? "").toLowerCase() === ".pdf")
  );
}

export async function stageSandboxMedia(
  params: StageSandboxMediaParams,
): Promise<StageSandboxMediaResult> {
  try {
    return await stageSandboxMediaIntoWorkspace(params);
  } catch (error) {
    if (isAbortError(error) && !params.abortSignal?.aborted) {
      throw new Error(
        "Attachment workspace preparation was interrupted. Retry the message; if it persists, ask the gateway operator to check the workspace.",
        { cause: error },
      );
    }
    throw error;
  }
}

async function stageSandboxMediaIntoWorkspace(
  params: StageSandboxMediaParams,
): Promise<StageSandboxMediaResult> {
  const { ctx, sessionCtx, cfg, sessionKey, workspaceDir, abortSignal } = params;
  const assertInputCurrent = () => {
    abortSignal?.throwIfAborted();
    params.assertCurrent?.();
  };
  const stagingMaxBytes = resolveStagedInputMaxBytes(
    cfg,
    ctx.Surface ?? ctx.Provider,
    ctx.AccountId,
  );
  assertInputCurrent();
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
    return EMPTY_STAGE_RESULT;
  }
  const forceRemoteCache =
    ctx.MediaRemoteHost &&
    (remoteWorkspace?.prepareTurnAttachments || params.remoteMediaMode === "cache");
  await params.awaitSessionDiffBaseline?.();
  assertInputCurrent();
  const sandboxParams = {
    config: cfg,
    agentId: params.agentId,
    sessionKey,
    workspaceDir,
    skillsSnapshot: params.skillsSnapshot,
    abortSignal,
    assertCurrent: assertInputCurrent,
  };
  const sshSandbox =
    !forceRemoteCache &&
    resolveSandboxConfigForAgent(
      cfg,
      resolveSessionAgentId({ sessionKey, config: cfg, agentId: params.agentId }),
    ).backend === "ssh"
      ? await resolveSandboxContext(sandboxParams)
      : null;
  using sandboxLifetime = { [Symbol.dispose]: () => sshSandbox?.[Symbol.dispose]?.() };
  void sandboxLifetime;
  using ownedWorkspace =
    params.preparedWorkspace || forceRemoteCache || sshSandbox
      ? null
      : await prepareSandboxWorkspaceForSession(sandboxParams);
  const preparedWorkspace = params.preparedWorkspace ?? ownedWorkspace;
  const sandbox = sshSandbox ?? preparedWorkspace?.workspace;
  const assertCurrent = () => {
    assertInputCurrent();
    preparedWorkspace?.assertCurrent();
  };
  assertCurrent();
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

  if (!sandbox) {
    assertCurrent();
    await fs.mkdir(effectiveWorkspaceDir, { recursive: true });
  }
  const destination = remoteBridge
    ? { bridge: remoteBridge }
    : { root: await fsRoot(effectiveWorkspaceDir, { assertBeforeMutation: assertCurrent }) };
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
      if (destination.bridge) {
        if (!destination.bridge.createFileExclusive) {
          throw new Error("SSH sandbox filesystem does not support exclusive input staging");
        }
        assertCurrent();
        const created = await destination.bridge.createFileExclusive({
          filePath: `${inputDirectory}/.gitignore`,
          data: STAGED_INPUT_GITIGNORE,
          signal: abortSignal,
        });
        if (created !== "created") {
          throw new Error("Input staging directory is not owned by OpenClaw");
        }
      } else {
        await ensureStagedInputDirectory(destination.root, inputDirectory, abortSignal);
      }
      stagingReady = true;
    }
  };

  for (const entry of pathEntries) {
    assertCurrent();
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
      if (!destination.bridge) {
        // Validate before publishing the privacy marker; copyIn rechecks while copying.
        let clone: "auto" | "never";
        {
          await using opened = await openLocalFileSafely({ filePath: sourcePath });
          if (opened.stat.size > stagingMaxBytes) {
            throw new FsSafeError(
              "too-large",
              `file exceeds limit of ${stagingMaxBytes} bytes (got ${opened.stat.size})`,
            );
          }
          // Small inputs cost less to copy; reserve clone setup for bulk transfers.
          clone = opened.stat.size >= 32 * 1024 * 1024 ? "auto" : "never";
        }
        await prepareDestination();
        await destination.root.copyIn(relativeDest, sourcePath, {
          clone,
          maxBytes: stagingMaxBytes,
          mkdir: false,
          overwrite: false,
          signal: abortSignal,
        });
        return;
      }
      const { buffer } = await readLocalFileSafely({
        filePath: sourcePath,
        maxBytes: stagingMaxBytes,
      });
      // A completed read must not start a new copy after cancellation.
      assertCurrent();
      await prepareDestination();
      assertCurrent();
      if (!destination.bridge.createFileExclusive) {
        throw new Error("SSH sandbox filesystem does not support exclusive input staging");
      }
      const created = await destination.bridge.createFileExclusive({
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
          stagingMaxBytes,
          path.basename(source),
          undefined,
          { assertCommitAllowed: () => abortSignal?.throwIfAborted() },
        );
        downloadedMediaUri = buildInboundMediaUriFromPath(saved.path);
      }
    };

    try {
      if (ctx.MediaRemoteHost) {
        const safeRemoteHost = normalizeScpRemoteHost(ctx.MediaRemoteHost);
        if (!safeRemoteHost) {
          throw new Error("invalid remote host for SCP");
        }
        const safeRemotePath = normalizeScpRemotePath(source);
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
                if (
                  result.code === null &&
                  result.termination === "signal" &&
                  abortSignal?.aborted
                ) {
                  return;
                }
                const stderr = sliceUtf16Safe(result.stderr, -SCP_STDERR_TAIL_CHARS).trim();
                throw new Error(`scp failed (${result.code}): ${stderr}`);
              }
            },
            {
              attempts: 3,
              label: "remote inbound media SCP",
              shouldRetry: () => !abortSignal?.aborted,
            },
          );
          // Preserve arbitrary abort reasons outside retry's Error normalization.
          assertCurrent();
          await stageSource(tmpPath);
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
      } else {
        const copySource = await fs.realpath(source).catch(() => source);
        await stageSource(copySource);
      }
    } catch (err) {
      if (abortSignal?.aborted && err === abortSignal.reason) {
        throw err;
      }
      if (err instanceof FsSafeError && err.code === "too-large") {
        console.warn(`Inbound media staging skipped for ${fileName}: ${err.message}`);
      } else {
        console.warn(`Failed to stage inbound media path ${source}: ${String(err)}`);
      }
      assertCurrent();
      continue;
    }

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
  assertCurrent();
  if (
    !ctx.MediaRemoteHost &&
    pathEntries.some(
      ({ index }) =>
        isManagedInboundMedia(media[index]!) &&
        !isManagedInboundPdf(media[index]!) &&
        !staged.has(index),
    )
  ) {
    throw new Error(
      "Failed to prepare attachments in the agent workspace. Retry the message; if it persists, ask the gateway operator to check the workspace.",
    );
  }
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
  const [sourceIdentity, urlIdentity] = await Promise.all(
    [params.source, urlSource].map((source) =>
      fs.realpath(source).catch(() => path.resolve(source)),
    ),
  );
  return sourceIdentity === urlIdentity;
}

async function resolveStageableMediaSource(value: string): Promise<string | null> {
  const raw = value.trim();
  if (!raw) {
    return null;
  }
  const inboundReference = await resolveInboundMediaReference(raw).catch(() => null);
  return inboundReference?.physicalPath ?? resolveAbsolutePath(raw);
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
