import { listAgentIds } from "../agents/agent-scope.js";
import { isExperimentalClawsEnabled } from "../claws/experimental.js";
import { collectBrowserReadinessFindings } from "../commands/doctor-browser.js";
import { hasConfiguredCommandOwners } from "../commands/doctor-command-owner.js";
import {
  checkShellCompletionStatus,
  shellCompletionStatusToHealthFindings,
  shellCompletionStatusToRepairEffects,
} from "../commands/doctor-completion.js";
import {
  disableUnavailableSkillsInConfig,
  formatMissingSkillSummary,
} from "../commands/doctor-skills-core.js";
import {
  detectUiProtocolFreshnessIssues,
  uiProtocolFreshnessIssueToHealthFinding,
  uiProtocolFreshnessIssueToRepairEffects,
} from "../commands/doctor-ui.js";
import {
  collectCodexRuntimeCompatibilityWarnings,
  collectDisabledCodexPluginRouteIssues,
} from "../commands/doctor/shared/codex-route-warnings.js";
import { isDefaultInstallIdentity } from "../config/paths.js";
import type { CronListPageResult } from "../cron/service/list-page-types.js";
import type { CronJob } from "../cron/types.js";
import { hasAmbiguousGatewayAuthModeConfig } from "../gateway/auth-mode-policy.js";
import type { SkillStatusEntry } from "../skills/discovery/status.js";
import { resolveSkillWorkshopConfig } from "../skills/workshop/config.js";
import { detectSkillWorkshopToolPolicyDiagnostic } from "../skills/workshop/tool-policy-diagnostic.js";
import { createAcpAgentModelCheck } from "./doctor-acp-agent-model-check.js";
import { finalConfigValidationCheck } from "./doctor-config-validation-check.js";
import { bootstrapSizeCheck } from "./doctor-core-bootstrap-size-check.js";
import { detectGatewayAuthHealth } from "./doctor-gateway-auth.js";
import { hasActiveGatewayExecCredential } from "./doctor-gateway-exec-credential.js";
import { gatewayServicesExtraCheck } from "./doctor-gateway-services-check.js";
import type { DoctorHealthCheckContext } from "./doctor-health-contribution-types.js";
import { legacyOwnedRepair } from "./doctor-health-contribution.js";
import { createModelReferenceCheck } from "./doctor-model-reference-check.js";
import { removedWorkspacesStateCheck } from "./doctor-removed-workspaces-state-check.js";
import {
  collectRuntimeToolSchemaFindingsWithRuntime,
  createRuntimeToolSchemaCheck,
} from "./doctor-tool-schema-check.js";
import { resolveDoctorWorkspaceSuggestionScopes } from "./doctor-workspace-suggestion-scopes.js";
import { securityAuditFindingToHealthFinding } from "./health-check-adapter.js";
import type { DoctorHealthCheck } from "./health-check-runner-types.js";
import type { HealthCheckContext, HealthFinding } from "./health-checks.js";

type CoreHealthCheck = Omit<DoctorHealthCheck, "kind" | "source">;

const CODEX_SESSION_ROUTES_CHECK_ID = "core/doctor/codex-session-routes";
const GATEWAY_DAEMON_CHECK_ID = "core/doctor/gateway-daemon";
const GATEWAY_HEALTH_CHECK_ID = "core/doctor/gateway-health";
const TELEGRAM_GENERAL_TOPIC_CONVERSATIONS_CHECK_ID =
  "core/doctor/telegram-general-topic-conversations";
const SKILL_WORKSHOP_TOOL_POLICY_CHECK_ID = "core/doctor/skill-workshop-tool-policy";

async function listGatewayCronJobsWithRuntime(
  ctx: HealthCheckContext,
): Promise<readonly CronJob[]> {
  const { bindAgentToolGatewayRequest } = await import("../agents/tools/in-process-gateway.js");
  const requestGateway = bindAgentToolGatewayRequest({ hostedOnly: true });
  if (
    (await hasActiveGatewayExecCredential({ cfg: ctx.cfg })) &&
    ctx.allowExecSecretRefs !== true
  ) {
    throw new Error(
      "Gateway cron inventory skipped because credentials use an exec SecretRef; rerun doctor with --allow-exec.",
    );
  }
  const jobs: CronJob[] = [];
  let offset = 0;
  let snapshotRevision: string | undefined;
  let total: number | undefined;

  while (total === undefined || offset < total) {
    const request = {
      method: "cron.list",
      params: { includeDisabled: true, limit: 200, offset },
      timeoutMs: 3000,
      config: ctx.cfg,
      deviceIdentity: null,
    };
    const page = await requestGateway<CronListPageResult>(request);
    const validPage =
      Array.isArray(page.jobs) &&
      typeof page.snapshotRevision === "string" &&
      page.snapshotRevision.length > 0 &&
      Number.isSafeInteger(page.total) &&
      page.total >= 0 &&
      page.offset === offset &&
      Number.isSafeInteger(page.limit) &&
      page.limit > 0 &&
      typeof page.hasMore === "boolean" &&
      (page.nextOffset === null || Number.isSafeInteger(page.nextOffset));
    if (!validPage) {
      throw new Error("Gateway returned an invalid cron inventory response.");
    }
    if (
      (snapshotRevision !== undefined && page.snapshotRevision !== snapshotRevision) ||
      (total !== undefined && page.total !== total)
    ) {
      throw new Error("Gateway cron inventory changed while doctor was reading it.");
    }
    snapshotRevision ??= page.snapshotRevision;
    total ??= page.total;
    jobs.push(...page.jobs);

    if (!page.hasMore) {
      if (page.nextOffset !== null || jobs.length !== total) {
        throw new Error("Gateway returned an inconsistent cron inventory response.");
      }
      return jobs;
    }
    const expectedNextOffset = offset + page.jobs.length;
    if (
      page.nextOffset !== expectedNextOffset ||
      expectedNextOffset <= offset ||
      expectedNextOffset >= total
    ) {
      throw new Error("Gateway returned an invalid cron inventory cursor.");
    }
    offset = expectedNextOffset;
  }

  throw new Error("Gateway returned an incomplete cron inventory response.");
}

const gatewayConfigCheck: CoreHealthCheck = {
  id: "core/doctor/gateway-config",
  description: "openclaw.jsonc gateway block is set and unambiguous.",
  async detect(ctx) {
    const findings: HealthFinding[] = [];
    if (!ctx.cfg.gateway?.mode) {
      findings.push({
        checkId: "core/doctor/gateway-config",
        category: "fix-now",
        docsUrl: "https://docs.openclaw.ai/gateway/configuration",
        severity: "warning",
        message: "gateway.mode is unset; gateway start will be blocked.",
        path: "gateway.mode",
        fixHint:
          "Run `openclaw configure` and set Gateway mode (local/remote), or `openclaw config set gateway.mode local`.",
      });
    }
    if (ctx.cfg.gateway?.mode !== "remote" && hasAmbiguousGatewayAuthModeConfig(ctx.cfg)) {
      findings.push({
        checkId: "core/doctor/gateway-config",
        category: "fix-now",
        docsUrl: "https://docs.openclaw.ai/gateway/configuration",
        severity: "warning",
        message:
          "gateway.auth.token and gateway.auth.password are both configured while gateway.auth.mode is unset; auth selection is ambiguous.",
        path: "gateway.auth.mode",
        fixHint:
          "Set an explicit mode: `openclaw config set gateway.auth.mode token` or `... password`.",
      });
    }
    return findings;
  },
};

const commandOwnerCheck: CoreHealthCheck = {
  id: "core/doctor/command-owner",
  description: "An owner account is configured for owner-only commands.",
  async detect(ctx) {
    if (hasConfiguredCommandOwners(ctx.cfg)) {
      return [];
    }
    return [
      {
        checkId: "core/doctor/command-owner",
        category: "recommended",
        docsUrl: "https://docs.openclaw.ai/tools/slash-commands",
        severity: "info",
        message:
          "No command owner is configured. Owner-only commands (/diagnostics, /export-trajectory, /config, exec approvals) have no allowed sender.",
        path: "commands.ownerAllowFrom",
        fixHint:
          "Set commands.ownerAllowFrom to your channel user id, e.g. `openclaw config set commands.ownerAllowFrom '[\"telegram:123456789\"]'`.",
      },
    ];
  },
};

const skillWorkshopToolPolicyCheck: CoreHealthCheck = {
  id: SKILL_WORKSHOP_TOOL_POLICY_CHECK_ID,
  description: "Autonomous Skill Workshop capture has a callable review tool.",
  async detect(ctx) {
    const workshopEnabled = resolveSkillWorkshopConfig(ctx.cfg).autonomous.mode !== "off";
    const listedAgentIds = listAgentIds(ctx.cfg);
    const diagnostics = (listedAgentIds.length > 0 ? listedAgentIds : [undefined]).flatMap(
      (agentId) => {
        const diagnostic = detectSkillWorkshopToolPolicyDiagnostic({
          config: ctx.cfg,
          workshopEnabled,
          ...(agentId ? { agentId } : {}),
        });
        return diagnostic ? [diagnostic] : [];
      },
    );
    return diagnostics.map((diagnostic) => ({
      checkId: SKILL_WORKSHOP_TOOL_POLICY_CHECK_ID,
      category: "fix-now",
      docsUrl: "https://docs.openclaw.ai/tools/skill-workshop",
      severity: "warning",
      message: diagnostic.detail,
      path: diagnostic.source,
      target: diagnostic.agentId,
      requirement: "Autonomous Skill Workshop review requires the skill_workshop tool.",
      fixHint: diagnostic.fix,
    }));
  },
};

const gatewayAuthCheck: CoreHealthCheck = {
  id: "core/doctor/gateway-auth",
  description: "Local Gateway auth mode has a usable token or another explicit auth mode.",
  detect: detectGatewayAuthHealth,
};

const hooksModelCheck: CoreHealthCheck = {
  id: "core/doctor/hooks-model",
  description: "hooks.gmail.model resolves to an allowed catalog model.",
  async detect(ctx) {
    const { collectHooksModelIssues } = await import("../commands/doctor-hooks-model.js");
    return (await collectHooksModelIssues(ctx.cfg)).map(({ kind, model }): HealthFinding => {
      const finding: HealthFinding = {
        checkId: "core/doctor/hooks-model",
        category: "fix-now",
        docsUrl: "https://docs.openclaw.ai/automation/cron-jobs/gmail",
        severity: "warning",
        path: "hooks.gmail.model",
        message:
          kind === "unresolved"
            ? `hooks.gmail.model "${model}" could not be resolved.`
            : kind === "not-allowed"
              ? `hooks.gmail.model "${model}" is not allowed by agents.defaults.modelPolicy.allow.`
              : `hooks.gmail.model "${model}" is not in the model catalog.`,
        fixHint:
          kind === "not-allowed"
            ? "Add the model or its provider wildcard to agents.defaults.modelPolicy.allow, or remove hooks.gmail.model."
            : "Run `openclaw models list` and set hooks.gmail.model to a configured provider/model, or remove the override to use the agent default.",
      };
      return finding;
    });
  },
};

const legacyStateCheck: CoreHealthCheck = {
  id: "core/doctor/legacy-state",
  description: "Legacy sessions, agent state, and channel auth paths have been migrated.",
  defaultEnabled: false,
  async detect(ctx) {
    const { detectLegacyStateMigrations } = await import("../infra/state-migrations.doctor.js");
    const { prepareLegacySessionSurfaces } = await import("../plugins/legacy-session-surfaces.js");
    const legacySessionSurfaces = prepareLegacySessionSurfaces({ config: ctx.cfg });
    const detected = await detectLegacyStateMigrations({
      cfg: ctx.cfg,
      doctorOnlyStateMigrations: true,
      legacySessionSurfaces,
    });
    return [
      ...detected.preview.map((line): HealthFinding => ({
        checkId: "core/doctor/legacy-state",
        category: "fix-now",
        docsUrl: "https://docs.openclaw.ai/cli/doctor/state-migrations",
        severity: "warning",
        message: line.replace(/^- /, ""),
        path: detected.stateDir,
        fixHint: "Run `openclaw doctor --fix` to migrate legacy state.",
      })),
      ...detected.warnings.map((warning): HealthFinding => ({
        checkId: "core/doctor/legacy-state",
        category: "fix-now",
        docsUrl: "https://docs.openclaw.ai/cli/doctor/state-migrations",
        severity: "warning",
        message: warning,
        path: detected.stateDir,
        fixHint: "Resolve the warning, then rerun `openclaw doctor --fix`.",
      })),
    ];
  },
};

function noteTextToFinding(params: {
  checkId: string;
  severity: HealthFinding["severity"];
  text: string;
  target?: string;
  category?: HealthFinding["category"];
  docsUrl?: string;
}): HealthFinding {
  const lines = params.text.split("\n");
  const first = (lines[0] ?? params.text).replace(/^- /, "").trim();
  const rest = lines.slice(1).join("\n");
  return {
    checkId: params.checkId,
    severity: params.severity,
    ...(params.category ? { category: params.category } : {}),
    ...(params.docsUrl ? { docsUrl: params.docsUrl } : {}),
    message: first,
    ...(params.target ? { target: params.target } : {}),
    ...(rest ? { fixHint: rest } : {}),
  };
}

function inferCapturedNoteSeverity(text: string): HealthFinding["severity"] {
  if (text.includes("CRITICAL")) {
    return "error";
  }
  return [
    "- Fix:",
    "unavailable",
    "not found",
    "missing",
    "not readable",
    "not writable",
    "readonly",
  ].some((marker) => text.includes(marker))
    ? "warning"
    : "info";
}

function createNoteCollector(checkId: string): {
  readonly findings: readonly HealthFinding[];
  readonly noteFn: (message: unknown) => void;
} {
  const findings: HealthFinding[] = [];
  return {
    findings,
    noteFn(message: unknown): void {
      const text = noteMessageToText(message);
      if (!text.trim()) {
        return;
      }
      const severity = inferCapturedNoteSeverity(text);
      if (severity === "info") {
        return;
      }
      findings.push(noteTextToFinding({ checkId, severity, text }));
    },
  };
}

function noteMessageToText(message: unknown): string {
  if (message instanceof Error) {
    return message.message;
  }
  if (message == null) {
    return "";
  }
  if (typeof message === "string") {
    return message;
  }
  if (typeof message === "number" || typeof message === "boolean" || typeof message === "bigint") {
    return String(message);
  }
  try {
    return JSON.stringify(message) ?? "";
  } catch {
    return "";
  }
}

const claudeCliCheck: CoreHealthCheck = {
  id: "core/doctor/claude-cli",
  description: "Claude CLI readiness is captured as structured findings.",
  async detect(ctx) {
    const { noteClaudeCliHealth } = await import("../commands/doctor-claude-cli.js");
    const collector = createNoteCollector("core/doctor/claude-cli");
    noteClaudeCliHealth(ctx.cfg, {
      noteFn: collector.noteFn,
      ...(ctx.cwd ? { workspaceDir: ctx.cwd } : {}),
    });
    return collector.findings;
  },
};

const openAIOAuthTlsCheck: CoreHealthCheck = {
  id: "core/doctor/oauth-tls",
  description: "OpenAI OAuth TLS prerequisites are satisfied before browser auth.",
  async detect(ctx) {
    const {
      formatOpenAIOAuthTlsPreflightFix,
      runOpenAIOAuthTlsPreflight,
      shouldRunOpenAIOAuthTlsPrerequisites,
    } = await import("../plugins/provider-openai-chatgpt-oauth-tls.js");
    if (!shouldRunOpenAIOAuthTlsPrerequisites({ cfg: ctx.cfg, deep: ctx.mode === "doctor" })) {
      return [];
    }
    const result = await runOpenAIOAuthTlsPreflight({ timeoutMs: 4000 });
    if (result.ok || result.kind !== "tls-cert") {
      return [];
    }
    const fix = formatOpenAIOAuthTlsPreflightFix(result);
    return [
      noteTextToFinding({
        checkId: "core/doctor/oauth-tls",
        category: "fix-now",
        docsUrl: "https://docs.openclaw.ai/help/troubleshooting",
        severity: "warning",
        text: fix,
      }),
    ];
  },
};

const legacyWhatsAppCrontabCheck: CoreHealthCheck = {
  id: "core/doctor/legacy-whatsapp-crontab",
  description: "Legacy WhatsApp crontab health entries are detected as structured findings.",
  defaultEnabled: false,
  async detect() {
    const { collectLegacyWhatsAppCrontabHealthWarning } =
      await import("../commands/doctor/cron/index.js");
    const warning = await collectLegacyWhatsAppCrontabHealthWarning();
    if (!warning) {
      return [];
    }
    return [
      noteTextToFinding({
        checkId: "core/doctor/legacy-whatsapp-crontab",
        category: "recommended",
        docsUrl: "https://docs.openclaw.ai/cli/doctor/checks",
        severity: "warning",
        text: warning,
      }),
    ];
  },
};

const legacyCronStoreCheck: CoreHealthCheck = {
  id: "core/doctor/legacy-cron-store",
  description: "Legacy cron store, run-log, and payload state is normalized.",
  defaultEnabled: false,
  async detect(ctx) {
    const { collectLegacyCronStoreHealthFindings } =
      await import("../commands/doctor/cron/index.js");
    return collectLegacyCronStoreHealthFindings({ cfg: ctx.cfg });
  },
};

const staleRuntimeBuildCheck: CoreHealthCheck = {
  id: "core/doctor/stale-runtime-build",
  description: "The loaded runtime was built from the checkout's current commit.",
  async detect() {
    const { collectStaleRuntimeBuildFindings } =
      await import("../commands/doctor-stale-runtime-build.js");
    return collectStaleRuntimeBuildFindings();
  },
};

const codexSessionRoutesCheck: CoreHealthCheck = {
  id: CODEX_SESSION_ROUTES_CHECK_ID,
  description: "Codex runtime routes are compatible with the configured plugin harness.",
  async detect(ctx) {
    const disabledPluginFindings = collectDisabledCodexPluginRouteIssues(ctx.cfg, ctx.env).map(
      (issue): HealthFinding => ({
        checkId: CODEX_SESSION_ROUTES_CHECK_ID,
        severity: "warning",
        message: [
          `${issue.path} routes ${issue.modelRef} to ${issue.canonicalModel}`,
          "with Codex runtime, but the Codex plugin is disabled by config.",
        ].join(" "),
        path: issue.path,
        target: issue.canonicalModel,
        requirement: "Codex plugin enabled for routes that use the Codex runtime.",
        fixHint: issue.repairBlocked
          ? [
              "Enable plugins.entries.codex and plugin loading, and remove codex from plugins.deny;",
              "or set the affected OpenAI models to an OpenClaw runtime policy.",
            ].join(" ")
          : [
              "Run `openclaw doctor --fix`: it enables plugins.entries.codex,",
              "or set the affected OpenAI models to an OpenClaw runtime policy.",
            ].join(" "),
      }),
    );
    const compatibilityFindings = collectCodexRuntimeCompatibilityWarnings(ctx.cfg, ctx.env).map(
      (text) =>
        noteTextToFinding({
          checkId: CODEX_SESSION_ROUTES_CHECK_ID,
          severity: "warning",
          text,
        }),
    );
    return [...disabledPluginFindings, ...compatibilityFindings];
  },
};

const telegramGeneralTopicConversationsCheck: CoreHealthCheck = {
  id: TELEGRAM_GENERAL_TOPIC_CONVERSATIONS_CHECK_ID,
  description: "Telegram General-topic conversation bindings use the chat target.",
  async detect(ctx) {
    const { detectTelegramGeneralTopicConversationRepairs } =
      await import("../commands/doctor-telegram-general-topic-conversations.js");
    const repairs = detectTelegramGeneralTopicConversationRepairs({
      cfg: ctx.cfg,
      ...(ctx.env ? { env: ctx.env } : {}),
    });
    return repairs.map((repair) => ({
      checkId: TELEGRAM_GENERAL_TOPIC_CONVERSATIONS_CHECK_ID,
      category: "fix-now",
      docsUrl: "https://docs.openclaw.ai/channels/telegram",
      severity: "warning" as const,
      message: `Agent ${repair.agentId} has a stale Telegram General-topic conversation identity.`,
      target: repair.agentId,
      requirement: "One chat-scoped conversation binding for Telegram General topic.",
      fixHint: "Run `openclaw doctor --fix` to merge the stale topic-qualified identity.",
    }));
  },
  async repair(ctx) {
    const { repairTelegramGeneralTopicConversations } =
      await import("../commands/doctor-telegram-general-topic-conversations.js");
    const effect = {
      kind: "state" as const,
      action: ctx.dryRun ? "would-merge-stale-bindings" : "merge-stale-bindings",
      target: "Telegram General topic conversations",
      dryRunSafe: false,
    };
    if (ctx.dryRun) {
      return {
        changes: ["Would merge stale Telegram General-topic identities."],
        effects: [effect],
      };
    }
    const repaired = await repairTelegramGeneralTopicConversations({
      cfg: ctx.cfg,
      ...(ctx.env ? { env: ctx.env } : {}),
    });
    return {
      changes: [`Merged ${repaired} stale Telegram General-topic conversation identity row(s).`],
      effects: repaired > 0 ? [effect] : [],
    };
  },
};

const gatewayPlatformNotesCheck: CoreHealthCheck = {
  id: "core/doctor/gateway-services/platform-notes",
  description: "Gateway platform notes are captured as structured findings.",
  async detect(ctx) {
    if (!isDefaultInstallIdentity(process.env)) {
      return [];
    }
    const { collectGatewayPlatformWarnings } = await import("../commands/doctor-platform-notes.js");
    const warnings = await collectGatewayPlatformWarnings(ctx.cfg);
    return warnings.map((warning) =>
      noteTextToFinding({
        checkId: "core/doctor/gateway-services/platform-notes",
        category: "recommended",
        docsUrl: "https://docs.openclaw.ai/cli/doctor/recovery",
        severity: "warning",
        text: warning,
      }),
    );
  },
};

const nodeRuntimeCheck: CoreHealthCheck = {
  id: "core/doctor/node-runtime",
  description:
    "Node SQLite capabilities and version support are represented as structured findings.",
  async detect(ctx) {
    const { collectNodeRuntimeFindings } = await import("../commands/node-runtime-diagnostics.js");
    return collectNodeRuntimeFindings(ctx.env);
  },
};

const browserCheck: CoreHealthCheck = {
  id: "core/doctor/browser",
  description: "Browser readiness is captured as structured findings.",
  async detect(ctx) {
    return await collectBrowserReadinessFindings(ctx.cfg);
  },
};

async function detectSkillsReadiness(
  ctx: DoctorHealthCheckContext,
): Promise<readonly SkillStatusEntry[]> {
  const { runWithPluginMetadataSnapshot } = ctx;
  const detect = async () => {
    if (!ctx.cwd) {
      return [];
    }
    const { detectUnavailableSkills } = await import("./doctor-core-checks.runtime.js");
    return detectUnavailableSkills(ctx.cfg, ctx.cwd);
  };
  if (!runWithPluginMetadataSnapshot) {
    return await detect();
  }
  return await runWithPluginMetadataSnapshot(
    {
      config: ctx.cfg,
      workspaceDir: ctx.cwd,
    },
    detect,
  );
}

const skillsReadinessCheck: CoreHealthCheck = {
  id: "core/doctor/skills-readiness",
  description: "Allowed skills are usable in the current runtime environment.",
  defaultEnabled: false,
  async detect(ctx, scope) {
    const unavailable = filterUnavailableSkillsForScope(
      await detectSkillsReadiness(ctx),
      scope?.paths,
    );
    return unavailable.map(unavailableSkillToFinding);
  },
  async repair(ctx, findings) {
    const unavailable = filterUnavailableSkillsForScope(
      await detectSkillsReadiness(ctx),
      findings.map((finding) => finding.path),
    );
    if (unavailable.length === 0) {
      return { changes: [] };
    }
    const nextConfig = disableUnavailableSkillsInConfig(ctx.cfg, unavailable);
    return {
      config: nextConfig,
      changes: unavailable.map((skill) => `Disabled unavailable skill ${skill.name}.`),
      effects: unavailable.map((skill) => ({
        kind: "config" as const,
        action: ctx.dryRun === true ? "would-disable-skill" : "disable-skill",
        target: skillReadinessPath(skill),
        dryRunSafe: true,
      })),
    };
  },
};

function unavailableSkillToFinding(skill: SkillStatusEntry): HealthFinding {
  return {
    checkId: "core/doctor/skills-readiness",
    category: "recommended",
    docsUrl: "https://docs.openclaw.ai/tools/skills",
    severity: "warning",
    message: `${skill.name} is allowed but unavailable: ${formatMissingSkillSummary(skill)}.`,
    path: skillReadinessPath(skill),
    fixHint:
      "Install/configure the missing requirement, or run `openclaw doctor --fix` to disable unused unavailable skills.",
  };
}

function filterUnavailableSkillsForScope(
  unavailable: readonly SkillStatusEntry[],
  paths: readonly (string | undefined)[] | undefined,
): SkillStatusEntry[] {
  const scopedPaths = new Set(
    paths?.filter((pathLocal): pathLocal is string => pathLocal !== undefined) ?? [],
  );
  if (scopedPaths.size === 0) {
    return [...unavailable];
  }
  return unavailable.filter((skill) => scopedPaths.has(skillReadinessPath(skill)));
}

function skillReadinessPath(skill: SkillStatusEntry): string {
  return `skills.entries.${skill.skillKey}.enabled`;
}

const shellCompletionCheck: CoreHealthCheck = {
  id: "core/doctor/shell-completion",
  description: "Shell completion uses the cached completion path when configured.",
  async detect() {
    return shellCompletionStatusToHealthFindings(await checkShellCompletionStatus());
  },
  repair: legacyOwnedRepair(async () => {
    return shellCompletionStatusToRepairEffects(await checkShellCompletionStatus());
  }, "legacy doctor shell-completion repair owns real mutations"),
};

const uiProtocolFreshnessCheck: CoreHealthCheck = {
  id: "core/doctor/ui-protocol-freshness",
  description: "Control UI assets are present and current with the Gateway protocol schema.",
  async detect() {
    return (await detectUiProtocolFreshnessIssues()).map(uiProtocolFreshnessIssueToHealthFinding);
  },
  repair: legacyOwnedRepair(async () => {
    return (await detectUiProtocolFreshnessIssues()).flatMap(
      uiProtocolFreshnessIssueToRepairEffects,
    );
  }, "legacy doctor UI freshness repair owns real mutations"),
};

const workspaceSuggestionsCheck: CoreHealthCheck = {
  id: "core/doctor/workspace-suggestions",
  description:
    "Workspace backup and memory-system suggestions are captured as structured findings.",
  defaultEnabled: false,
  async detect(ctx) {
    const scopes = resolveDoctorWorkspaceSuggestionScopes(ctx.cfg);
    const { collectWorkspaceSuggestionNotes } =
      await import("../commands/doctor-workspace-suggestions.js");
    const findings = await Promise.all(
      scopes.map(async ({ agentId, workspaceDir, labelAgent }) => {
        const prefix = labelAgent ? `Agent "${agentId}": ` : "";
        const notes: string[] = [];
        for await (const text of collectWorkspaceSuggestionNotes(workspaceDir)) {
          notes.push(text);
        }
        return notes.map((text) =>
          noteTextToFinding({
            checkId: "core/doctor/workspace-suggestions",
            category: "recommended",
            docsUrl: "https://docs.openclaw.ai/concepts/agent-workspace",
            severity: "info",
            text: `${prefix}${text}`,
            ...(labelAgent ? { target: agentId } : {}),
          }),
        );
      }),
    );
    return findings.flat();
  },
};

export function createCoreHealthChecks(): readonly DoctorHealthCheck[] {
  const checks: readonly CoreHealthCheck[] = [
    gatewayConfigCheck,
    claudeCliCheck,
    gatewayAuthCheck,
    legacyStateCheck,
    removedWorkspacesStateCheck,
    legacyWhatsAppCrontabCheck,
    legacyCronStoreCheck,
    staleRuntimeBuildCheck,
    codexSessionRoutesCheck,
    telegramGeneralTopicConversationsCheck,
    shellCompletionCheck,
    uiProtocolFreshnessCheck,
    gatewayServicesExtraCheck,
    gatewayPlatformNotesCheck,
    {
      id: GATEWAY_HEALTH_CHECK_ID,
      description:
        "Authenticated Gateway health and degraded secret owners are structured findings.",
      defaultEnabled: false,
      async detect(ctx) {
        const { collectGatewayHealthFindings } =
          await import("../commands/doctor-gateway-health.js");
        return collectGatewayHealthFindings(ctx);
      },
    },
    {
      id: GATEWAY_DAEMON_CHECK_ID,
      description: "Local Gateway daemon service state is represented as structured findings.",
      defaultEnabled: false,
      async detect(ctx) {
        const { collectGatewayDaemonFindings } = await import("./doctor-core-checks.runtime.js");
        return collectGatewayDaemonFindings(ctx);
      },
    },
    nodeRuntimeCheck,
    {
      id: "core/doctor/security",
      updateReadiness: "post-plugin",
      description: "Security posture checks produce structured findings.",
      async detect(ctx) {
        const { collectSecurityWarnings } = await import("../commands/doctor-security.js");
        const findings = await collectSecurityWarnings(ctx.cfg, ctx.env);
        return findings.map(securityAuditFindingToHealthFinding);
      },
    },
    browserCheck,
    openAIOAuthTlsCheck,
    hooksModelCheck,
    bootstrapSizeCheck,
    createModelReferenceCheck(),
    createAcpAgentModelCheck(),
    {
      id: "core/doctor/provider-catalog-projection",
      description: "Provider catalog hooks project into unified text model catalog rows.",
      async detect(ctx) {
        const { collectProviderCatalogProjectionFindings } =
          await import("./doctor-core-checks.runtime.js");
        return collectProviderCatalogProjectionFindings(ctx.cfg, ctx.cwd);
      },
    },
    {
      id: "core/doctor/local-audio-acceleration",
      description: "Local STT auto-selection and acceleration evidence are visible.",
      async detect() {
        const { collectLocalAudioAccelerationFindings } =
          await import("./doctor-core-checks.runtime.js");
        return collectLocalAudioAccelerationFindings();
      },
    },
    createRuntimeToolSchemaCheck({
      collectRuntimeToolSchemaFindings: collectRuntimeToolSchemaFindingsWithRuntime,
    }),
    workspaceSuggestionsCheck,
    skillWorkshopToolPolicyCheck,
    ...(isExperimentalClawsEnabled()
      ? [
          {
            id: "core/doctor/claws-state",
            description: "Claw lifecycle ownership and managed resources are consistent.",
            defaultEnabled: false as const,
            async detect(ctx: HealthCheckContext) {
              const [{ collectClawStateHealthFindings }, { listConfiguredMcpServers }] =
                await Promise.all([
                  import("../claws/doctor.js"),
                  import("../config/mcp-config.js"),
                ]);
              return await collectClawStateHealthFindings({
                cfg: ctx.cfg,
                env: process.env,
                listMcpServers: listConfiguredMcpServers,
                cronGateway: {
                  list: () => listGatewayCronJobsWithRuntime(ctx),
                },
              });
            },
          },
        ]
      : []),
    commandOwnerCheck,
    skillsReadinessCheck,
    finalConfigValidationCheck,
  ];
  return checks.map((check): DoctorHealthCheck =>
    Object.assign({}, check, { kind: "core" as const, source: "doctor" }),
  );
}

export const CORE_HEALTH_CHECKS: readonly DoctorHealthCheck[] = createCoreHealthChecks();
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
