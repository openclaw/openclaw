import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox/context.js";
import {
  stageSandboxMedia,
  type StageSandboxMediaResult,
} from "../../auto-reply/reply/stage-sandbox-media.js";
import type { MsgContext, TemplateContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { parseInboundMediaUri } from "../../media/media-reference.js";
import { deleteMediaBuffer, MEDIA_MAX_BYTES } from "../../media/store.js";
import {
  MediaOffloadError,
  type OffloadedRef,
  UnsupportedAttachmentError,
} from "../chat-attachments.js";

function isPdfOffloadedRef(ref: OffloadedRef): boolean {
  const mime = ref.mimeType.trim().toLowerCase();
  if (mime === "application/pdf" || mime.endsWith("+pdf")) {
    return true;
  }
  return path.extname(ref.path.split(/[?#]/u)[0] ?? "").toLowerCase() === ".pdf";
}

// Managed inbound PDFs remain host-readable through media-understanding, so
// sandbox staging may safely fall back to their managed media-store paths.
function isManagedInboundPdfOffloadRef(ref: OffloadedRef): boolean {
  if (!isPdfOffloadedRef(ref)) {
    return false;
  }
  try {
    return parseInboundMediaUri(ref.mediaRef) !== null;
  } catch {
    return false;
  }
}

function shouldPassThroughManagedInboundPdfOffloadRef(ref: OffloadedRef): boolean {
  return ref.sizeBytes > MEDIA_MAX_BYTES && isManagedInboundPdfOffloadRef(ref);
}

/**
 * Stages media-path offloads before chat.send responds so staging failures
 * remain synchronous. Callers must retain cleanup until dispatch consumption
 * finishes and set ctx.MediaStaged to prevent a duplicate staging pass.
 */
export async function prestageMediaPathOffloads(params: {
  offloadedRefs: OffloadedRef[];
  includeImageRefs?: boolean;
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
}): Promise<{
  paths: string[];
  types: string[];
  workspaceDir?: string;
  cleanup?: StageSandboxMediaResult["cleanup"];
}> {
  const mediaPathRefs = params.offloadedRefs.filter(
    (ref) => params.includeImageRefs || !ref.mimeType.startsWith("image/"),
  );
  if (mediaPathRefs.length === 0) {
    return { paths: [], types: [] };
  }
  const refsByManagedPath = (refs: OffloadedRef[]) => ({
    paths: refs.map((ref) => ref.path),
    types: refs.map((ref) => ref.mimeType),
  });

  const passThroughRefs: OffloadedRef[] = [];
  const refsToStage: OffloadedRef[] = [];
  for (const ref of mediaPathRefs) {
    (shouldPassThroughManagedInboundPdfOffloadRef(ref) ? passThroughRefs : refsToStage).push(ref);
  }
  if (refsToStage.length === 0) {
    return refsByManagedPath(mediaPathRefs);
  }

  let cleanup: StageSandboxMediaResult["cleanup"] | undefined;
  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const sandbox = await ensureSandboxWorkspaceForSession({
      config: params.cfg,
      sessionKey: params.sessionKey,
      workspaceDir,
    });
    if (!sandbox) {
      return refsByManagedPath(mediaPathRefs);
    }

    // The RPC parse cap is larger than the sandbox staging cap. Managed PDFs
    // can pass through host-side; other oversized files are client errors.
    const oversizedForSandbox = refsToStage.filter((ref) => ref.sizeBytes > MEDIA_MAX_BYTES);
    if (oversizedForSandbox.length > 0) {
      const details = oversizedForSandbox
        .map((ref) => `${ref.label} (${ref.sizeBytes} bytes)`)
        .join(", ");
      throw new UnsupportedAttachmentError(
        "non-image-too-large-for-sandbox",
        `attachments exceed sandbox staging limit (${MEDIA_MAX_BYTES} bytes): ${details}`,
      );
    }

    const stagingCtx: MsgContext = {
      MediaPath: expectDefined(refsToStage[0], "refs to stage entry at 0").path,
      MediaPaths: refsToStage.map((ref) => ref.path),
      MediaType: expectDefined(refsToStage[0], "refs to stage entry at 0").mimeType,
      MediaTypes: refsToStage.map((ref) => ref.mimeType),
    };
    let stageResult: StageSandboxMediaResult;
    try {
      stageResult = await stageSandboxMedia({
        ctx: stagingCtx,
        sessionCtx: stagingCtx as TemplateContext,
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        workspaceDir,
      });
      cleanup = stageResult.cleanup;
    } catch (stageErr) {
      // Already-managed PDFs remain readable host-side after staging fails.
      if (refsToStage.some((ref) => !isManagedInboundPdfOffloadRef(ref))) {
        throw stageErr;
      }
      return refsByManagedPath(mediaPathRefs);
    }

    const stagedSources = stageResult.staged;
    const missing = refsToStage.filter((ref) => !stagedSources.has(ref.path));
    const unstageable = missing.filter((ref) => !isManagedInboundPdfOffloadRef(ref));
    if (unstageable.length > 0) {
      throw new Error(
        `attachment staging incomplete: ${stagedSources.size}/${refsToStage.length} paths staged into sandbox workspace (missing: ${unstageable.map((ref) => ref.path).join(", ")})`,
      );
    }
    const stagedPaths = stagingCtx.MediaPaths ?? [];
    const stagedTypes = stagingCtx.MediaTypes ?? refsToStage.map((ref) => ref.mimeType);
    const resolvedByRef = new Map<OffloadedRef, { path: string; mimeType: string }>();
    refsToStage.forEach((ref, index) => {
      resolvedByRef.set(ref, {
        path: stagedPaths[index] ?? ref.path,
        mimeType: stagedTypes[index] ?? ref.mimeType,
      });
    });
    for (const ref of passThroughRefs) {
      resolvedByRef.set(ref, { path: ref.path, mimeType: ref.mimeType });
    }
    const ordered = mediaPathRefs.map(
      (ref) => resolvedByRef.get(ref) ?? { path: ref.path, mimeType: ref.mimeType },
    );
    return {
      paths: ordered.map((entry) => entry.path),
      types: ordered.map((entry) => entry.mimeType),
      workspaceDir: sandbox.workspaceDir,
      cleanup,
    };
  } catch (err) {
    await cleanup?.();
    await Promise.allSettled(
      params.offloadedRefs.map((ref) => deleteMediaBuffer(ref.id, "inbound")),
    );
    if (err instanceof MediaOffloadError) {
      throw err;
    }
    if (err instanceof UnsupportedAttachmentError) {
      throw err;
    }
    throw new MediaOffloadError(
      `[Gateway Error] Failed to stage attachments into agent workspace: ${formatErrorMessage(err)}`,
      { cause: err },
    );
  }
}
