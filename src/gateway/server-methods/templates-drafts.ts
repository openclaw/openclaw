import { readFile } from "node:fs/promises";
import {
  type TemplateDraftReviewChoices,
  type TemplatesDraftsPublishResult,
  type TemplatesDraftsReviewResult,
  ErrorCodes,
  errorShape,
  validateTemplatesDraftsCreateParams,
  validateTemplatesDraftsReadParams,
  validateTemplatesDraftsSaveParams,
  validateTemplatesDraftsReviewParams,
  validateTemplatesDraftsPublishParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import {
  fetchClawHubJson,
  resolveClawHubAuthToken,
  resolveClawHubBaseUrl,
  type ClawHubFetchOptions,
} from "../../infra/clawhub-client.js";
import { templateDraftPrompt } from "../../templates/draft-prompt.js";
import {
  prepareTemplateDraft,
  createTemplateDraft,
  readTemplateDraft,
  templateDraftRelativePath,
  templateDraftRevision,
  MAX_TEMPLATE_DRAFT_BYTES,
} from "../../templates/draft.js";
import {
  assertTemplatesLabsEnabled,
  TemplatesLabsDisabledError,
} from "../../templates/labs-gate.js";
import { TemplateProjectError } from "../../templates/project.js";
import {
  authorizeCurrentOperatorRoleScopes,
  authorizeGatewaySessionCreation,
} from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { hasCurrentPersonalGatewaySource } from "./gateway-personal-caller.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";
import { updateWorkspaceFile } from "./workspace-fs.js";

type DraftTarget = { workspaceDir: string; draftId: string; choices?: TemplateDraftReviewChoices };

async function personalPublisher(options: ClawHubFetchOptions) {
  const token = options.token ?? (await resolveClawHubAuthToken());
  if (!token) {
    throw new TemplateProjectError(
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
    throw new TemplateProjectError(
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
  return templateDraftRevision(
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

async function reviewTemplateDraft(
  target: DraftTarget,
  options: ClawHubFetchOptions = {},
): Promise<TemplatesDraftsReviewResult> {
  const { publisher, connection } = await personalPublisher(options);
  await using snapshot = await prepareTemplateDraft({ ...target, publisher });
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

async function publishTemplateDraft(
  target: DraftTarget & { reviewToken: string },
  assertCurrent: () => void,
  options: ClawHubFetchOptions = {},
): Promise<TemplatesDraftsPublishResult> {
  assertCurrent();
  const { publisher, connection } = await personalPublisher(options);
  await using snapshot = await prepareTemplateDraft({ ...target, publisher });
  if (target.reviewToken !== reviewToken(target, snapshot, publisher, connection.baseUrl)) {
    throw new TemplateProjectError(
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
      family: "template",
      ownerHandle: publisher,
      channel: "community",
      changelog: "Created from a reviewed private agent workflow.",
      expectedArtifactSha256: digest,
    }),
  );
  form.set(
    "clawpack",
    new Blob([new Uint8Array(bytes)], { type: "application/gzip" }),
    "template.tgz",
  );
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
    throw new TemplateProjectError(
      "publication_unconfirmed",
      `Publication of ${snapshot.name}@${snapshot.version} was not confirmed. Check that version on ClawHub before trying again.`,
    );
  }
  if (result.ok !== true || (result.artifactSha256 && result.artifactSha256 !== digest)) {
    throw new TemplateProjectError(
      "publication_unconfirmed",
      `ClawHub did not confirm the reviewed artifact for ${snapshot.name}@${snapshot.version}. Check that version before trying again.`,
    );
  }
  const slug = snapshot.name.split("/").at(-1) ?? snapshot.name;
  return {
    name: snapshot.name,
    version: snapshot.version,
    url: `${connection.baseUrl}/${encodeURIComponent(publisher)}/templates/${encodeURIComponent(slug)}`,
    // Missing scan status is not evidence of public discoverability.
    publicationStatus: result.publicationStatus === "published" ? "published" : "pending",
  };
}

function draftAuthority(
  options: GatewayRequestHandlerOptions,
  agentId: string,
  sourceSessionKey?: string,
) {
  const initialWorkspace = resolveAgentWorkspaceDir(options.context.getRuntimeConfig(), agentId);
  const assertCurrent = () => {
    const { client, context } = options;
    if (
      !hasCurrentPersonalGatewaySource(client, context) ||
      !client.connect.scopes?.includes("operator.admin")
    ) {
      throw new TemplateProjectError(
        "human_required",
        "Create, review, and publish Templates from an active administrator Control UI connection.",
      );
    }
    options.sessionMutationCommitGuard?.();
    const cfg = context.getRuntimeConfig();
    assertTemplatesLabsEnabled(cfg);
    const resolved = resolveRequestedSessionAgentId(cfg, sourceSessionKey, agentId);
    if (!resolved.ok) {
      throw new TemplateProjectError("invalid_agent", resolved.error.message);
    }
    const denied =
      authorizeCurrentOperatorRoleScopes(client, cfg) ??
      authorizeGatewaySessionCreation({ client, cfg, agentId });
    if (denied) {
      throw new TemplateProjectError("forbidden", denied.message);
    }
    if (resolveAgentWorkspaceDir(cfg, agentId) !== initialWorkspace) {
      throw new TemplateProjectError(
        "workspace_changed",
        "The agent's workspace changed. Reopen the draft before continuing.",
      );
    }
    if (getAgentWorkspaceAccess(initialWorkspace)) {
      throw new TemplateProjectError(
        "remote_workspace",
        "Template drafts currently require a workspace on this Gateway host.",
      );
    }
  };
  assertCurrent();
  return { workspaceDir: initialWorkspace, assertCurrent };
}

function draftError(error: unknown) {
  if (
    error instanceof TemplatesLabsDisabledError ||
    (error instanceof TemplateProjectError &&
      ["human_required", "forbidden", "source_forbidden"].includes(error.code))
  ) {
    return errorShape(ErrorCodes.FORBIDDEN, error.message);
  }
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    error instanceof TemplateProjectError
      ? error.message
      : "The Template draft could not be processed. Check its contents and try again.",
  );
}

export const templatesDraftsHandlers: GatewayRequestHandlers = {
  "templates.drafts.create": defineValidatedGatewayMethod(
    "templates.drafts.create",
    validateTemplatesDraftsCreateParams,
    async (options) => {
      const { params } = options;
      const authority = draftAuthority(options, params.agentId, params.sourceSessionKey);
      const source = params.sourceSessionKey
        ? await resolveSessionMutationAuthorizationAsync({
            client: options.client,
            context: options.context,
            method: "chat.history",
            requestParams: { sessionKey: params.sourceSessionKey, agentId: params.agentId },
            sessionScope: "operator.sessions.read",
            assertInvocationCurrent: authority.assertCurrent,
          })
        : undefined;
      try {
        if (source?.error) {
          throw new TemplateProjectError("source_forbidden", source.error.message);
        }
        const assertCurrent = () => {
          authority.assertCurrent();
          source?.authorization?.assertCurrent();
        };
        const draft = await createTemplateDraft(authority.workspaceDir, assertCurrent);
        assertCurrent();
        options.respond(true, {
          draftId: draft.draftId,
          prompt: templateDraftPrompt(),
        });
      } finally {
        source?.authorization?.release?.();
      }
    },
    draftError,
  ),
  "templates.drafts.read": defineValidatedGatewayMethod(
    "templates.drafts.read",
    validateTemplatesDraftsReadParams,
    async (options) => {
      const { params } = options;
      const authority = draftAuthority(options, params.agentId);
      const draft = await readTemplateDraft(authority.workspaceDir, params.draftId);
      authority.assertCurrent();
      options.respond(true, draft);
    },
    draftError,
  ),
  "templates.drafts.save": defineValidatedGatewayMethod(
    "templates.drafts.save",
    validateTemplatesDraftsSaveParams,
    async (options) => {
      const { params } = options;
      const authority = draftAuthority(options, params.agentId);
      if (Buffer.byteLength(params.content, "utf8") > MAX_TEMPLATE_DRAFT_BYTES) {
        throw new TemplateProjectError(
          "draft_too_large",
          "The Template draft exceeds the 1 MB size limit.",
        );
      }
      const result = await updateWorkspaceFile(
        authority.workspaceDir,
        templateDraftRelativePath(params.draftId),
        params.content,
        params.expectedRevision,
        authority.assertCurrent,
        { maxBytes: MAX_TEMPLATE_DRAFT_BYTES },
      );
      if (result.status !== "updated") {
        throw new TemplateProjectError(
          "draft_changed",
          "The draft changed or could not be safely saved. Reload it before saving again.",
        );
      }
      authority.assertCurrent();
      options.respond(true, {
        content: params.content,
        revision: templateDraftRevision(params.content),
      });
    },
    draftError,
  ),
  "templates.drafts.review": defineValidatedGatewayMethod(
    "templates.drafts.review",
    validateTemplatesDraftsReviewParams,
    async (options) => {
      const { params } = options;
      const authority = draftAuthority(options, params.agentId);
      const review = await reviewTemplateDraft({
        workspaceDir: authority.workspaceDir,
        draftId: params.draftId,
        choices: params.choices,
      });
      authority.assertCurrent();
      options.respond(true, review);
    },
    draftError,
  ),
  "templates.drafts.publish": defineValidatedGatewayMethod(
    "templates.drafts.publish",
    validateTemplatesDraftsPublishParams,
    async (options) => {
      const { params } = options;
      const authority = draftAuthority(options, params.agentId);
      const result = await publishTemplateDraft(
        {
          workspaceDir: authority.workspaceDir,
          draftId: params.draftId,
          reviewToken: params.reviewToken,
          choices: params.choices,
        },
        authority.assertCurrent,
      );
      options.respond(true, result);
    },
    draftError,
  ),
};
