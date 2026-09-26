// Gateway RPC handlers for skill discovery, install/update, and proposal workflows.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  buildClawHubTrustErrorDetails,
  ErrorCodes,
  errorShape,
  type SkillsInstallParams,
  type SkillsUpdateParams,
  validateSkillsBinsParams,
  validateSkillsDetailParams,
  validateSkillsInstallParams,
  validateSkillsProposalActionParams,
  validateSkillsProposalCreateParams,
  validateSkillsProposalDecisionParams,
  validateSkillsProposalEvaluateParams,
  validateSkillsProposalEventsListParams,
  validateSkillsProposalInspectParams,
  validateSkillsProposalRequestRevisionParams,
  validateSkillsProposalReviseParams,
  validateSkillsProposalsListParams,
  validateSkillsProposalUpdateParams,
  validateSkillsSearchParams,
  validateSkillsSecurityVerdictsParams,
  validateSkillsSkillCardParams,
  validateSkillsUpdateParams,
  validateSkillsWorkshopReadParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import { fetchClawHubSkillDetail } from "../../infra/clawhub-skills.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { registerClawHubCatalogIconUrls } from "../../plugins/catalog-icon-registry.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { getOrCreatePromise } from "../../shared/lazy-promise.js";
import { updateSkillConfigEntry } from "../../skills/config/mutations.js";
import { collectSkillBins } from "../../skills/discovery/bins.js";
import { parseRequestedClawHubSkillRef } from "../../skills/lifecycle/clawhub-store.js";
import {
  installSkillFromClawHub,
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
} from "../../skills/lifecycle/clawhub.js";
import { installSkill } from "../../skills/lifecycle/install.js";
import { installUploadedSkillArchive } from "../../skills/lifecycle/upload-install.js";
import { prepareWorkspaceSkillEntries } from "../../skills/loading/workspace-skill-loader.js";
import {
  collectClawHubVerdictTargets,
  fetchOpenClawSkillSecurityVerdicts,
} from "../../skills/security/clawhub-verdicts.js";
import { resolveSkillProposalName } from "../../skills/workshop/frontmatter.js";
import { assertExpectedRevisionHash } from "../../skills/workshop/service-evaluation.js";
import {
  applySkillProposal,
  evaluateSkillProposal,
  inspectSkillProposal,
  listSkillProposalEvents,
  listSkillProposals,
  proposeCreateSkill,
  proposeUpdateSkill,
  quarantineSkillProposal,
  rejectSkillProposal,
  reviseSkillProposal,
} from "../../skills/workshop/service.js";
import { PROPOSAL_DRAFT_FILE } from "../../skills/workshop/store-record.js";
import type { SkillProposalReadResult, SkillProposalRecord } from "../../skills/workshop/types.js";
import {
  listWritableWorkshopSkillSummaries,
  readWritableWorkshopSkill,
} from "../../skills/workshop/workspace-skill-read.js";
import { skillsCuratorHandlers } from "./skills-curator.js";
import { skillsLibraryHandlers } from "./skills-library.js";
import { skillProposalHistoryHandlers } from "./skills-proposal-history.js";
import { buildRemoteAwareWorkspaceSkillStatus, handleSkillsStatus } from "./skills-status.js";
import { skillsUploadHandlers } from "./skills-upload.js";
import {
  resolveSkillsAgentWorkspace,
  defineSkillsProposalWorkspaceHandler,
  SKILL_PROPOSAL_RESPONSE_HANDLED,
  type ResolvedSkillsWorkspace,
} from "./skills-workspace-handler.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

type ClawHubInstallResult = Awaited<ReturnType<typeof installSkillFromClawHub>>;
type ClawHubInstallParams = Parameters<typeof installSkillFromClawHub>[0];

const clawHubInstallsInFlight = new Map<string, Promise<ClawHubInstallResult>>();

function proposalWorkspaceOptions(resolved: ResolvedSkillsWorkspace) {
  return {
    workspaceDir: resolved.workspaceDir,
    agentId: resolved.agentId,
    eventActor: { type: "gateway" as const },
    config: resolved.cfg,
  };
}

function projectGatewaySkillProposalRecord(record: SkillProposalRecord): SkillProposalRecord {
  return record.draftFile === PROPOSAL_DRAFT_FILE
    ? record
    : { ...record, draftFile: PROPOSAL_DRAFT_FILE };
}

function projectGatewaySkillProposalResult<T extends { record: SkillProposalRecord }>(result: T) {
  return { ...result, record: projectGatewaySkillProposalRecord(result.record) };
}

function projectGatewaySkillProposalReadResult(proposal: SkillProposalReadResult) {
  return {
    ...projectGatewaySkillProposalResult(proposal),
    ...(proposal.supportFiles
      ? {
          supportFiles: proposal.supportFiles.map(({ path, content }) => ({ path, content })),
        }
      : {}),
  };
}

function installClawHubSkillDeduped(params: ClawHubInstallParams): Promise<ClawHubInstallResult> {
  // A WebSocket can disappear after the request reached the Gateway. Keep one
  // exact install per workspace in flight so a reconnect can safely reattach.
  const key = JSON.stringify([
    params.workspaceDir,
    params.slug,
    params.version ?? null,
    params.force ?? false,
  ]);
  return getOrCreatePromise(clawHubInstallsInFlight, key, () => installSkillFromClawHub(params), {
    evictOnSettled: true,
  });
}

function collectClawHubTrustWarnings(results: Array<{ warning?: string }>): string[] {
  return results
    .map((result) => normalizeOptionalString(result.warning))
    .filter((warning): warning is string => Boolean(warning));
}

function buildRevisionAgentInstruction(proposal: SkillProposalReadResult) {
  return [
    `Revise Skill Workshop proposal \`${proposal.record.id}\` (${resolveSkillProposalName(proposal.record.kind, proposal.record.target)}).`,
    "",
    "Use `skill_workshop` with `action=inspect` first, then `action=revise` for that pending proposal.",
    "The proposal ID and expected revision hash are bound by this run; do not substitute them.",
    "Do not apply, approve, reject, quarantine, or install the proposal.",
    "",
    "Requested changes:",
  ].join("\n");
}

async function forwardSkillWorkshopRevisionToChatSend(
  opts: GatewayRequestHandlerOptions,
  params: {
    agentId: string;
    idempotencyKey: string;
    instructions: string;
    proposal: NonNullable<Awaited<ReturnType<typeof inspectSkillProposal>>>;
    expectedRevisionHash: string;
    workspaceDir: string;
    sessionId?: string;
    sessionKey: string;
    targetAgentId?: string;
  },
): Promise<void> {
  const { handleChatSendWithSkillWorkshopProposalRevision } =
    await import("./chat-send-handler.js");
  const chatParams = {
    sessionKey: params.sessionKey,
    agentId: params.targetAgentId ?? params.agentId,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    message: params.instructions,
    deliver: false,
    queueMode: "followup" as const,
    systemProvenanceReceipt: buildRevisionAgentInstruction(params.proposal),
    suppressCommandInterpretation: true,
    idempotencyKey: params.idempotencyKey,
  };
  await handleChatSendWithSkillWorkshopProposalRevision(
    {
      ...opts,
      req: { ...opts.req, method: "chat.send", params: chatParams },
      params: chatParams,
    },
    {
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      proposalId: params.proposal.record.id,
      expectedRevisionHash: params.expectedRevisionHash,
    },
  );
}

/** Gateway request handlers for skill status, catalogs, installs, updates, and workshop proposals. */
export const skillsHandlers: GatewayRequestHandlers = {
  ...skillsCuratorHandlers,
  ...skillsLibraryHandlers,
  ...skillsUploadHandlers,
  ...skillProposalHistoryHandlers,
  "skills.status": handleSkillsStatus,
  "skills.securityVerdicts": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSkillsSecurityVerdictsParams,
        "skills.securityVerdicts",
        respond,
      )
    ) {
      return;
    }
    const resolved = resolveSkillsAgentWorkspace(params, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    try {
      const { report } = await buildRemoteAwareWorkspaceSkillStatus(resolved);
      const targets = collectClawHubVerdictTargets(report);
      if (targets.length === 0) {
        respond(true, { schema: "openclaw.skills.security-verdicts.v1", items: [] }, undefined);
        return;
      }
      const items = await fetchOpenClawSkillSecurityVerdicts(targets);
      respond(true, { schema: "openclaw.skills.security-verdicts.v1", items }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));
    }
  },
  "skills.skillCard": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSkillsSkillCardParams, "skills.skillCard", respond)) {
      return;
    }
    const resolved = resolveSkillsAgentWorkspace(params, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    const { report, files } = await buildRemoteAwareWorkspaceSkillStatus(
      resolved,
      undefined,
      params.skillKey,
    );
    const skill = report.skills.find((candidate) => candidate.skillKey === params.skillKey);
    if (!skill?.skillCard) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `skill card not found for ${params.skillKey}`),
      );
      return;
    }
    const content = files.find(
      (file) => file.name === skill.name && file.filePath === skill.filePath,
    )?.skillCard?.content;
    if (content === undefined) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `skill card not readable for ${params.skillKey}`),
      );
      return;
    }
    respond(
      true,
      {
        schema: "openclaw.skills.skill-card.v1",
        skillKey: skill.skillKey,
        path: skill.skillCard.path,
        sizeBytes: skill.skillCard.sizeBytes,
        content,
      },
      undefined,
    );
  },
  "skills.bins": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSkillsBinsParams, "skills.bins", respond)) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const bins = new Set<string>();
    for (const agentId of listAgentIds(cfg)) {
      // Node inventories include missing requirements, not only locally usable skills.
      const { entries } = await prepareWorkspaceSkillEntries(
        resolveAgentWorkspaceDir(cfg, agentId),
        {
          config: cfg,
          agentId,
          agentSkillFilter: "ignore",
        },
      );
      for (const bin of collectSkillBins(entries)) {
        bins.add(bin);
      }
    }
    respond(true, { bins: [...bins].toSorted() }, undefined);
  },
  "skills.search": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSkillsSearchParams, "skills.search", respond)) {
      return;
    }
    try {
      const results = await searchSkillsFromClawHub({
        query: (params as { query?: string }).query,
        limit: (params as { limit?: number }).limit,
      });
      registerClawHubCatalogIconUrls(results.map((result) => result.icon ?? undefined));
      respond(true, { results }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));
    }
  },
  "skills.detail": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSkillsDetailParams, "skills.detail", respond)) {
      return;
    }
    try {
      // Same reference grammar as skills.install, so a client cannot review one publisher's
      // card and then install another's.
      const requested = parseRequestedClawHubSkillRef((params as { slug: string }).slug);
      if (requested.requestedReference) {
        // ClawHub has no source-qualified read endpoint, so reading this by bare slug would
        // show a same-slug registry skill while install resolves the external artifact.
        // Refusing keeps review and install on one identity until that contract exists.
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `ClawHub cannot return details for ${requested.requestedReference}; external skill sources are install-only. Install it directly, or run "openclaw skills install ${requested.requestedReference}".`,
          ),
        );
        return;
      }
      const detail = await fetchClawHubSkillDetail({
        slug: requested.slug,
        ...(requested.ownerHandle ? { ownerHandle: requested.ownerHandle } : {}),
      });
      registerClawHubCatalogIconUrls([
        detail.skill?.icon ?? undefined,
        detail.owner?.image ?? undefined,
      ]);
      respond(true, detail, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));
    }
  },
  "skills.proposals.list": defineSkillsProposalWorkspaceHandler(
    "skills.proposals.list",
    validateSkillsProposalsListParams,
    async (_parsedParams, resolved) => {
      const options = { config: resolved.cfg, agentId: resolved.agentId };
      const manifest = await listSkillProposals(options);
      return {
        ...manifest,
        installedSkills: listWritableWorkshopSkillSummaries(options).map(
          ({ name, skillKey, description }) => ({ name, skillKey, description }),
        ),
      };
    },
  ),
  "skills.workshop.read": defineSkillsProposalWorkspaceHandler(
    "skills.workshop.read",
    validateSkillsWorkshopReadParams,
    async (parsedParams, resolved) => {
      const skill = await readWritableWorkshopSkill(parsedParams.name, {
        config: resolved.cfg,
        agentId: resolved.agentId,
      });
      return {
        name: skill.skillName,
        skillKey: skill.skillKey,
        description: skill.description,
        content: skill.content,
      };
    },
  ),
  "skills.proposals.events.list": defineSkillsProposalWorkspaceHandler(
    "skills.proposals.events.list",
    validateSkillsProposalEventsListParams,
    async (parsedParams, resolved) =>
      listSkillProposalEvents({
        agentId: resolved.agentId,
        config: resolved.cfg,
        proposalId: parsedParams.proposalId,
        afterSequence: parsedParams.afterSequence,
        limit: parsedParams.limit,
      }),
  ),
  "skills.proposals.inspect": defineSkillsProposalWorkspaceHandler(
    "skills.proposals.inspect",
    validateSkillsProposalInspectParams,
    async (parsedParams, resolved) => {
      const proposal = await inspectSkillProposal(parsedParams.proposalId, {
        agentId: resolved.agentId,
        config: resolved.cfg,
      });
      if (!proposal) {
        throw new Error(`Skill proposal not found: ${parsedParams.proposalId}`);
      }
      return projectGatewaySkillProposalReadResult(proposal);
    },
  ),
  "skills.proposals.evaluate": defineSkillsProposalWorkspaceHandler(
    "skills.proposals.evaluate",
    validateSkillsProposalEvaluateParams,
    (parsedParams, resolved) =>
      evaluateSkillProposal({
        ...proposalWorkspaceOptions(resolved),
        proposalId: parsedParams.proposalId,
        expectedRevisionHash: parsedParams.expectedRevisionHash,
        correlationId: parsedParams.correlationId,
        trigger: "manual",
      }).then(projectGatewaySkillProposalResult),
  ),
  "skills.proposals.create": defineSkillsProposalWorkspaceHandler(
    "skills.proposals.create",
    validateSkillsProposalCreateParams,
    (parsedParams, resolved) =>
      proposeCreateSkill({
        ...proposalWorkspaceOptions(resolved),
        name: parsedParams.name,
        description: parsedParams.description,
        content: parsedParams.content,
        supportFiles: parsedParams.supportFiles,
        createdBy: "gateway",
        goal: parsedParams.goal,
        evidence: parsedParams.evidence,
      }).then(projectGatewaySkillProposalReadResult),
  ),
  "skills.proposals.update": defineSkillsProposalWorkspaceHandler(
    "skills.proposals.update",
    validateSkillsProposalUpdateParams,
    (parsedParams, resolved) =>
      proposeUpdateSkill({
        ...proposalWorkspaceOptions(resolved),
        skillName: parsedParams.skillName,
        description: parsedParams.description,
        content: parsedParams.content,
        supportFiles: parsedParams.supportFiles,
        createdBy: "gateway",
        goal: parsedParams.goal,
        evidence: parsedParams.evidence,
      }).then(projectGatewaySkillProposalReadResult),
  ),
  "skills.proposals.revise": defineSkillsProposalWorkspaceHandler(
    "skills.proposals.revise",
    validateSkillsProposalReviseParams,
    (parsedParams, resolved) =>
      reviseSkillProposal({
        ...proposalWorkspaceOptions(resolved),
        proposalId: parsedParams.proposalId,
        expectedRevisionHash: parsedParams.expectedRevisionHash,
        correlationId: parsedParams.correlationId,
        content: parsedParams.content,
        supportFiles: parsedParams.supportFiles,
        description: parsedParams.description,
        goal: parsedParams.goal,
        evidence: parsedParams.evidence,
      }).then(projectGatewaySkillProposalReadResult),
  ),
  "skills.proposals.requestRevision": defineSkillsProposalWorkspaceHandler(
    "skills.proposals.requestRevision",
    validateSkillsProposalRequestRevisionParams,
    async (parsedParams, resolved, opts) => {
      const expectedRevisionHash = parsedParams.expectedRevisionHash;
      const proposal = await inspectSkillProposal(parsedParams.proposalId, {
        agentId: resolved.agentId,
        config: resolved.cfg,
      });
      if (!proposal) {
        throw new Error(`Skill proposal not found: ${parsedParams.proposalId}`);
      }
      if (proposal.record.status !== "pending") {
        throw new Error(`Skill proposal is not pending: ${parsedParams.proposalId}`);
      }
      assertExpectedRevisionHash(proposal.revisionHash, expectedRevisionHash);
      await forwardSkillWorkshopRevisionToChatSend(opts, {
        agentId: resolved.agentId,
        expectedRevisionHash,
        idempotencyKey: parsedParams.idempotencyKey,
        instructions: parsedParams.instructions,
        proposal,
        workspaceDir: resolved.workspaceDir,
        sessionId: parsedParams.sessionId,
        sessionKey: parsedParams.sessionKey,
        targetAgentId: parsedParams.targetAgentId
          ? normalizeAgentId(parsedParams.targetAgentId)
          : undefined,
      });
      return SKILL_PROPOSAL_RESPONSE_HANDLED;
    },
  ),
  "skills.proposals.apply": defineSkillsProposalWorkspaceHandler(
    "skills.proposals.apply",
    validateSkillsProposalDecisionParams,
    (parsedParams, resolved) =>
      applySkillProposal({
        ...proposalWorkspaceOptions(resolved),
        proposalId: parsedParams.proposalId,
        expectedRevisionHash: parsedParams.expectedRevisionHash,
        correlationId: parsedParams.correlationId,
        reason: parsedParams.reason,
      }).then(projectGatewaySkillProposalResult),
  ),
  "skills.proposals.reject": defineSkillsProposalWorkspaceHandler(
    "skills.proposals.reject",
    validateSkillsProposalDecisionParams,
    (parsedParams, resolved) =>
      rejectSkillProposal({
        ...proposalWorkspaceOptions(resolved),
        proposalId: parsedParams.proposalId,
        expectedRevisionHash: parsedParams.expectedRevisionHash,
        correlationId: parsedParams.correlationId,
        reason: parsedParams.reason,
      }).then(projectGatewaySkillProposalRecord),
  ),
  "skills.proposals.quarantine": defineSkillsProposalWorkspaceHandler(
    "skills.proposals.quarantine",
    validateSkillsProposalActionParams,
    (parsedParams, resolved) =>
      quarantineSkillProposal({
        ...proposalWorkspaceOptions(resolved),
        proposalId: parsedParams.proposalId,
        expectedRevisionHash: parsedParams.expectedRevisionHash,
        correlationId: parsedParams.correlationId,
        reason: parsedParams.reason,
      }).then(projectGatewaySkillProposalRecord),
  ),
  "skills.install": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSkillsInstallParams, "skills.install", respond)) {
      return;
    }
    const p: SkillsInstallParams = params;
    const resolved = resolveSkillsAgentWorkspace(params, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    const cfg = resolved.cfg;
    const workspaceDirRaw = resolved.workspaceDir;
    // Skill installs are intentionally routed by source; each source owns its
    // validation, provenance checks, and result payload shape.
    if ("source" in p && p.source === "clawhub") {
      const result = await installClawHubSkillDeduped({
        workspaceDir: workspaceDirRaw,
        slug: p.slug,
        version: p.version,
        force: Boolean(p.force),
        logger: context.logGateway,
        config: cfg,
      });
      const errorDetails = result.ok ? undefined : buildClawHubTrustErrorDetails(result);
      respond(
        result.ok,
        result.ok
          ? {
              ok: true,
              message: `Installed ${result.slug}@${result.version}`,
              stdout: "",
              stderr: "",
              code: 0,
              slug: result.slug,
              version: result.version,
              targetDir: result.targetDir,
              ...(result.warning ? { warning: result.warning } : {}),
            }
          : result,
        result.ok
          ? undefined
          : errorShape(
              ErrorCodes.UNAVAILABLE,
              result.error,
              errorDetails ? { details: errorDetails } : undefined,
            ),
      );
      return;
    }
    if ("source" in p && p.source === "upload") {
      const result = await installUploadedSkillArchive({
        uploadId: p.uploadId,
        slug: p.slug,
        force: Boolean(p.force),
        sha256: p.sha256,
        timeoutMs: p.timeoutMs,
        workspaceDir: workspaceDirRaw,
        config: cfg,
        log: context.logGateway,
      });
      const errorCode =
        !result.ok && result.errorKind === "invalid-request"
          ? ErrorCodes.INVALID_REQUEST
          : ErrorCodes.UNAVAILABLE;
      const responseResult = result.ok
        ? result
        : {
            ok: false,
            error: result.error,
            errorCode,
          };
      respond(
        result.ok,
        responseResult,
        result.ok ? undefined : errorShape(errorCode, result.error),
      );
      return;
    }
    const result = await installSkill({
      workspaceDir: workspaceDirRaw,
      agentId: resolved.agentId,
      skillName: p.name,
      installId: p.installId,
      timeoutMs: p.timeoutMs,
      config: cfg,
    });
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.message),
    );
  },
  "skills.update": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSkillsUpdateParams, "skills.update", respond)) {
      return;
    }
    const p: SkillsUpdateParams = params;
    if ("source" in p) {
      if (!p.slug && !p.all) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, 'clawhub skills.update requires "slug" or "all"'),
        );
        return;
      }
      if (p.slug && p.all) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            'clawhub skills.update accepts either "slug" or "all", not both',
          ),
        );
        return;
      }
      const resolved = resolveSkillsAgentWorkspace(params, context);
      if (!resolved.ok) {
        respond(false, undefined, resolved.error);
        return;
      }
      const results = await updateSkillsFromClawHub({
        workspaceDir: resolved.workspaceDir,
        slug: p.slug,
        ...(p.force ? { force: true } : {}),
        logger: context.logGateway,
        config: resolved.cfg,
      });
      const errors = results.filter((result) => !result.ok);
      const warnings = collectClawHubTrustWarnings(results);
      respond(
        errors.length === 0,
        {
          ok: errors.length === 0,
          skillKey: p.slug ?? "*",
          config: {
            source: "clawhub",
            results,
          },
        },
        errors.length === 0
          ? undefined
          : errorShape(ErrorCodes.UNAVAILABLE, errors.map((result) => result.error).join("; "), {
              details: {
                results,
                ...(warnings.length > 0 ? { warnings } : {}),
              },
            }),
      );
      return;
    }
    const updated = await updateSkillConfigEntry(p);
    respond(
      true,
      { ok: true, skillKey: p.skillKey, config: redactConfigObject(updated) },
      undefined,
    );
  },
};
