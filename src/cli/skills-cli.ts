import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type {
  SkillsWorkshopChangeResult,
  SkillsWorkshopChangesResult,
  SkillsWorkshopListResult,
  SkillsWorkshopReadResult,
} from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  resolveConfiguredAgentId,
  resolveAgentIdByWorkspacePath,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveGatewayPort } from "../config/paths.js";
import { CLAWHUB_TRUST_ERROR_CODE } from "../infra/clawhub-install-trust.js";
import {
  CLAWHUB_SKILLS_SH_REF_PREFIX,
  CLAWHUB_SKILLS_SH_TRUST_LABEL,
  fetchClawHubSkillCard,
  type ClawHubSkillVerificationResponse,
} from "../infra/clawhub-skills.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime } from "../runtime.js";
import { resolveSkillStatusEntry, type SkillStatusReport } from "../skills/discovery/status.js";
import {
  installSkillFromClawHub,
  readVerifiedClawHubSkillSourceUrl,
  readTrackedClawHubSkillSlugs,
  resolveClawHubSkillVerificationTarget,
  updateSkillsFromClawHub,
  verifySkillWithClawHub,
} from "../skills/lifecycle/clawhub.js";
import {
  installSkillFromSource,
  isSkillSourceInstallSpec,
} from "../skills/lifecycle/source-install.js";
import {
  archiveWorkshopSkill,
  listWorkshopChanges,
  restoreWorkshopSkill,
  viewWorkshopSkill,
} from "../skills/workshop/library.js";
import { buildSkillsWorkshopListResult } from "../skills/workshop/workshop-list.js";
import { CONFIG_DIR } from "../utils.js";
import { resolveClawHubInstallConfirmation } from "./clawhub-install-confirmation.js";
import { resolveOptionFromCommand, runCommandWithRuntime } from "./cli-utils.js";
import { formatCliCommand } from "./command-format.js";
import { formatCliJsonFailure } from "./failure-output.js";
import { canFallbackToImplicitLocalGateway } from "./gateway-rpc.js";
import { formatDocsHelp } from "./help-format.js";
import { resolveInstallPolicyWarningAcknowledgementCliOptions } from "./install-policy-warning-acknowledgement.js";
import { exitCliAfterOutput } from "./one-shot-exit.js";
import { parseStrictPositiveIntOption } from "./program/helpers.js";
import { setCommandJsonMode } from "./program/json-mode.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";
import {
  formatSkillInfo,
  formatSkillsCheck,
  formatSkillsList,
  formatSkillsWorkshopChanges,
  formatSkillsWorkshopList,
} from "./skills-cli.format.js";
import { registerSkillsLibraryCli } from "./skills-library-cli.js";
import { isSkillsMachineOutput } from "./skills-output-mode.js";
import { registerSkillsSearchCli } from "./skills-search-cli.js";

type ResolvedClawHubSkillVerificationTarget = Extract<
  Awaited<ReturnType<typeof resolveClawHubSkillVerificationTarget>>,
  { ok: true }
>;

const skillInstallLogger = {
  info: (message: string) => defaultRuntime.log(message),
  warn: (message: string) =>
    defaultRuntime.log(message.includes("╭─") ? message : theme.warn(message)),
};

function isClawHubSkillBlockedCliFailure(result: { code?: string; warning?: string }): boolean {
  return (
    result.code === CLAWHUB_TRUST_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED &&
    typeof result.warning === "string" &&
    result.warning.trim().length > 0
  );
}

type ResolveSkillsWorkspaceOptions = {
  agentId?: string;
  skipPluginValidation?: boolean;
};

type ResolvedSkillsWorkspace = ReturnType<typeof resolveSkillsWorkspace>;

const GATEWAY_SKILLS_STATUS_TIMEOUT_MS = 1_500;
const GATEWAY_SKILLS_OFFLINE_LOCK_TIMEOUT_MS = 250;
const GATEWAY_SKILLS_WORKSHOP_MUTATION_TIMEOUT_MS = 30_000;

async function callSkillsGateway<T>(params: {
  config: ResolvedSkillsWorkspace["config"];
  method: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<T> {
  const { callGateway } = await import("../gateway/call.js");
  return await callGateway<T>({
    timeoutMs: GATEWAY_SKILLS_STATUS_TIMEOUT_MS,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
    ...params,
  });
}

function normalizeExplicitAgentId(agentId?: string): string | undefined {
  const normalizedAgentId = agentId?.trim();
  if (agentId !== undefined && !normalizedAgentId) {
    throw new Error("--agent must not be blank");
  }
  return normalizedAgentId;
}

function resolveSkillsWorkspace(options?: ResolveSkillsWorkspaceOptions) {
  // Prefer explicit --agent, then infer from cwd, then fall back to configured default agent.
  const config = getRuntimeConfig(
    options?.skipPluginValidation ? { skipPluginValidation: true } : undefined,
  );
  const explicitAgentId = normalizeExplicitAgentId(options?.agentId);
  const inferredAgentId = explicitAgentId
    ? undefined
    : resolveAgentIdByWorkspacePath(config, process.cwd());
  const agentId = explicitAgentId
    ? resolveConfiguredAgentId(config, explicitAgentId)
    : (inferredAgentId ??
      resolveDefaultAgentId(config, { surface: "the skills command", hint: "Pass --agent <id>." }));
  return {
    config,
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(config, agentId),
  };
}

async function loadSkillsStatusReport(agentId: string | undefined): Promise<SkillStatusReport> {
  const resolved = resolveSkillsWorkspace({ agentId, skipPluginValidation: true });
  try {
    return await callSkillsGateway<SkillStatusReport>({
      config: resolved.config,
      method: "skills.status",
      params: { agentId: resolved.agentId },
    });
  } catch (error) {
    if (
      !(await canFallbackToImplicitLocalGateway({
        config: resolved.config,
        error,
        legacyMethod: "skills.status",
        legacyAgentId: true,
      }))
    ) {
      throw error;
    }
    const { prepareWorkspaceSkillStatus } = await import("../skills/discovery/status.js");
    return prepareWorkspaceSkillStatus(resolved.workspaceDir, {
      config: resolved.config,
      agentId: resolved.agentId,
    }).then(({ report }) => report);
  }
}

async function runSkillsAction(
  render: (report: SkillStatusReport) => string,
  agentId: string | undefined,
): Promise<void> {
  await runCommandWithRuntime(defaultRuntime, async () => {
    const report = await loadSkillsStatusReport(agentId);
    defaultRuntime.writeStdout(render(report));
  });
}

function resolveClawHubTargetWorkspace(
  command: Command,
  opts: { global?: boolean },
  reportError: (message: string) => void = defaultRuntime.error,
): Pick<ResolvedSkillsWorkspace, "config" | "workspaceDir"> | undefined {
  const agentId = normalizeExplicitAgentId(resolveOptionFromCommand<string>(command, "agent"));
  if (opts.global && agentId) {
    reportError("Use either --global or --agent, not both.");
    defaultRuntime.exit(1);
    return undefined;
  }
  if (opts.global) {
    return { config: getRuntimeConfig(), workspaceDir: CONFIG_DIR };
  }
  return resolveSkillsWorkspace({ agentId });
}

function shouldFailSkillVerification(result: ClawHubSkillVerificationResponse): boolean {
  const envelope = result as { ok: unknown; decision: unknown };
  return envelope.ok !== true || envelope.decision !== "pass";
}

function buildSkillVerificationOutput(
  result: ClawHubSkillVerificationResponse,
  target: ResolvedClawHubSkillVerificationTarget,
): Record<string, unknown> {
  const verifiedSourceUrl = readVerifiedClawHubSkillSourceUrl(result.provenance);
  return {
    ...result,
    openclaw: {
      resolution: {
        source: target.resolution.source,
        selector: target.resolution.selector,
        registry: target.resolution.registry,
        installedVersion: target.resolution.installedVersion,
        ...(target.requestedReference ? { reference: target.requestedReference } : {}),
      },
      ...(target.trustState
        ? {
            trust: {
              state: target.trustState,
              label: CLAWHUB_SKILLS_SH_TRUST_LABEL,
            },
          }
        : {}),
      ...(verifiedSourceUrl ? { verifiedSourceUrl } : {}),
    },
  };
}

function readVerifiedSkillCardUrl(
  result: ClawHubSkillVerificationResponse,
): { ok: true; url: string } | { ok: false; error: string } {
  if (!result.card || typeof result.card !== "object" || Array.isArray(result.card)) {
    return { ok: false, error: "ClawHub verification response did not include a Skill Card URL." };
  }
  const card = result.card as { available?: unknown; url?: unknown };
  if (card.available === false) {
    return { ok: false, error: "Skill Card is not available." };
  }
  const url = normalizeOptionalString(card.url);
  if (!url) {
    return { ok: false, error: "ClawHub verification response did not include a Skill Card URL." };
  }
  return { ok: true, url };
}

async function callSkillsWorkshop<T>(
  resolved: ResolvedSkillsWorkspace,
  method: "list" | "changes" | "read" | "archive" | "restore",
  params: Record<string, unknown>,
  loadLocal: () => Promise<T>,
): Promise<T> {
  const request = {
    config: resolved.config,
    method: `skills.workshop.${method}`,
    params: { agentId: resolved.agentId, ...params },
  };
  if (method === "archive" || method === "restore") {
    // A dispatched mutation may already have committed, so choose the route before sending
    // and never replay it locally: run here only while no Gateway owns the state lock.
    const { isImplicitLocalGatewayTarget } = await import("../gateway/call.js");
    const { acquireGatewayLock } = await import("../infra/gateway-lock.js");
    const lock = (await isImplicitLocalGatewayTarget({ config: resolved.config }))
      ? await acquireGatewayLock({
          allowInTests: true,
          port: resolveGatewayPort(resolved.config, process.env),
          role: "sqlite-maintenance",
          timeoutMs: GATEWAY_SKILLS_OFFLINE_LOCK_TIMEOUT_MS,
        }).catch(() => undefined)
      : undefined;
    if (!lock) {
      return await callSkillsGateway<T>({
        ...request,
        timeoutMs: GATEWAY_SKILLS_WORKSHOP_MUTATION_TIMEOUT_MS,
      });
    }
    try {
      return await lock.run(loadLocal);
    } finally {
      await lock.release();
    }
  }
  try {
    return await callSkillsGateway<T>(request);
  } catch (error) {
    if (!(await canFallbackToImplicitLocalGateway({ config: resolved.config, error }))) {
      throw error;
    }
    return await loadLocal();
  }
}

export function registerSkillsCli(program: Command) {
  const skills = program
    .command("skills")
    .description("List and inspect available skills")
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .option("--json", "Output as JSON", false)
    .addHelpText("after", () => formatDocsHelp("/cli/skills"));
  const hasJsonOutput = (opts?: { json?: boolean }): boolean =>
    Boolean(opts?.json || skills.opts<{ json?: boolean }>().json);
  const reportAction =
    (format: typeof formatSkillsList) =>
    (opts: Parameters<typeof formatSkillsList>[1], command: Command) =>
      runSkillsAction(
        (report) => format(report, { ...opts, json: hasJsonOutput(opts) }),
        resolveOptionFromCommand<string>(command, "agent"),
      );
  const runSkillsList = reportAction(formatSkillsList);
  setCommandJsonMode(skills, "output", ({ argv, command }) => isSkillsMachineOutput(argv, command));
  registerSkillsLibraryCli(skills);

  registerSkillsSearchCli(skills);

  skills
    .command("install")
    .description("Install a skill from ClawHub, git, or a local directory")
    .argument(
      "<skill-ref>",
      "ClawHub skill ref (@owner/slug or skills-sh:owner/repo/slug), git:<repo>, or local skill directory",
    )
    .option("--version <version>", "Install a specific version")
    .option("--force", "Overwrite an existing workspace skill", false)
    .option(
      "--force-install",
      "Install a pending GitHub-backed skill before ClawHub scan completes",
      false,
    )
    .option(
      "--acknowledge-install-policy-warning",
      "Acknowledge security.installPolicy warnings without prompting; blocks and failures remain terminal",
      false,
    )
    .option("--global", "Install into the shared managed skills directory", false)
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .option("--as <slug>", "Install a git/local skill under this slug")
    .addHelpText(
      "after",
      "\nExamples:\n  openclaw skills install @owner/weather\n  openclaw skills install skills-sh:owner/repo/weather\n",
    )
    .action(
      async (
        slug: string,
        opts: {
          version?: string;
          force?: boolean;
          forceInstall?: boolean;
          acknowledgeInstallPolicyWarning?: boolean;
          global?: boolean;
          agent?: string;
          as?: string;
        },
        command: Command,
      ) => {
        try {
          const target = resolveClawHubTargetWorkspace(command, opts);
          if (!target) {
            return;
          }
          const { config, workspaceDir } = target;
          if (slug.trim().startsWith("skills-sh/")) {
            defaultRuntime.error(`Invalid skills.sh skill reference: ${slug}`);
            defaultRuntime.exit(1);
            return;
          }
          if (isSkillSourceInstallSpec(slug)) {
            const clawHubOnlyOption = [
              opts.version && "--version",
              opts.forceInstall && "--force-install",
            ].find(Boolean);
            if (clawHubOnlyOption) {
              defaultRuntime.error(
                `${clawHubOnlyOption} is only supported for ClawHub skill installs.`,
              );
              defaultRuntime.exit(1);
              return;
            }
            const result = await installSkillFromSource({
              workspaceDir,
              spec: slug,
              slug: opts.as,
              force: Boolean(opts.force),
              config,
              ...resolveInstallPolicyWarningAcknowledgementCliOptions({
                acknowledgeInstallPolicyWarning: opts.acknowledgeInstallPolicyWarning,
              }),
              logger: skillInstallLogger,
            });
            if (!result.ok) {
              defaultRuntime.error(result.error);
              defaultRuntime.exit(1);
              return;
            }
            defaultRuntime.log(
              `Installed ${result.slug} from ${result.source} -> ${result.targetDir}`,
            );
            return;
          }
          if (opts.as) {
            defaultRuntime.error(
              "--as is only supported for git and local directory skill installs.",
            );
            defaultRuntime.exit(1);
            return;
          }
          if (slug.trim().startsWith(CLAWHUB_SKILLS_SH_REF_PREFIX) && opts.version) {
            defaultRuntime.error("--version is not supported for skills-sh references.");
            defaultRuntime.exit(1);
            return;
          }
          const result = await installSkillFromClawHub({
            workspaceDir,
            slug,
            version: opts.version,
            force: Boolean(opts.force),
            config,
            ...resolveInstallPolicyWarningAcknowledgementCliOptions({
              acknowledgeInstallPolicyWarning: opts.acknowledgeInstallPolicyWarning,
            }),
            ...(opts.forceInstall ? { forceInstall: true } : {}),
            confirmInstall: resolveClawHubInstallConfirmation(),
            logger: skillInstallLogger,
          });
          if (!result.ok) {
            if (!isClawHubSkillBlockedCliFailure(result)) {
              defaultRuntime.error(result.error);
            }
            defaultRuntime.exit(1);
            return;
          }
          defaultRuntime.log(`Installed ${result.slug}@${result.version} -> ${result.targetDir}`);
        } catch (err) {
          defaultRuntime.error(formatErrorMessage(err));
          defaultRuntime.exit(1);
        }
      },
    );

  skills
    .command("update")
    .description("Update ClawHub-installed skills in the active or shared managed directory")
    .argument("[skill-ref]", "Single ClawHub skill ref (@owner/slug)")
    .option("--all", "Update all tracked ClawHub skills", false)
    .option("--force", "Replace installed skills even when they have local changes", false)
    .option(
      "--force-install",
      "Install a pending GitHub-backed skill before ClawHub scan completes",
      false,
    )
    .option(
      "--acknowledge-install-policy-warning",
      "Acknowledge security.installPolicy warnings without prompting; blocks and failures remain terminal",
      false,
    )
    .option("--global", "Update skills in the shared managed skills directory", false)
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .action(
      async (
        slug: string | undefined,
        opts: {
          all?: boolean;
          force?: boolean;
          forceInstall?: boolean;
          acknowledgeInstallPolicyWarning?: boolean;
          global?: boolean;
          agent?: string;
        },
        command: Command,
      ) => {
        try {
          if (!slug && !opts.all) {
            defaultRuntime.error("Provide a skill slug or use --all.");
            defaultRuntime.exit(1);
            return;
          }
          if (slug && opts.all) {
            defaultRuntime.error("Use either a skill slug or --all.");
            defaultRuntime.exit(1);
            return;
          }
          const target = resolveClawHubTargetWorkspace(command, opts);
          if (!target) {
            return;
          }
          const tracked = await readTrackedClawHubSkillSlugs(target.workspaceDir);
          if (opts.all && tracked.length === 0) {
            defaultRuntime.log("No tracked ClawHub skills to update.");
            return;
          }
          const results = await updateSkillsFromClawHub({
            workspaceDir: target.workspaceDir,
            slug,
            ...(opts.force ? { force: true } : {}),
            ...(opts.forceInstall ? { forceInstall: true } : {}),
            ...resolveInstallPolicyWarningAcknowledgementCliOptions({
              acknowledgeInstallPolicyWarning: opts.acknowledgeInstallPolicyWarning,
            }),
            logger: skillInstallLogger,
            config: target.config,
          });
          let failed = false;
          for (const result of results) {
            if (!result.ok) {
              failed = true;
              if (result.code === "force_required") {
                defaultRuntime.error(`${result.error} Re-run with --force to update it anyway.`);
              } else if (!isClawHubSkillBlockedCliFailure(result)) {
                defaultRuntime.error(result.error);
              }
              continue;
            }
            if (result.changed) {
              defaultRuntime.log(
                `Updated ${result.slug}: ${result.previousVersion ?? "unknown"} -> ${result.version}`,
              );
              continue;
            }
            defaultRuntime.log(`${result.slug} already at ${result.version}`);
          }
          if (failed) {
            defaultRuntime.exit(1);
          }
        } catch (err) {
          defaultRuntime.error(formatErrorMessage(err));
          defaultRuntime.exit(1);
        }
      },
    );

  skills
    .command("verify")
    .description("Verify a ClawHub skill with ClawHub")
    .argument("<skill-ref>", "ClawHub skill ref (@owner/slug)")
    .option("--version <version>", "Verify a specific version")
    .option("--tag <tag>", "Verify a dist tag")
    .option("--card", "Print the generated Skill Card Markdown", false)
    .option("--json", "Output as JSON", false)
    .option(
      "--global",
      "Resolve installed skill metadata from the shared managed skills directory",
      false,
    )
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .addHelpText("after", "\nExamples:\n  openclaw skills verify @owner/weather\n")
    .action(
      async (
        slug: string,
        opts: {
          version?: string;
          tag?: string;
          card?: boolean;
          json?: boolean;
          global?: boolean;
          agent?: string;
        },
        command: Command,
      ) => {
        let exitCode: number | undefined;
        const reportError =
          hasJsonOutput(opts) || opts.card !== true
            ? (message: string) => defaultRuntime.writeJson(formatCliJsonFailure(message))
            : defaultRuntime.error;
        try {
          const workspace = resolveClawHubTargetWorkspace(command, opts, reportError);
          if (!workspace) {
            return;
          }
          const target = await resolveClawHubSkillVerificationTarget({
            workspaceDir: workspace.workspaceDir,
            slug,
            version: opts.version,
            tag: opts.tag,
          });
          if (!target.ok) {
            reportError(target.error);
            exitCode = 1;
          } else {
            const result = await verifySkillWithClawHub({
              slug: target.slug,
              ...(target.ownerHandle ? { ownerHandle: target.ownerHandle } : {}),
              ...(target.requestedReference
                ? { requestedReference: target.requestedReference }
                : {}),
              version: target.version,
              tag: target.tag,
              baseUrl: target.baseUrl,
            });
            if (!result.ok) {
              reportError(result.error);
              exitCode = 1;
            } else if (opts.card && !hasJsonOutput(opts)) {
              const verification = result.value;
              const cardUrl = readVerifiedSkillCardUrl(verification);
              if (!cardUrl.ok) {
                reportError(cardUrl.error);
                exitCode = 1;
              } else {
                const card = await fetchClawHubSkillCard({
                  url: cardUrl.url,
                  baseUrl: target.baseUrl,
                });
                defaultRuntime.writeStdout(card.endsWith("\n") ? card : `${card}\n`);
                exitCode = shouldFailSkillVerification(verification) ? 1 : undefined;
              }
            } else {
              const verification = result.value;
              defaultRuntime.writeJson(buildSkillVerificationOutput(verification, target));
              exitCode = shouldFailSkillVerification(verification) ? 1 : undefined;
            }
          }
        } catch (err) {
          reportError(formatErrorMessage(err));
          exitCode = 1;
        }
        if (exitCode) {
          exitCliAfterOutput(defaultRuntime, exitCode);
        }
      },
    );

  const workshop = skills
    .command("workshop")
    .description("Inspect, archive, and restore learned Workshop skills")
    .option("--agent <id>", "Target agent (defaults to cwd-inferred, then default agent)");

  const runWorkshopAction = async <T>(
    opts: { agent?: string; json?: boolean },
    command: Command,
    action: (resolved: ResolvedSkillsWorkspace) => Promise<T>,
    format: (result: T) => string,
  ): Promise<void> => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      const result = await action(
        resolveSkillsWorkspace({ agentId: resolveOptionFromCommand<string>(command, "agent") }),
      );
      if (hasJsonOutput(opts)) {
        defaultRuntime.writeJson(result);
        return;
      }
      defaultRuntime.writeStdout(format(result));
    });
  };

  workshop
    .command("list")
    .description("List learned skills and archived skills")
    .option("--json", "Output as JSON", false)
    .action((opts: { json?: boolean; agent?: string }, command: Command) =>
      runWorkshopAction(
        opts,
        command,
        (resolved) =>
          callSkillsWorkshop<SkillsWorkshopListResult>(resolved, "list", {}, () =>
            buildSkillsWorkshopListResult(resolved),
          ),
        formatSkillsWorkshopList,
      ),
    );

  workshop
    .command("changes")
    .description("Show recent learned-skill changes")
    .option("--limit <n>", "Max changes", (value) => parseStrictPositiveIntOption(value, "--limit"))
    .option("--json", "Output as JSON", false)
    .action((opts: { limit?: number; json?: boolean; agent?: string }, command: Command) =>
      runWorkshopAction(
        opts,
        command,
        (resolved) =>
          callSkillsWorkshop<SkillsWorkshopChangesResult>(
            resolved,
            "changes",
            opts.limit === undefined ? {} : { limit: opts.limit },
            async () => ({
              changes: await listWorkshopChanges(resolved.agentId, { limit: opts.limit }),
            }),
          ),
        formatSkillsWorkshopChanges,
      ),
    );

  workshop
    .command("show")
    .description("Print a learned skill file")
    .argument("<name>", "Skill name")
    .option("--file <path>", "Skill file to print (default SKILL.md)")
    .option("--version <id>", "Print a saved version instead of the live skill")
    .option("--json", "Output as JSON", false)
    .action(
      (
        name: string,
        opts: { file?: string; version?: string; json?: boolean; agent?: string },
        command: Command,
      ) =>
        runWorkshopAction(
          opts,
          command,
          (resolved) =>
            callSkillsWorkshop<SkillsWorkshopReadResult>(
              resolved,
              "read",
              {
                name,
                ...(opts.file ? { filePath: opts.file } : {}),
                ...(opts.version ? { versionId: opts.version } : {}),
              },
              () =>
                viewWorkshopSkill(resolved.config, resolved.agentId, name, opts.file, opts.version),
            ),
          (skill) => (skill.content.endsWith("\n") ? skill.content : `${skill.content}\n`),
        ),
    );

  workshop
    .command("archive")
    .description("Archive a learned skill so its agent no longer sees it")
    .argument("<name>", "Skill name")
    .option("--reason <text>", "Why the skill is archived")
    .option("--json", "Output as JSON", false)
    .action(
      (name: string, opts: { reason?: string; json?: boolean; agent?: string }, command: Command) =>
        runWorkshopAction(
          opts,
          command,
          (resolved) =>
            callSkillsWorkshop<SkillsWorkshopChangeResult>(
              resolved,
              "archive",
              { name, ...(opts.reason ? { reason: opts.reason } : {}) },
              async () => ({
                change: await archiveWorkshopSkill(
                  { config: resolved.config, agentId: resolved.agentId, actor: "user" },
                  { name, reason: opts.reason },
                ),
              }),
            ),
          ({ change }) =>
            `Archived ${change.skillName}. Undo with: ${formatCliCommand(`openclaw skills workshop restore ${change.skillName}`)}\n`,
        ),
    );

  workshop
    .command("restore")
    .description("Restore an archived skill or a saved version")
    .argument("<name>", "Skill name")
    .option("--version <id>", "Version to restore (default newest)")
    .option("--json", "Output as JSON", false)
    .action(
      (
        name: string,
        opts: { version?: string; json?: boolean; agent?: string },
        command: Command,
      ) =>
        runWorkshopAction(
          opts,
          command,
          (resolved) =>
            callSkillsWorkshop<SkillsWorkshopChangeResult>(
              resolved,
              "restore",
              { name, ...(opts.version ? { versionId: opts.version } : {}) },
              async () => ({
                change: await restoreWorkshopSkill(
                  { config: resolved.config, agentId: resolved.agentId, actor: "user" },
                  { name, versionId: opts.version },
                ),
              }),
            ),
          ({ change }) => `Restored ${change.skillName}.\n`,
        ),
    );

  for (const command of workshop.commands) {
    command.option("--agent <id>", "Target agent (defaults to cwd-inferred, then default agent)");
  }
  applyParentDefaultHelpAction(workshop);

  skills
    .command("list")
    .description("List all available skills")
    .option("--json", "Output as JSON", false)
    .option("--eligible", "Show only eligible (ready to use) skills", false)
    .option("-v, --verbose", "Show more details including missing requirements", false)
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .action(runSkillsList);

  skills
    .command("info")
    .description("Show detailed information about a skill")
    .argument("<name>", "Skill name")
    .option("--json", "Output as JSON", false)
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .action(async (name: string, opts: { json?: boolean; agent?: string }, command: Command) => {
      let skillFound = false;
      await runSkillsAction(
        (report) => {
          skillFound = resolveSkillStatusEntry(report.skills, name) !== null;
          return formatSkillInfo(report, name, {
            ...opts,
            json: hasJsonOutput(opts),
          });
        },
        resolveOptionFromCommand<string>(command, "agent"),
      );
      if (!skillFound) {
        defaultRuntime.exit(1);
      }
    });

  skills
    .command("check")
    .description("Check which skills are ready, visible, or missing requirements")
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .option("--json", "Output as JSON", false)
    .action(reportAction(formatSkillsCheck));

  skills.action(runSkillsList);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
