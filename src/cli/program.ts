import chalk from "chalk";
import { Command } from "commander";
import { agentCommand } from "../commands/agent.js";
import { sendCommand } from "../commands/send.js";
import { sessionsCommand } from "../commands/sessions.js";
import { statusCommand } from "../commands/status.js";
import { loadConfig } from "../config/config.js";
import { danger, info, setVerbose } from "../globals.js";
import { getResolvedLoggerSettings } from "../logging.js";
import {
  loginWeb,
  logoutWeb,
  monitorWebProvider,
  resolveHeartbeatRecipients,
  runWebHeartbeatOnce,
  type WebMonitorTuning,
} from "../provider-web.js";
import { defaultRuntime } from "../runtime.js";
import { VERSION } from "../version.js";
import {
  resolveHeartbeatSeconds,
  resolveReconnectPolicy,
} from "../web/reconnect.js";
import { createDefaultDeps, logWebSelfId } from "./deps.js";
import { spawnRelayTmux } from "./relay_tmux.js";

export function buildProgram() {
  const program = new Command();
  const PROGRAM_VERSION = VERSION;
  const TAGLINE =
    "Send, receive, and auto-reply on WhatsApp—Baileys (web) only.";

  program
    .name("clawdis")
    .description("WhatsApp relay CLI (WhatsApp Web session only)")
    .version(PROGRAM_VERSION);

  const formatIntroLine = (version: string, rich = true) => {
    const base = `📡 clawdis ${version} — ${TAGLINE}`;
    return rich && chalk.level > 0
      ? `${chalk.bold.cyan("📡 clawdis")} ${chalk.white(version)} ${chalk.gray("—")} ${chalk.green(TAGLINE)}`
      : base;
  };

  program.configureHelp({
    optionTerm: (option) => chalk.yellow(option.flags),
    subcommandTerm: (cmd) => chalk.green(cmd.name()),
  });

  program.configureOutput({
    writeOut: (str) => {
      const colored = str
        .replace(/^Usage:/gm, chalk.bold.cyan("Usage:"))
        .replace(/^Options:/gm, chalk.bold.cyan("Options:"))
        .replace(/^Commands:/gm, chalk.bold.cyan("Commands:"));
      process.stdout.write(colored);
    },
    writeErr: (str) => process.stderr.write(str),
    outputError: (str, write) => write(chalk.red(str)),
  });

  if (process.argv.includes("-V") || process.argv.includes("--version")) {
    console.log(formatIntroLine(PROGRAM_VERSION));
    process.exit(0);
  }

  program.addHelpText("beforeAll", `\n${formatIntroLine(PROGRAM_VERSION)}\n`);
  const examples = [
    [
      "clawdis login --verbose",
      "Link personal WhatsApp Web and show QR + connection logs.",
    ],
    [
      'clawdis send --to +15551234567 --message "Hi" --json',
      "Send via your web session and print JSON result.",
    ],
    [
      "clawdis relay --verbose",
      "Auto-reply loop using your linked web session.",
    ],
    [
      "clawdis heartbeat --verbose",
      "Send a heartbeat ping to your active session or first allowFrom contact.",
    ],
    [
      "clawdis status",
      "Show web session health and recent session recipients.",
    ],
    [
      'clawdis agent --to +15551234567 --message "Run summary" --deliver',
      "Talk directly to the agent using the same session handling; optionally send the reply.",
    ],
  ] as const;

  const fmtExamples = examples
    .map(([cmd, desc]) => `  ${chalk.green(cmd)}\n    ${chalk.gray(desc)}`)
    .join("\n");

  program.addHelpText(
    "afterAll",
    `\n${chalk.bold.cyan("Examples:")}\n${fmtExamples}\n`,
  );

  program
    .command("login")
    .description("Link your personal WhatsApp via QR (web provider)")
    .option("--verbose", "Verbose connection logs", false)
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      try {
        await loginWeb(Boolean(opts.verbose));
      } catch (err) {
        defaultRuntime.error(danger(`Web login failed: ${String(err)}`));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("logout")
    .description("Clear cached WhatsApp Web credentials")
    .action(async () => {
      try {
        await logoutWeb(defaultRuntime);
      } catch (err) {
        defaultRuntime.error(danger(`Logout failed: ${String(err)}`));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("send")
    .description("Send a WhatsApp message (web provider)")
    .requiredOption(
      "-t, --to <number>",
      "Recipient number in E.164 (e.g. +15551234567)",
    )
    .requiredOption("-m, --message <text>", "Message body")
    .option(
      "--media <path-or-url>",
      "Attach media (image/audio/video/document). Accepts local paths or URLs.",
    )
    .option("--dry-run", "Print payload and skip sending", false)
    .option("--json", "Output result as JSON", false)
    .option("--verbose", "Verbose logging", false)
    .addHelpText(
      "after",
      `
Examples:
  clawdis send --to +15551234567 --message "Hi"
  clawdis send --to +15551234567 --message "Hi" --media photo.jpg
  clawdis send --to +15551234567 --message "Hi" --dry-run      # print payload only
  clawdis send --to +15551234567 --message "Hi" --json         # machine-readable result`,
    )
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const deps = createDefaultDeps();
      try {
        await sendCommand(opts, deps, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("agent")
    .description(
      "Talk directly to the configured agent (no WhatsApp send, reuses sessions)",
    )
    .requiredOption("-m, --message <text>", "Message body for the agent")
    .option(
      "-t, --to <number>",
      "Recipient number in E.164 used to derive the session key",
    )
    .option("--session-id <id>", "Use an explicit session id")
    .option(
      "--thinking <level>",
      "Thinking level: off | minimal | low | medium | high",
    )
    .option("--verbose <on|off>", "Persist agent verbose level for the session")
    .option(
      "--deliver",
      "Send the agent's reply back to WhatsApp (requires --to)",
      false,
    )
    .option("--json", "Output result as JSON", false)
    .option(
      "--timeout <seconds>",
      "Override agent command timeout (seconds, default 600 or config value)",
    )
    .addHelpText(
      "after",
      `
Examples:
  clawdis agent --to +15551234567 --message "status update"
  clawdis agent --session-id 1234 --message "Summarize inbox" --thinking medium
  clawdis agent --to +15551234567 --message "Trace logs" --verbose on --json
  clawdis agent --to +15551234567 --message "Summon reply" --deliver
`,
    )
    .action(async (opts) => {
      const verboseLevel =
        typeof opts.verbose === "string" ? opts.verbose.toLowerCase() : "";
      setVerbose(verboseLevel === "on");
      // Build default deps (keeps parity with other commands; future-proofing).
      void createDefaultDeps();
      try {
        await agentCommand(opts, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("heartbeat")
    .description("Trigger a heartbeat or manual send once (web only, no tmux)")
    .option("--to <number>", "Override target E.164; defaults to allowFrom[0]")
    .option(
      "--session-id <id>",
      "Force a session id for this heartbeat (resumes a specific Pi session)",
    )
    .option(
      "--all",
      "Send heartbeat to all active sessions (or allowFrom entries when none)",
      false,
    )
    .option(
      "--message <text>",
      "Send a custom message instead of the heartbeat probe",
    )
    .option("--body <text>", "Alias for --message")
    .option("--dry-run", "Print the resolved payload without sending", false)
    .option("--verbose", "Verbose logging", false)
    .addHelpText(
      "after",
      `
Examples:
  clawdis heartbeat                 # uses web session + first allowFrom contact
  clawdis heartbeat --verbose       # prints detailed heartbeat logs
  clawdis heartbeat --to +1555123   # override destination
  clawdis heartbeat --session-id <uuid> --to +1555123   # resume a specific session
  clawdis heartbeat --message "Ping"
  clawdis heartbeat --all           # send to every active session recipient or allowFrom entry`,
    )
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const cfg = loadConfig();
      const allowAll = Boolean(opts.all);
      const resolution = resolveHeartbeatRecipients(cfg, {
        to: opts.to,
        all: allowAll,
      });
      if (
        !opts.to &&
        !allowAll &&
        resolution.source === "session-ambiguous" &&
        resolution.recipients.length > 1
      ) {
        defaultRuntime.error(
          danger(
            `Multiple active sessions found (${resolution.recipients.join(", ")}). Pass --to <E.164> or --all to send to all.`,
          ),
        );
        defaultRuntime.exit(1);
      }
      const recipients = resolution.recipients;
      if (!recipients || recipients.length === 0) {
        defaultRuntime.error(
          danger(
            "No destination found. Add inbound.allowFrom numbers or pass --to <E.164>.",
          ),
        );
        defaultRuntime.exit(1);
      }

      const overrideBody =
        (opts.message as string | undefined) ||
        (opts.body as string | undefined) ||
        undefined;
      const dryRun = Boolean(opts.dryRun);

      try {
        for (const to of recipients) {
          await runWebHeartbeatOnce({
            to,
            verbose: Boolean(opts.verbose),
            runtime: defaultRuntime,
            sessionId: opts.sessionId,
            overrideBody,
            dryRun,
          });
        }
      } catch {
        defaultRuntime.exit(1);
      }
    });

  program
    .command("relay")
    .description("Auto-reply to inbound messages (web only)")
    .option(
      "--web-heartbeat <seconds>",
      "Heartbeat interval for web relay health logs (seconds)",
    )
    .option(
      "--web-retries <count>",
      "Max consecutive web reconnect attempts before exit (0 = unlimited)",
    )
    .option(
      "--web-retry-initial <ms>",
      "Initial reconnect backoff for web relay (ms)",
    )
    .option("--web-retry-max <ms>", "Max reconnect backoff for web relay (ms)")
    .option(
      "--heartbeat-now",
      "Run a heartbeat immediately when relay starts",
      false,
    )
    .option("--verbose", "Verbose logging", false)
    .addHelpText(
      "after",
      `
Examples:
  clawdis relay                     # uses your linked web session
  clawdis relay --web-heartbeat 60  # override heartbeat interval
  # Troubleshooting: docs/refactor/web-relay-troubleshooting.md
`,
    )
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const { file: logFile, level: logLevel } = getResolvedLoggerSettings();
      defaultRuntime.log(info(`logs: ${logFile} (level ${logLevel})`));
      const webHeartbeat =
        opts.webHeartbeat !== undefined
          ? Number.parseInt(String(opts.webHeartbeat), 10)
          : undefined;
      const webRetries =
        opts.webRetries !== undefined
          ? Number.parseInt(String(opts.webRetries), 10)
          : undefined;
      const webRetryInitial =
        opts.webRetryInitial !== undefined
          ? Number.parseInt(String(opts.webRetryInitial), 10)
          : undefined;
      const webRetryMax =
        opts.webRetryMax !== undefined
          ? Number.parseInt(String(opts.webRetryMax), 10)
          : undefined;
      const heartbeatNow = Boolean(opts.heartbeatNow);
      if (
        webHeartbeat !== undefined &&
        (Number.isNaN(webHeartbeat) || webHeartbeat <= 0)
      ) {
        defaultRuntime.error("--web-heartbeat must be a positive integer");
        defaultRuntime.exit(1);
      }
      if (
        webRetries !== undefined &&
        (Number.isNaN(webRetries) || webRetries < 0)
      ) {
        defaultRuntime.error("--web-retries must be >= 0");
        defaultRuntime.exit(1);
      }
      if (
        webRetryInitial !== undefined &&
        (Number.isNaN(webRetryInitial) || webRetryInitial <= 0)
      ) {
        defaultRuntime.error("--web-retry-initial must be a positive integer");
        defaultRuntime.exit(1);
      }
      if (
        webRetryMax !== undefined &&
        (Number.isNaN(webRetryMax) || webRetryMax <= 0)
      ) {
        defaultRuntime.error("--web-retry-max must be a positive integer");
        defaultRuntime.exit(1);
      }
      if (
        webRetryMax !== undefined &&
        webRetryInitial !== undefined &&
        webRetryMax < webRetryInitial
      ) {
        defaultRuntime.error("--web-retry-max must be >= --web-retry-initial");
        defaultRuntime.exit(1);
      }

      const webTuning: WebMonitorTuning = {};
      if (webHeartbeat !== undefined) webTuning.heartbeatSeconds = webHeartbeat;
      if (heartbeatNow) webTuning.replyHeartbeatNow = true;
      const reconnect: WebMonitorTuning["reconnect"] = {};
      if (webRetries !== undefined) reconnect.maxAttempts = webRetries;
      if (webRetryInitial !== undefined) reconnect.initialMs = webRetryInitial;
      if (webRetryMax !== undefined) reconnect.maxMs = webRetryMax;
      if (Object.keys(reconnect).length > 0) {
        webTuning.reconnect = reconnect;
      }
      logWebSelfId(defaultRuntime, true);
      const cfg = loadConfig();
      const effectiveHeartbeat = resolveHeartbeatSeconds(
        cfg,
        webTuning.heartbeatSeconds,
      );
      const effectivePolicy = resolveReconnectPolicy(cfg, webTuning.reconnect);
      defaultRuntime.log(
        info(
          `Web relay health: heartbeat ${effectiveHeartbeat}s, retries ${effectivePolicy.maxAttempts || "∞"}, backoff ${effectivePolicy.initialMs}→${effectivePolicy.maxMs}ms x${effectivePolicy.factor} (jitter ${Math.round(effectivePolicy.jitter * 100)}%)`,
        ),
      );
      try {
        await monitorWebProvider(
          Boolean(opts.verbose),
          undefined,
          true,
          undefined,
          defaultRuntime,
          undefined,
          webTuning,
        );
        return;
      } catch (err) {
        defaultRuntime.error(
          danger(
            `Web relay failed: ${String(err)}. Re-link with 'clawdis login --verbose'.`,
          ),
        );
        defaultRuntime.exit(1);
      }
    });

  program
    .command("relay:heartbeat")
    .description(
      "Run relay with an immediate heartbeat (no tmux); requires web provider",
    )
    .option("--verbose", "Verbose logging", false)
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const { file: logFile, level: logLevel } = getResolvedLoggerSettings();
      defaultRuntime.log(info(`logs: ${logFile} (level ${logLevel})`));

      logWebSelfId(defaultRuntime, true);
      const cfg = loadConfig();
      const effectiveHeartbeat = resolveHeartbeatSeconds(cfg, undefined);
      const effectivePolicy = resolveReconnectPolicy(cfg, undefined);
      defaultRuntime.log(
        info(
          `Web relay health: heartbeat ${effectiveHeartbeat}s, retries ${effectivePolicy.maxAttempts || "∞"}, backoff ${effectivePolicy.initialMs}→${effectivePolicy.maxMs}ms x${effectivePolicy.factor} (jitter ${Math.round(effectivePolicy.jitter * 100)}%)`,
        ),
      );

      try {
        await monitorWebProvider(
          Boolean(opts.verbose),
          undefined,
          true,
          undefined,
          defaultRuntime,
          undefined,
          { replyHeartbeatNow: true },
        );
      } catch (err) {
        defaultRuntime.error(
          danger(
            `Web relay failed: ${String(err)}. Re-link with 'clawdis login --provider web'.`,
          ),
        );
        defaultRuntime.exit(1);
      }
    });

  program
    .command("status")
    .description("Show web session health and recent session recipients")
    .option("--json", "Output JSON instead of text", false)
    .option("--verbose", "Verbose logging", false)
    .addHelpText(
      "after",
      `
Examples:
  clawdis status                   # show linked account + session store summary
  clawdis status --json            # machine-readable output`,
    )
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      try {
        await statusCommand(opts, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("sessions")
    .description("List stored conversation sessions")
    .option("--json", "Output as JSON", false)
    .option("--verbose", "Verbose logging", false)
    .option(
      "--store <path>",
      "Path to session store (default: resolved from config)",
    )
    .option(
      "--active <minutes>",
      "Only show sessions updated within the past N minutes",
    )
    .addHelpText(
      "after",
      `
Examples:
  clawdis sessions                 # list all sessions
  clawdis sessions --active 120    # only last 2 hours
  clawdis sessions --json          # machine-readable output
  clawdis sessions --store ./tmp/sessions.json

Shows token usage per session when the agent reports it; set inbound.reply.agent.contextTokens to see % of your model window.`,
    )
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      await sessionsCommand(
        {
          json: Boolean(opts.json),
          store: opts.store as string | undefined,
          active: opts.active as string | undefined,
        },
        defaultRuntime,
      );
    });

  program
    .command("relay:tmux")
    .description(
      "Run relay --verbose inside tmux (session clawdis-relay), restarting if already running, then attach",
    )
    .action(async () => {
      try {
        const shouldAttach = Boolean(process.stdout.isTTY);
        const session = await spawnRelayTmux(
          "pnpm clawdis relay --verbose",
          shouldAttach,
        );
        defaultRuntime.log(
          info(
            shouldAttach
              ? `tmux session started and attached: ${session} (pane running "pnpm clawdis relay --verbose")`
              : `tmux session started: ${session} (pane running "pnpm clawdis relay --verbose"); attach manually with "tmux attach -t ${session}"`,
          ),
        );
      } catch (err) {
        defaultRuntime.error(
          danger(`Failed to start relay tmux session: ${String(err)}`),
        );
        defaultRuntime.exit(1);
      }
    });

  program
    .command("relay:tmux:attach")
    .description(
      "Attach to the existing clawdis-relay tmux session (no restart)",
    )
    .action(async () => {
      try {
        if (!process.stdout.isTTY) {
          defaultRuntime.error(
            danger(
              "Cannot attach: stdout is not a TTY. Run this in a terminal or use 'tmux attach -t clawdis-relay' manually.",
            ),
          );
          defaultRuntime.exit(1);
          return;
        }
        await spawnRelayTmux("pnpm clawdis relay --verbose", true, false);
        defaultRuntime.log(info("Attached to clawdis-relay session."));
      } catch (err) {
        defaultRuntime.error(
          danger(`Failed to attach to clawdis-relay: ${String(err)}`),
        );
        defaultRuntime.exit(1);
      }
    });

  program
    .command("relay:heartbeat:tmux")
    .description(
      "Run relay --verbose with an immediate heartbeat inside tmux (session clawdis-relay), then attach",
    )
    .action(async () => {
      try {
        const shouldAttach = Boolean(process.stdout.isTTY);
        const session = await spawnRelayTmux(
          "pnpm clawdis relay --verbose --heartbeat-now",
          shouldAttach,
        );
        defaultRuntime.log(
          info(
            shouldAttach
              ? `tmux session started and attached: ${session} (pane running "pnpm clawdis relay --verbose --heartbeat-now")`
              : `tmux session started: ${session} (pane running "pnpm clawdis relay --verbose --heartbeat-now"); attach manually with "tmux attach -t ${session}"`,
          ),
        );
      } catch (err) {
        defaultRuntime.error(
          danger(
            `Failed to start relay tmux session with heartbeat: ${String(err)}`,
          ),
        );
        defaultRuntime.exit(1);
      }
    });

  return program;
}
