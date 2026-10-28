import { createHash } from "node:crypto";
import path from "node:path";
import { detectMime } from "@openclaw/media-core/mime";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import {
  GITHUB_PUBLICATION_EVIDENCE_MAX_BYTES,
  type GitHubPublicationEvidence,
  type SessionGitHubActionResult,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import { resolveSandboxedBridgeMediaPath } from "../agents/sandbox-media-paths.js";
import { canUploadGitHubPublicationEvidence } from "../agents/sandbox/github-publication.js";
import type { SandboxContext } from "../agents/sandbox/types.js";
import { cancelUnreadResponseBody, readResponseWithLimit } from "../infra/http-response-body.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import {
  githubPublicationApiArgs,
  runPublicationCommand,
} from "./github-publication-git-transport.js";

const MEDIA_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
]);

/** Transfer only the inspected bytes from the invoking sandbox to its recorded PR repository. */
export async function uploadGitHubPublicationEvidence(params: {
  evidence: GitHubPublicationEvidence;
  sandbox: SandboxContext | undefined;
  sessionKey: string;
  repository: string;
  identity: PreparedGitHubPublicationIdentity;
  signal?: AbortSignal;
  assertCurrent: () => void;
  prepareEffect: () => Promise<void>;
}): Promise<NonNullable<SessionGitHubActionResult["evidence"]>> {
  const { evidence, sandbox, identity } = params;
  params.assertCurrent();
  if (!canUploadGitHubPublicationEvidence(sandbox) || sandbox.sessionKey !== params.sessionKey) {
    throw new Error(
      "upload_evidence needs this conversation's active sandbox workspace; it is not offered to sessions that run directly on the host.",
    );
  }
  if ((identity.host ?? "github.com") !== "github.com") {
    throw new Error(
      "Evidence attachments are supported only for the current GitHub.com publisher.",
    );
  }
  if (
    !evidence.path ||
    evidence.path.startsWith("~") ||
    /[\\:]/u.test(evidence.path) ||
    containsAsciiControlCharacter(evidence.path) ||
    evidence.path.split("/").some((part) => !part || part === "." || part === "..") ||
    !/^[a-f0-9]{64}$/u.test(evidence.sha256) ||
    !Number.isSafeInteger(evidence.sizeBytes) ||
    evidence.sizeBytes < 1 ||
    evidence.sizeBytes > GITHUB_PUBLICATION_EVIDENCE_MAX_BYTES
  ) {
    throw new Error(
      "Evidence requires a workspace-relative path, inspected SHA-256 and byte count up to 10 MB.",
    );
  }
  const filename = path.posix.basename(evidence.path);
  const mimeType = MEDIA_TYPES.get(path.posix.extname(filename).toLowerCase());
  if (!mimeType) {
    throw new Error("Evidence must be a PNG, JPEG, GIF, WebP, MP4, MOV or WebM image/video.");
  }
  let media: Awaited<ReturnType<typeof sandbox.fsBridge.readFileWithSource>>;
  try {
    const selected = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: sandbox.workspaceDir, bridge: sandbox.fsBridge, workspaceOnly: true },
      mediaPath: evidence.path,
    });
    params.assertCurrent();
    media = await sandbox.fsBridge.readFileWithSource({
      filePath: selected.resolved,
      cwd: sandbox.workspaceDir,
      maxBytes: evidence.sizeBytes,
      signal: params.signal,
    });
  } catch (error) {
    params.assertCurrent();
    // Filesystem diagnostics may name private host paths; only the cause retains them.
    throw new Error(
      "Evidence could not be read from this conversation's workspace; no upload was attempted.",
      { cause: error },
    );
  }
  params.assertCurrent();
  // The bridge pins this provenance to the read itself, including remote mounts and aliases.
  if (media.workspaceRelativePath === undefined) {
    throw new Error("Evidence must belong to this conversation's workspace, not another mount.");
  }
  if (
    media.data.length !== evidence.sizeBytes ||
    createHash("sha256").update(media.data).digest("hex") !== evidence.sha256
  ) {
    throw new Error("Evidence bytes changed since inspection; no upload was attempted.");
  }
  if ((await detectMime({ buffer: media.data })) !== mimeType) {
    throw new Error(
      "Evidence bytes do not match the image/video filename; no upload was attempted.",
    );
  }
  params.assertCurrent();
  const repository = await runPublicationCommand(
    [...githubPublicationApiArgs(`repos/${params.repository}`, "GET", "github.com"), "--jq", ".id"],
    { env: identity.env, beforeRun: params.assertCurrent },
  );
  params.assertCurrent();
  const repositoryId = repository.stdout.toString("utf8").trim();
  if (repository.code !== 0 || !/^[1-9][0-9]*$/u.test(repositoryId)) {
    throw new Error("The published PR repository could not be verified; no upload was attempted.");
  }
  const token = identity.env.GH_TOKEN;
  if (!token || containsAsciiControlCharacter(token) || /\s/u.test(token)) {
    throw new Error("The selected publisher has no usable credential; no upload was attempted.");
  }
  // Re-read the same publication and PR after media/transport preparation, before any write.
  await params.prepareEffect();
  params.assertCurrent();
  const url = new URL("https://uploads.github.com/user-attachments/assets");
  url.search = new URLSearchParams({
    name: filename,
    content_type: mimeType,
    repository_id: repositoryId,
  }).toString();
  let dispatched = false;
  let release: (() => Promise<void>) | undefined;
  try {
    const transfer = await fetchWithSsrFGuard({
      url: url.href,
      maxRedirects: 0,
      requireHttps: true,
      capture: false,
      timeoutMs: 60_000,
      signal: params.signal,
      beforeRequest: () => {
        params.assertCurrent();
        dispatched = true;
      },
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/octet-stream",
          Authorization: `Bearer ${token}`,
        },
        body: new Uint8Array(media.data),
      },
    });
    release = transfer.release;
    params.assertCurrent();
    if (transfer.response.status !== 200 && transfer.response.status !== 201) {
      await cancelUnreadResponseBody(transfer.response);
      throw new Error("Upload was not confirmed.");
    }
    const result: unknown = JSON.parse(
      (await readResponseWithLimit(transfer.response, 16 * 1024)).toString("utf8"),
    );
    params.assertCurrent();
    if (
      !isRecord(result) ||
      typeof result.url !== "string" ||
      !/^https:\/\/github\.com\/user-attachments\/assets\/[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u.test(
        result.url,
      )
    ) {
      throw new Error("Upload returned no safe attachment reference.");
    }
    return {
      status: "uploaded",
      url: result.url,
      sha256: evidence.sha256,
      sizeBytes: evidence.sizeBytes,
      mimeType,
      publicAccess: "unverified",
    };
  } catch {
    try {
      params.assertCurrent();
    } catch (error) {
      if (!dispatched) {
        throw error;
      }
      throw new Error(
        "Upload authority changed after the request started. GitHub may have created the attachment; reconcile the original upload before retrying.",
        { cause: error },
      );
    }
    if (!dispatched) {
      throw new Error("Evidence transport could not start; no upload was attempted.");
    }
    // No retry: a rejected, interrupted or malformed response can follow an accepted write.
    return {
      status: "unconfirmed",
      message:
        "GitHub has not confirmed the attachment. It may have been created; do not repeat the upload automatically. Reconcile the original upload before retrying.",
    };
  } finally {
    await release?.();
  }
}
