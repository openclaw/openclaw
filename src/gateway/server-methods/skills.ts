import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  ErrorCodes,
  errorShape,
  validateSkillsBinsParams,
  validateSkillsDetailParams,
  validateSkillsSearchParams,
  validateSkillsSecurityVerdictsParams,
  validateSkillsSkillCardParams,
  validateSkillsUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import { fetchClawHubSkillDetail } from "../../infra/clawhub-skills.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { registerClawHubCatalogIconUrls } from "../../plugins/catalog-icon-registry.js";
import { updateSkillConfigEntry } from "../../skills/config/mutations.js";
import { collectSkillBins } from "../../skills/discovery/bins.js";
import { parseRequestedClawHubSkillRef } from "../../skills/lifecycle/clawhub-store.js";
import {
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
} from "../../skills/lifecycle/clawhub.js";
import { prepareWorkspaceSkillEntries } from "../../skills/loading/workspace-skill-loader.js";
import {
  collectClawHubVerdictTargets,
  fetchOpenClawSkillSecurityVerdicts,
} from "../../skills/security/clawhub-verdicts.js";
import { handleSkillsInstall } from "./skills-install.js";
import { skillsLibraryHandlers } from "./skills-library.js";
import { skillsRetiredHandlers } from "./skills-retired.js";
import { buildRemoteAwareWorkspaceSkillStatus, handleSkillsStatus } from "./skills-status.js";
import { skillsUploadHandlers } from "./skills-upload.js";
import { skillsWorkshopHandlers } from "./skills-workshop.js";
import { resolveSkillsAgentWorkspace } from "./skills-workspace-handler.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams, defineValidatedGatewayHandler } from "./validation.js";

export const skillsHandlers: GatewayRequestHandlers = {
  ...skillsLibraryHandlers,
  ...skillsUploadHandlers,
  ...skillsWorkshopHandlers,
  ...skillsRetiredHandlers,
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
      const items = targets.length === 0 ? [] : await fetchOpenClawSkillSecurityVerdicts(targets);
      respond(true, { schema: "openclaw.skills.security-verdicts.v1", items }, undefined);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
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
  "skills.search": defineValidatedGatewayHandler(
    "skills.search",
    validateSkillsSearchParams,
    async ({ params, respond }) => {
      const results = await searchSkillsFromClawHub({
        query: params.query,
        limit: params.limit,
      });
      registerClawHubCatalogIconUrls(results.map((result) => result.icon ?? undefined));
      respond(true, { results }, undefined);
    },
    (error) => errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)),
  ),
  "skills.detail": defineValidatedGatewayHandler(
    "skills.detail",
    validateSkillsDetailParams,
    async ({ params, respond }) => {
      // Same reference grammar as skills.install, so a client cannot review one publisher's
      // card and then install another's.
      const requested = parseRequestedClawHubSkillRef(params.slug);
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
        includeInspection: true,
        ...(params.version ? { version: params.version } : {}),
        ...(requested.ownerHandle ? { ownerHandle: requested.ownerHandle } : {}),
      });
      registerClawHubCatalogIconUrls([
        detail.skill?.icon ?? undefined,
        detail.owner?.image ?? undefined,
      ]);
      respond(true, detail, undefined);
    },
    (error) => errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)),
  ),
  "skills.install": handleSkillsInstall,
  "skills.update": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSkillsUpdateParams, "skills.update", respond)) {
      return;
    }
    const p = params;
    if ("source" in p) {
      if (Boolean(p.slug) === Boolean(p.all)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            p.slug
              ? 'clawhub skills.update accepts either "slug" or "all", not both'
              : 'clawhub skills.update requires "slug" or "all"',
          ),
        );
        return;
      }
      const resolved = resolveSkillsAgentWorkspace(p, context);
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
      const warnings = normalizeTrimmedStringList(results.map((result) => result.warning));
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
