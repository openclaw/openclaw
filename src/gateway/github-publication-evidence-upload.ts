import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import type { SessionGitHubActionResult } from "../../packages/gateway-protocol/src/index.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import { readResponseWithLimit } from "../plugin-sdk/response-limit-runtime.js";
import { fetchWithSsrFGuard } from "../plugin-sdk/ssrf-runtime.js";
import {
  githubPublicationApiArgs,
  runGitHubPublicationCommand as runPublicationCommand,
} from "./github-publication-remote.js";
import type { RepositoryPublicationActionInput } from "./repository-publication-contract.js";

/** Upload only the inspected workspace bytes granted by the native publication owner. */
export async function uploadGitHubPublicationEvidence(params: {
  repository: string;
  identity: PreparedGitHubPublicationIdentity;
  signal?: AbortSignal;
  assertCurrent: () => void;
  prepareEffect: () => Promise<void>;
  readEvidence: RepositoryPublicationActionInput["readEvidence"];
}): Promise<NonNullable<SessionGitHubActionResult["evidence"]>> {
  const { identity } = params;
  params.assertCurrent();
  if ((identity.host ?? "github.com") !== "github.com") {
    throw new Error(
      "Evidence attachments are supported only for the current GitHub.com publisher.",
    );
  }
  const media = await params.readEvidence();
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
    name: media.filename,
    content_type: media.mimeType,
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
      void transfer.response.body?.cancel().catch(() => undefined);
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
      sha256: media.sha256,
      sizeBytes: media.sizeBytes,
      mimeType: media.mimeType,
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
