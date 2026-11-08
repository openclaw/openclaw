import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { listAgentIds } from "../agents/agent-scope.js";
import { captureRuntimeConfigAsyncReader } from "../config/config.js";
import { CLAWHUB_TRUST_ERROR_CODE } from "../infra/clawhub-install-trust.js";
import {
  CLAWHUB_SKILLS_SH_REF_PREFIX,
  fetchClawHubSkillCard,
  type ClawHubSkillVerificationResponse,
} from "../infra/clawhub-skills.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { resolveSkillStatusEntry, type SkillStatusReport } from "../skills/discovery/status.js";
import {
  installSkillFromClawHub,
  readTrackedClawHubSkillSlugs,
  resolveClawHubSkillVerificationTarget,
  updateSkillsFromClawHub,
  verifySkillWithClawHub,
} from "../skills/lifecycle/clawhub.js";
import {
  installSkillFromSource,
  isSkillSourceInstallSpec,
} from "../skills/lifecycle/source-install.js";
import { CONFIG_DIR } from "../utils.js";
import { resolveClawHubInstallConfirmation } from "./clawhub-install-confirmation.js";
import { resolveOptionFromCommand, runCommandWithRuntime } from "./cli-utils.js";
import { formatCliJsonFailure } from "./failure-output.js";
import { canFallbackToImplicitLocalGateway } from "./gateway-rpc.js";
import { formatDocsHelp } from "./help-format.js";
import { resolveInstallPolicyWarningAcknowledgementCliOptions } from "./install-policy-warning-acknowledgement.js";
import { exitCliAfterOutput } from "./one-shot-exit.js";
import { setCommandJsonMode } from "./program/json-mode.js";
import {
  callSkillsGateway,
  normalizeExplicitAgentId,
  resolveSkillsWorkspace,
  type ResolvedSkillsWorkspace,
} from "./skills-cli-gateway.js";
import { buildSkillVerificationOutput } from "./skills-cli-verification-output.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";
import { registerSkillsLibraryCli } from "./skills-library-cli.js";
import { isSkillsMachineOutput } from "./skills-output-mode.js";
import { registerSkillsSearchCli } from "./skills-search-cli.js";

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

const GATEWAY_SKILLS_REFRESH_TIMEOUT_MS = 120_000;

async function refreshLocalGatewaySkills(
  target: Pick<ResolvedSkillsWorkspace, "config"> & { agentId?: string },
): Promise<void> {
  try {
    const { isImplicitLocalGatewayTarget } = await import("../gateway/call.js");
    if (!(await isImplicitLocalGatewayTarget({ config: target.config }))) {
      return;
    }
    const agentId = target.agentId ?? listAgentIds(target.config)[0];
    if (!agentId) {
      return;
    }
    await callSkillsGateway({
      config: target.config,
      method: "skills.status",
      params: { agentId, refresh: true },
      timeoutMs: GATEWAY_SKILLS_REFRESH_TIMEOUT_MS,
    });
  } catch (error) {
    skillInstallLogger.warn(
      `Skill files changed, but local Gateway refresh failed: ${formatErrorMessage(error)}. Restart the Gateway to refresh skills.`,
    );
  }
}

async function loadSkillsStatusReport(agentId: string | undefined): Promise<SkillStatusReport> {
  const resolved = await resolveSkillsWorkspace({ agentId, bestEffort: true });
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

async function resolveClawHubTargetWorkspace(
  command: Command,
  opts: { global?: boolean },
  reportError: (message: string) => void = defaultRuntime.error,
): Promise<
  (Pick<ResolvedSkillsWorkspace, "config" | "workspaceDir"> & { agentId?: string }) | undefined
> {
  const agentId = normalizeExplicitAgentId(resolveOptionFromCommand<string>(command, "agent"));
  if (opts.global && agentId) {
    reportError("Use either --global or --agent, not both.");
    defaultRuntime.exit(1);
    return undefined;
  }
  if (opts.global) {
    return { config: await captureRuntimeConfigAsyncReader()(), workspaceDir: CONFIG_DIR };
  }
  return resolveSkillsWorkspace({ agentId });
}

function shouldFailSkillVerification(result: ClawHubSkillVerificationResponse): boolean {
  const envelope = result as { ok: unknown; decision: unknown };
  return envelope.ok !== true || envelope.decision !== "pass";
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

export async function registerSkillsCli(program: Command, argv: readonly string[] = process.argv) {
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
  setCommandJsonMode(skills, "output", ({ argv: commandArgv, command }) =>
    isSkillsMachineOutput(commandArgv, command),
  );
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
          const target = await resolveClawHubTargetWorkspace(command, opts);
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
            await refreshLocalGatewaySkills(target);
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
          await refreshLocalGatewaySkills(target);
          defaultRuntime.log(`Installed ${result.slug}@${result.version} -> ${result.targetDir}`);
        } catch (err) {
          if (err instanceof ExitError) {
            throw err;
          }
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
          const target = await resolveClawHubTargetWorkspace(command, opts);
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
          if (results.some((result) => result.ok && result.changed)) {
            await refreshLocalGatewaySkills(target);
          }
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
          if (err instanceof ExitError) {
            throw err;
          }
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
        const signal = getAsyncWorkSignal();
        if (signal?.aborted) {
          return;
        }
        let exitCode: number | undefined;
        const reportError =
          hasJsonOutput(opts) || opts.card !== true
            ? (message: string) => defaultRuntime.writeJson(formatCliJsonFailure(message))
            : defaultRuntime.error;
        try {
          const workspace = await resolveClawHubTargetWorkspace(command, opts, reportError);
          if (!workspace || signal?.aborted) {
            return;
          }
          const target = await resolveClawHubSkillVerificationTarget({
            workspaceDir: workspace.workspaceDir,
            slug,
            version: opts.version,
            tag: opts.tag,
          });
          if (signal?.aborted) {
            return;
          }
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
              signal,
            });
            if (signal?.aborted) {
              return;
            }
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
                  signal,
                });
                if (signal?.aborted) {
                  return;
                }
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
          if (signal?.aborted) {
            return;
          }
          if (err instanceof ExitError) {
            throw err;
          }
          reportError(formatErrorMessage(err));
          exitCode = 1;
        }
        if (exitCode) {
          exitCliAfterOutput(defaultRuntime, exitCode);
        }
      },
    );

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
  await registerSkillsPluginSubcommands(program, skills, argv);
}

/**
 * Plugins add subcommand groups under `skills` (manifest `activation.onCommands`). Built-ins
 * and completion never load the plugin runtime; bare `skills --help` lists plugin groups.
 */
async function registerSkillsPluginSubcommands(
  program: Command,
  skills: Command,
  argv: readonly string[],
): Promise<void> {
  const { resolveCliArgvInvocation } = await import("./argv-invocation.js");
  const { commandPath } = resolveCliArgvInvocation([...argv]);
  if (
    commandPath[0] !== "skills" ||
    skills.commands.some((command) => command.name() === commandPath[1])
  ) {
    return;
  }
  const { hasFlag } = await import("./argv.js");
  const { withConsoleLogsRoutedToStderrForJson } = await import("./json-output-mode.js");
  const { registerPluginCliCommandsFromValidatedConfig } = await import("../plugins/cli.js");
  const parentHelp =
    commandPath.length === 1 && (hasFlag([...argv], "--help") || hasFlag([...argv], "-h"));
  await withConsoleLogsRoutedToStderrForJson(
    argv,
    async () =>
      await registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, {
        mode: parentHelp ? "metadata" : "lazy",
        primary: "skills",
      }),
  );
}
