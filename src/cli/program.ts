import chalk from "chalk";
import { Command } from "commander";
import {
  browserCloseTab,
  browserFocusTab,
  browserOpenTab,
  browserScreenshot,
  browserStart,
  browserStatus,
  browserStop,
  browserTabs,
  resolveBrowserControlUrl,
} from "../browser/client.js";
import { agentCommand } from "../commands/agent.js";
import { healthCommand } from "../commands/health.js";
import { sendCommand } from "../commands/send.js";
import { sessionsCommand } from "../commands/sessions.js";
import { statusCommand } from "../commands/status.js";
import { danger, info, setVerbose } from "../globals.js";
import { loginWeb, logoutWeb } from "../provider-web.js";
import { defaultRuntime } from "../runtime.js";
import { VERSION } from "../version.js";
import { startWebChatServer } from "../webchat/server.js";
import { registerCronCli } from "./cron-cli.js";
import { createDefaultDeps } from "./deps.js";
import { registerGatewayCli } from "./gateway-cli.js";
import { registerNodesCli } from "./nodes-cli.js";
import { forceFreePort } from "./ports.js";

export { forceFreePort };

export function buildProgram() {
  const program = new Command();
  const PROGRAM_VERSION = VERSION;
  const TAGLINE =
    "Send, receive, and auto-reply on WhatsApp (web) and Telegram (bot).";

  program.name("clawdis").description("").version(PROGRAM_VERSION);

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
      'clawdis send --to +15555550123 --message "Hi" --json',
      "Send via your web session and print JSON result.",
    ],
    ["clawdis gateway --port 18789", "Run the WebSocket Gateway locally."],
    [
      "clawdis gateway --force",
      "Kill anything bound to the default gateway port, then start it.",
    ],
    ["clawdis gateway ...", "Gateway control via WebSocket."],
    [
      'clawdis agent --to +15555550123 --message "Run summary" --deliver',
      "Talk directly to the agent using the Gateway; optionally send the WhatsApp reply.",
    ],
    [
      'clawdis send --provider telegram --to @mychat --message "Hi"',
      "Send via your Telegram bot.",
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
    .option("--provider <provider>", "Provider alias (default: whatsapp)")
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      try {
        const provider = opts.provider ?? "whatsapp";
        await loginWeb(Boolean(opts.verbose), provider);
      } catch (err) {
        defaultRuntime.error(danger(`Web login failed: ${String(err)}`));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("logout")
    .description("Clear cached WhatsApp Web credentials")
    .option("--provider <provider>", "Provider alias (default: whatsapp)")
    .action(async (opts) => {
      try {
        void opts.provider; // placeholder for future multi-provider; currently web only.
        await logoutWeb(defaultRuntime);
      } catch (err) {
        defaultRuntime.error(danger(`Logout failed: ${String(err)}`));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("send")
    .description("Send a message (WhatsApp web or Telegram bot)")
    .requiredOption(
      "-t, --to <number>",
      "Recipient: E.164 for WhatsApp (e.g. +15555550123) or Telegram chat id/@username",
    )
    .requiredOption("-m, --message <text>", "Message body")
    .option(
      "--media <path-or-url>",
      "Attach media (image/audio/video/document). Accepts local paths or URLs.",
    )
    .option(
      "--provider <provider>",
      "Delivery provider: whatsapp|telegram (default: whatsapp)",
    )
    .option("--dry-run", "Print payload and skip sending", false)
    .option("--json", "Output result as JSON", false)
    .option("--verbose", "Verbose logging", false)
    .addHelpText(
      "after",
      `
Examples:
  clawdis send --to +15555550123 --message "Hi"
  clawdis send --to +15555550123 --message "Hi" --media photo.jpg
  clawdis send --to +15555550123 --message "Hi" --dry-run      # print payload only
  clawdis send --to +15555550123 --message "Hi" --json         # machine-readable result`,
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
      "Talk directly to the configured agent (no chat send; optional WhatsApp delivery)",
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
  clawdis agent --to +15555550123 --message "status update"
  clawdis agent --session-id 1234 --message "Summarize inbox" --thinking medium
  clawdis agent --to +15555550123 --message "Trace logs" --verbose on --json
  clawdis agent --to +15555550123 --message "Summon reply" --deliver
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

  registerGatewayCli(program);
  registerNodesCli(program);
  registerCronCli(program);
  program
    .command("status")
    .description("Show web session health and recent session recipients")
    .option("--json", "Output JSON instead of text", false)
    .option("--deep", "Probe providers (WA connect + Telegram API)", false)
    .option("--timeout <ms>", "Probe timeout in milliseconds", "10000")
    .option("--verbose", "Verbose logging", false)
    .addHelpText(
      "after",
      `
Examples:
  clawdis status                   # show linked account + session store summary
  clawdis status --json            # machine-readable output
  clawdis status --deep            # run provider probes (WA + Telegram)
  clawdis status --deep --timeout 5000 # tighten probe timeout`,
    )
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const timeout = opts.timeout
        ? Number.parseInt(String(opts.timeout), 10)
        : undefined;
      if (timeout !== undefined && (Number.isNaN(timeout) || timeout <= 0)) {
        defaultRuntime.error(
          "--timeout must be a positive integer (milliseconds)",
        );
        defaultRuntime.exit(1);
        return;
      }
      try {
        await statusCommand(
          {
            json: Boolean(opts.json),
            deep: Boolean(opts.deep),
            timeoutMs: timeout,
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("health")
    .description("Fetch health from the running gateway")
    .option("--json", "Output JSON instead of text", false)
    .option("--timeout <ms>", "Connection timeout in milliseconds", "10000")
    .option("--verbose", "Verbose logging", false)
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const timeout = opts.timeout
        ? Number.parseInt(String(opts.timeout), 10)
        : undefined;
      if (timeout !== undefined && (Number.isNaN(timeout) || timeout <= 0)) {
        defaultRuntime.error(
          "--timeout must be a positive integer (milliseconds)",
        );
        defaultRuntime.exit(1);
        return;
      }
      try {
        await healthCommand(
          {
            json: Boolean(opts.json),
            timeoutMs: timeout,
          },
          defaultRuntime,
        );
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
    .command("webchat")
    .description("Start or query the loopback-only web chat server")
    .option("--port <port>", "Port to bind (default 18788)")
    .option("--json", "Return JSON", false)
    .action(async (opts) => {
      const port = opts.port
        ? Number.parseInt(String(opts.port), 10)
        : undefined;
      const server = await startWebChatServer(port);
      if (!server) {
        const targetPort = port ?? 18788;
        const msg = `webchat failed to start on http://127.0.0.1:${targetPort}/`;
        if (opts.json) {
          defaultRuntime.error(
            JSON.stringify({ error: msg, port: targetPort }),
          );
        } else {
          defaultRuntime.error(danger(msg));
        }
        defaultRuntime.exit(1);
        return;
      }
      const payload = {
        port: server.port,
        basePath: "/",
        host: "127.0.0.1",
      };
      if (opts.json) {
        defaultRuntime.log(JSON.stringify(payload));
      } else {
        defaultRuntime.log(
          info(`webchat listening on http://127.0.0.1:${server.port}/`),
        );
      }
    });

  const browser = program
    .command("browser")
    .description("Manage clawd's dedicated browser (Chrome/Chromium)")
    .option(
      "--url <url>",
      "Override browser control URL (default from ~/.clawdis/clawdis.json)",
    )
    .option("--json", "Output machine-readable JSON", false)
    .addHelpText(
      "after",
      `
Examples:
  clawdis browser status
  clawdis browser start
  clawdis browser tabs
  clawdis browser open https://example.com
  clawdis browser screenshot                # emits MEDIA:<path>
  clawdis browser screenshot <targetId> --full-page
`,
    )
    .action(() => {
      defaultRuntime.error(
        danger('Missing subcommand. Try: "clawdis browser status"'),
      );
      defaultRuntime.exit(1);
    });

  const parentOpts = (cmd: Command) =>
    cmd.parent?.opts?.() as { url?: string; json?: boolean };

  browser
    .command("status")
    .description("Show browser status")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        const status = await browserStatus(baseUrl);
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(status, null, 2));
          return;
        }
        defaultRuntime.log(
          [
            `enabled: ${status.enabled}`,
            `running: ${status.running}`,
            `controlUrl: ${status.controlUrl}`,
            `cdpPort: ${status.cdpPort}`,
            `browser: ${status.chosenBrowser ?? "unknown"}`,
            `profileColor: ${status.color}`,
          ].join("\n"),
        );
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("start")
    .description("Start the clawd browser (no-op if already running)")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        await browserStart(baseUrl);
        const status = await browserStatus(baseUrl);
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(status, null, 2));
          return;
        }
        defaultRuntime.log(info(`🦞 clawd browser running: ${status.running}`));
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("stop")
    .description("Stop the clawd browser (best-effort)")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        await browserStop(baseUrl);
        const status = await browserStatus(baseUrl);
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(status, null, 2));
          return;
        }
        defaultRuntime.log(info(`🦞 clawd browser running: ${status.running}`));
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("tabs")
    .description("List open tabs")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        const tabs = await browserTabs(baseUrl);
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify({ tabs }, null, 2));
          return;
        }
        if (tabs.length === 0) {
          defaultRuntime.log("No tabs (browser closed or no targets).");
          return;
        }
        defaultRuntime.log(
          tabs
            .map(
              (t, i) =>
                `${i + 1}. ${t.title || "(untitled)"}\n   ${t.url}\n   id: ${t.targetId}`,
            )
            .join("\n"),
        );
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("open")
    .description("Open a URL in a new tab")
    .argument("<url>", "URL to open")
    .action(async (url: string, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        const tab = await browserOpenTab(baseUrl, url);
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(tab, null, 2));
          return;
        }
        defaultRuntime.log(`opened: ${tab.url}\nid: ${tab.targetId}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("focus")
    .description("Focus/activate a tab by target id")
    .argument("<targetId>", "CDP target id")
    .action(async (targetId: string, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        await browserFocusTab(baseUrl, targetId);
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify({ ok: true }, null, 2));
          return;
        }
        defaultRuntime.log("ok");
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("close")
    .description("Close a tab by target id")
    .argument("<targetId>", "CDP target id")
    .action(async (targetId: string, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        await browserCloseTab(baseUrl, targetId);
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify({ ok: true }, null, 2));
          return;
        }
        defaultRuntime.log("ok");
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("screenshot")
    .description("Capture a screenshot (defaults to first tab)")
    .argument("[targetId]", "CDP target id")
    .option("--full-page", "Capture full page (best-effort)", false)
    .action(async (targetId: string | undefined, opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        const result = await browserScreenshot(baseUrl, {
          targetId: targetId?.trim() || undefined,
          fullPage: Boolean(opts.fullPage),
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        // Print MEDIA: token so the agent can forward the image as an attachment.
        defaultRuntime.log(`MEDIA:${result.path}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  return program;
}
