import path from "node:path";
import { readFileWindowFully, safeFileURLToPath } from "@openclaw/fs-safe/advanced";
import { detectMime, kindFromMime } from "@openclaw/media-core/mime";
import { startsWithSvgRootElement } from "../../packages/gateway-protocol/src/svg-image.js";
import { relativePathInsideSandboxRoot, resolveSandboxPathMapping } from "../agents/path-policy.js";
import { openLocalFileSafely } from "../infra/fs-safe.js";
import { isPathInside } from "../infra/path-guards.js";
import { assertLocalMediaAllowed, LocalMediaAccessError } from "../media/local-media-access.js";
import { resolveMediaReferenceLocalPathInfo } from "../media/media-reference.js";
import { resolvePlaybackMetadataForSource } from "../media/playback-transcode.js";
import { resolveUserPath } from "../utils.js";
import {
  classifyAssistantMediaError,
  type AssistantMediaAvailability,
} from "./assistant-media-errors.js";
import {
  createAssistantMediaTicket,
  resolveAssistantMediaWorkspaceTicketKey,
  type resolveAssistantMediaPolicy,
  type AssistantMediaTicketPayload,
} from "./assistant-media-policy.js";

export function normalizeAssistantMediaSource(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) {
    return null;
  }
  if (/^file:/iu.test(trimmed)) {
    try {
      return safeFileURLToPath(trimmed);
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith("~")) {
    return resolveUserPath(trimmed);
  }
  return trimmed;
}

type AssistantMediaPolicy = NonNullable<Awaited<ReturnType<typeof resolveAssistantMediaPolicy>>>;
type AssistantMediaFile = NonNullable<AssistantMediaTicketPayload["file"]>;

/** Keep relative sandbox references in their namespace for reads, association and tickets. */
export function resolveAssistantMediaSource(
  source: string,
  policy: AssistantMediaPolicy,
): string | null {
  if (path.isAbsolute(source) || /^[a-z][a-z0-9+.-]*:/iu.test(source)) {
    return source;
  }
  if (policy.remote || !policy.executionCwd || !path.isAbsolute(policy.executionCwd)) {
    return null;
  }
  const resolved = path.resolve(policy.executionCwd, source);
  const sandbox = policy.sandboxWorkspace;
  if (!sandbox) {
    return resolved;
  }
  const relative = relativePathInsideSandboxRoot(sandbox.hostRoot, resolved);
  return relative === null
    ? null
    : path.posix.join(sandbox.containerRoot, ...relative.split(path.sep));
}

function sameAssistantMediaFile(actual: AssistantMediaFile, expected: AssistantMediaFile) {
  return (
    actual.realPath === expected.realPath &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino
  );
}

export async function openAssistantMedia(
  source: string,
  policy: AssistantMediaPolicy,
  allowance: true | AssistantMediaFile | undefined,
  assertCurrent: () => void,
) {
  const sandbox = policy.sandboxWorkspace;
  const mapped = !policy.remote && sandbox ? resolveSandboxPathMapping([sandbox], source) : null;
  const reference = await resolveMediaReferenceLocalPathInfo(mapped?.hostPath ?? source);
  let workspaceDir = sandbox?.hostRoot;
  if (policy.remote && reference.kind === "local") {
    throw new LocalMediaAccessError("invalid-path", "File is on another computer");
  }
  if (sandbox && reference.kind === "local" && isPathInside(sandbox.hostRoot, reference.path)) {
    const { withSettledLocalWorkspacePath } =
      await import("./worker-environments/local-workspace-projection.js");
    assertCurrent();
    workspaceDir = await withSettledLocalWorkspacePath(
      { cwd: sandbox.hostRoot, assertCurrent },
      async (custody) => {
        if (mapped && custody?.worktreeId !== sandbox.worktreeId) {
          throw new LocalMediaAccessError("invalid-path", "Sandbox image backing is unavailable");
        }
        return custody?.projectionPath ?? sandbox.hostRoot;
      },
    );
    assertCurrent();
  }
  let outsideRoots = false;
  try {
    await assertLocalMediaAllowed(reference.path, policy.localRoots);
  } catch (error) {
    if (!(error instanceof LocalMediaAccessError) || error.code !== "path-not-allowed") {
      throw error;
    }
    outsideRoots = true;
    if (policy.workspaceOnly && !allowance) {
      throw error;
    }
  }
  const opened = await openLocalFileSafely({ filePath: reference.path });
  try {
    let assertSourceCurrent = assertCurrent;
    if (mapped && sandbox && workspaceDir) {
      if (!isPathInside(sandbox.hostRoot, opened.realPath)) {
        throw new LocalMediaAccessError("invalid-path", "Sandbox image backing is unavailable");
      }
      const { prepareLocalWorkspaceImageRead } =
        await import("../agents/sandbox/local-workspace-quiescence.js");
      assertSourceCurrent = await prepareLocalWorkspaceImageRead({
        workspaceDir,
        containerRoot: sandbox.containerRoot,
        targets: [
          source,
          path.posix.join(
            sandbox.containerRoot,
            ...path.relative(sandbox.hostRoot, opened.realPath).split(path.sep),
          ),
        ],
        assertCurrent,
      });
    }
    let file: AssistantMediaFile | undefined;
    if (outsideRoots && allowance) {
      const identity = await opened.handle.stat({ bigint: true });
      const candidate = {
        realPath: opened.realPath,
        dev: identity.dev.toString(),
        ino: identity.ino.toString(),
      };
      if (allowance === true || sameAssistantMediaFile(candidate, allowance)) {
        file = candidate;
      } else if (policy.workspaceOnly) {
        // Replacing an allowed image loses the grant; offer the same explicit choice again.
        throw new LocalMediaAccessError("path-not-allowed", "Outside allowed folders");
      }
    }
    // Validate the descriptor target too: a symlink may change between containment and open.
    if (!outsideRoots) {
      await assertLocalMediaAllowed(opened.realPath, policy.localRoots);
    }
    const sniffBuffer = Buffer.alloc(Math.min(opened.stat.size, 8192));
    const bytesRead = sniffBuffer.length
      ? await readFileWindowFully(opened.handle, sniffBuffer, 0)
      : 0;
    const buffer = sniffBuffer.subarray(0, bytesRead);
    const mimeType = startsWithSvgRootElement(buffer.toString("utf8"))
      ? "image/svg+xml"
      : await detectMime({ buffer, ...(outsideRoots ? {} : { filePath: reference.path }) });
    // Host-wide reads authorize actual image bytes, never a filename's extension.
    if (outsideRoots && kindFromMime(mimeType) !== "image") {
      throw new LocalMediaAccessError("unsupported-media-type", "Not an image");
    }
    assertSourceCurrent();
    return { opened, reference, mimeType, outsideRoots, file, assertSourceCurrent };
  } catch (error) {
    await opened.handle.close().catch(() => {});
    throw error;
  }
}

export async function resolveAssistantMediaAvailability(
  source: string,
  policy: AssistantMediaPolicy,
  allowance: true | AssistantMediaFile | undefined,
  agentId: string | undefined,
  signal: AbortSignal,
  assertCurrent: () => void,
): Promise<
  AssistantMediaAvailability & {
    mediaTicket?: string;
    mediaTicketExpiresAt?: string;
    assertSourceCurrent?: () => void;
  }
> {
  try {
    assertCurrent();
    const { opened, mimeType, file, assertSourceCurrent } = await openAssistantMedia(
      source,
      policy,
      allowance,
      assertCurrent,
    );
    // The inspection owner reopens and verifies this identity after queue admission.
    await opened[Symbol.asyncDispose]();
    const mediaKind = kindFromMime(mimeType);
    const playbackMetadata =
      mimeType && (mediaKind === "audio" || mediaKind === "video")
        ? await resolvePlaybackMetadataForSource({
            sourcePath: opened.realPath,
            sourceStat: {
              size: opened.stat.size,
              mtimeMs: opened.stat.mtimeMs,
              ctimeMs: opened.stat.ctimeMs,
              exactIdentity: opened.exactIdentity,
            },
            mimeType,
            kind: mediaKind,
            signal,
            assertCurrent: assertSourceCurrent,
          })
        : undefined;
    assertSourceCurrent();
    return {
      available: true,
      assertSourceCurrent,
      ...(mimeType ? { mimeType } : {}),
      sizeBytes: opened.stat.size,
      ...playbackMetadata,
      ...createAssistantMediaTicket({
        source,
        workspaceKey: resolveAssistantMediaWorkspaceTicketKey(source, policy),
        agentId,
        session: policy.session,
        ...(policy.messageId ? { messageId: policy.messageId } : {}),
        reader: policy.reader,
        ...(file ? { file } : {}),
      }),
    };
  } catch (error) {
    return classifyAssistantMediaError(error);
  }
}
