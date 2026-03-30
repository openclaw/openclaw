import { spawn } from "node:child_process";
import type { Command } from "commander";
import { dashboardCommand } from "../../commands/dashboard.js";
import { doctorCommand } from "../../commands/doctor.js";
import { resetCommand } from "../../commands/reset.js";
import { uninstallCommand } from "../../commands/uninstall.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";

const DEFAULT_DOCTOR_TIMEOUT_MS = 90_000;

function resolveDoctorTimeoutMs(): number {
  const raw = process.env.OPENCLAW_DOCTOR_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_DOCTOR_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DOCTOR_TIMEOUT_MS;
  }
  return Math.max(1_000, Math.floor(parsed));
}

function extractLastDoctorDebugLine(output: string): string | null {
  const matches = output.match(/^\[(?:doctor:debug|doctor-debug)\]\s+(.+)$/gm);
  if (!matches || matches.length === 0) {
    return null;
  }
  const last = matches[matches.length - 1];
  return last.replace(/^\[(?:doctor:debug|doctor-debug)\]\s+/, "").trim() || null;
}

function inferDoctorTimeoutCause(lastDebugLine?: string | null): string | null {
  if (!lastDebugLine) {
    return null;
  }
  if (lastDebugLine.startsWith("doctor-config-flow:preflight:done")) {
    return "Likely heavy area: the next doctor import graph, especially auth/profile and provider discovery modules.";
  }
  if (lastDebugLine.startsWith("doctor:auth-profiles") || lastDebugLine.startsWith("doctor-auth:")) {
    return "Likely heavy area: auth profile storage plus provider discovery/runtime loading.";
  }
  if (lastDebugLine.startsWith("providers.runtime:")) {
    return "Likely heavy area: provider plugin discovery or plugin loader initialization.";
  }
  return null;
}

function formatDoctorTimeoutMessage(params: { timeoutMs: number; lastDebugLine?: string | null }) {
  const location = params.lastDebugLine
    ? ` Last observed stage: ${params.lastDebugLine}.`
    : "";
  const cause = inferDoctorTimeoutCause(params.lastDebugLine);
  const causeText = cause ? ` ${cause}` : "";
  return (
    `doctor exceeded ${Math.ceil(params.timeoutMs / 1000)}s in non-interactive mode.${location}${causeText} ` +
    'Rerun "openclaw doctor --non-interactive" after checking "openclaw gateway status --json" and the gateway logs, or raise OPENCLAW_DOCTOR_TIMEOUT_MS if this host is intentionally slow.'
  );
}

function splitCompleteLines(buffer: string): { completeLines: string[]; remainder: string } {
  const normalized = buffer.replaceAll("\r\n", "\n");
  const segments = normalized.split("\n");
  const remainder = buffer.endsWith("\n") || buffer.endsWith("\r\n") ? "" : (segments.pop() ?? "");
  return {
    completeLines: segments,
    remainder,
  };
}

function isDoctorDebugLine(line: string): boolean {
  return /^\[(?:doctor:debug|doctor-debug)\]\s+/.test(line);
}

async function runDoctorWithTimeout(
  action: () => Promise<void>,
  options: { nonInteractive: boolean },
): Promise<void> {
  if (!options.nonInteractive) {
    await action();
    return;
  }
  if (process.env.OPENCLAW_DOCTOR_CHILD === "1") {
    await action();
    return;
  }
  const timeoutMs = resolveDoctorTimeoutMs();
  const entryArg = process.argv[1];
  if (!entryArg) {
    await Promise.race([
      action(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `doctor exceeded ${Math.ceil(timeoutMs / 1000)}s in non-interactive mode. Rerun "openclaw doctor --non-interactive" after checking "openclaw gateway status --json" and the gateway logs, or raise OPENCLAW_DOCTOR_TIMEOUT_MS if this host is intentionally slow.`,
            ),
          );
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let stdoutTail = "";
    let stderrTail = "";
    let stderrPassthroughBuffer = "";
    const passThroughDoctorDebug = process.env.OPENCLAW_DEBUG_DOCTOR === "1";
    const appendTail = (current: string, chunk: string) => {
      const next = `${current}${chunk}`;
      return next.slice(-8_192);
    };
    const flushChildStderr = (forceRemainder = false) => {
      const { completeLines, remainder } = splitCompleteLines(stderrPassthroughBuffer);
      stderrPassthroughBuffer = remainder;
      for (const line of completeLines) {
        if (!passThroughDoctorDebug && isDoctorDebugLine(line)) {
          continue;
        }
        process.stderr.write(`${line}\n`);
      }
      if (!forceRemainder || stderrPassthroughBuffer.length === 0) {
        return;
      }
      if (!passThroughDoctorDebug && isDoctorDebugLine(stderrPassthroughBuffer)) {
        stderrPassthroughBuffer = "";
        return;
      }
      process.stderr.write(stderrPassthroughBuffer);
      stderrPassthroughBuffer = "";
    };
    const child = spawn(process.execPath, [entryArg, ...process.argv.slice(2)], {
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_DOCTOR_CHILD: "1", OPENCLAW_DEBUG_DOCTOR: "1" },
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stdoutTail = appendTail(stdoutTail, text);
      process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderrTail = appendTail(stderrTail, text);
      stderrPassthroughBuffer += text;
      flushChildStderr();
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      const lastDebugLine = extractLastDoctorDebugLine(`${stdoutTail}\n${stderrTail}`);
      reject(
        new Error(
          formatDoctorTimeoutMessage({ timeoutMs, lastDebugLine }),
        ),
      );
    }, timeoutMs);

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      flushChildStderr(true);
      reject(error);
    });

    child.once("exit", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      flushChildStderr(true);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `doctor child exited via ${signal}`
            : `doctor child exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

export function registerMaintenanceCommands(program: Command) {
  program
    .command("doctor")
    .description("Health checks + quick fixes for the gateway and channels")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/doctor", "docs.openclaw.ai/cli/doctor")}\n`,
    )
    .option("--no-workspace-suggestions", "Disable workspace memory system suggestions", false)
    .option("--yes", "Accept defaults without prompting", false)
    .option("--repair", "Apply recommended repairs without prompting", false)
    .option("--fix", "Apply recommended repairs (alias for --repair)", false)
    .option("--force", "Apply aggressive repairs (overwrites custom service config)", false)
    .option("--non-interactive", "Run without prompts (safe migrations only)", false)
    .option("--generate-gateway-token", "Generate and configure a gateway token", false)
    .option("--deep", "Scan system services for extra gateway installs", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const doctorOptions = {
          workspaceSuggestions: opts.workspaceSuggestions,
          yes: Boolean(opts.yes),
          repair: Boolean(opts.repair) || Boolean(opts.fix),
          force: Boolean(opts.force),
          nonInteractive: Boolean(opts.nonInteractive),
          generateGatewayToken: Boolean(opts.generateGatewayToken),
          deep: Boolean(opts.deep),
        };
        await runDoctorWithTimeout(
          () => doctorCommand(defaultRuntime, doctorOptions),
          { nonInteractive: doctorOptions.nonInteractive },
        );
        defaultRuntime.exit(0);
      });
    });

  program
    .command("dashboard")
    .description("Open the Control UI with your current token")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/dashboard", "docs.openclaw.ai/cli/dashboard")}\n`,
    )
    .option("--no-open", "Print URL but do not launch a browser")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await dashboardCommand(defaultRuntime, {
          noOpen: opts.open === false,
        });
      });
    });

  program
    .command("reset")
    .description("Reset local config/state (keeps the CLI installed)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/reset", "docs.openclaw.ai/cli/reset")}\n`,
    )
    .option("--scope <scope>", "config|config+creds+sessions|full (default: interactive prompt)")
    .option("--yes", "Skip confirmation prompts", false)
    .option("--non-interactive", "Disable prompts (requires --scope + --yes)", false)
    .option("--dry-run", "Print actions without removing files", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await resetCommand(defaultRuntime, {
          scope: opts.scope,
          yes: Boolean(opts.yes),
          nonInteractive: Boolean(opts.nonInteractive),
          dryRun: Boolean(opts.dryRun),
        });
      });
    });

  program
    .command("uninstall")
    .description("Uninstall the gateway service + local data (CLI remains)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/uninstall", "docs.openclaw.ai/cli/uninstall")}\n`,
    )
    .option("--service", "Remove the gateway service", false)
    .option("--state", "Remove state + config", false)
    .option("--workspace", "Remove workspace dirs", false)
    .option("--app", "Remove the macOS app", false)
    .option("--all", "Remove service + state + workspace + app", false)
    .option("--yes", "Skip confirmation prompts", false)
    .option("--non-interactive", "Disable prompts (requires --yes)", false)
    .option("--dry-run", "Print actions without removing files", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await uninstallCommand(defaultRuntime, {
          service: Boolean(opts.service),
          state: Boolean(opts.state),
          workspace: Boolean(opts.workspace),
          app: Boolean(opts.app),
          all: Boolean(opts.all),
          yes: Boolean(opts.yes),
          nonInteractive: Boolean(opts.nonInteractive),
          dryRun: Boolean(opts.dryRun),
        });
      });
    });
}
