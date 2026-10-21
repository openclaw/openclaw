import { readFile } from "node:fs/promises";
import type {
  ClawDraftReviewChoices,
  ClawsDraftsPublishResult,
  ClawsDraftsReviewResult,
} from "../../packages/gateway-protocol/src/index.js";
import {
  fetchClawHubJson,
  resolveClawHubAuthToken,
  resolveClawHubBaseUrl,
  type ClawHubFetchOptions,
} from "../infra/clawhub-client.js";
import { clawDraftRevision, prepareClawDraft } from "./draft.js";
import { ClawProjectError } from "./project.js";

type DraftTarget = { workspaceDir: string; draftId: string; choices?: ClawDraftReviewChoices };

async function personalPublisher(options: ClawHubFetchOptions) {
  const token = options.token ?? (await resolveClawHubAuthToken());
  if (!token) {
    throw new ClawProjectError(
      "clawhub_login_required",
      "Sign in with `clawhub login` on this Gateway before publishing under your personal ClawHub identity.",
    );
  }
  // Capture the same credential and registry for identity, review, and publication.
  const connection = { ...options, token, baseUrl: resolveClawHubBaseUrl(options.baseUrl) };
  const result = await fetchClawHubJson<{ user?: { handle?: string | null } }>({
    ...connection,
    path: "/api/v1/whoami",
  });
  const publisher = result.user?.handle;
  if (!publisher || !/^[a-z0-9][a-z0-9._-]*$/.test(publisher)) {
    throw new ClawProjectError(
      "clawhub_identity_required",
      "Your ClawHub account needs a personal publisher handle.",
    );
  }
  return { publisher, connection };
}

function reviewToken(
  target: DraftTarget,
  snapshot: { revision: string; integrity: string },
  publisher: string,
  baseUrl: string,
) {
  return clawDraftRevision(
    JSON.stringify([
      target.workspaceDir,
      target.draftId,
      snapshot.revision,
      snapshot.integrity,
      publisher,
      baseUrl,
    ]),
  );
}

export async function reviewClawDraft(
  target: DraftTarget,
  options: ClawHubFetchOptions = {},
): Promise<ClawsDraftsReviewResult> {
  const { publisher, connection } = await personalPublisher(options);
  await using snapshot = await prepareClawDraft({ ...target, publisher });
  return {
    revision: snapshot.revision,
    reviewToken: reviewToken(target, snapshot, publisher, connection.baseUrl),
    publisher,
    name: snapshot.name,
    displayName: snapshot.displayName,
    version: snapshot.version,
    description: snapshot.description,
    items: snapshot.items,
    files: snapshot.files,
    scope: snapshot.scope,
  };
}

export async function publishClawDraft(
  target: DraftTarget & { reviewToken: string },
  assertCurrent: () => void,
  options: ClawHubFetchOptions = {},
): Promise<ClawsDraftsPublishResult> {
  assertCurrent();
  const { publisher, connection } = await personalPublisher(options);
  await using snapshot = await prepareClawDraft({ ...target, publisher });
  if (target.reviewToken !== reviewToken(target, snapshot, publisher, connection.baseUrl)) {
    throw new ClawProjectError(
      "draft_review_required",
      "The draft or publisher changed. Review the current files before publishing.",
    );
  }
  const bytes = await readFile(snapshot.artifact);
  const digest = snapshot.integrity.replace(/^sha256:/, "");
  const form = new FormData();
  form.set(
    "payload",
    JSON.stringify({
      name: snapshot.name,
      version: snapshot.version,
      family: "claw",
      ownerHandle: publisher,
      channel: "community",
      changelog: "Created from a reviewed private agent workflow.",
      expectedArtifactSha256: digest,
    }),
  );
  form.set("clawpack", new Blob([new Uint8Array(bytes)], { type: "application/gzip" }), "claw.tgz");
  assertCurrent();
  // Never retry this write: a timeout may follow a committed publication. The
  // immutable name/version identifies the result for the creator to reconcile.
  let result: {
    ok?: boolean;
    publicationStatus?: "pending" | "published";
    artifactSha256?: string;
  };
  try {
    result = await fetchClawHubJson({
      ...connection,
      path: "/api/v1/packages",
      method: "POST",
      form,
    });
  } catch {
    throw new ClawProjectError(
      "publication_unconfirmed",
      `Publication of ${snapshot.name}@${snapshot.version} was not confirmed. Check that version on ClawHub before trying again.`,
    );
  }
  if (result.ok !== true || (result.artifactSha256 && result.artifactSha256 !== digest)) {
    throw new ClawProjectError(
      "publication_unconfirmed",
      `ClawHub did not confirm the reviewed artifact for ${snapshot.name}@${snapshot.version}. Check that version before trying again.`,
    );
  }
  const slug = snapshot.name.split("/").at(-1) ?? snapshot.name;
  return {
    name: snapshot.name,
    version: snapshot.version,
    url: `${connection.baseUrl}/${encodeURIComponent(publisher)}/claws/${encodeURIComponent(slug)}`,
    // Missing scan status is not evidence of public discoverability.
    publicationStatus: result.publicationStatus === "published" ? "published" : "pending",
  };
}
