import chalk from "chalk";
import { Command } from "commander";
import { agentCommand } from "../commands/agent.js";
import { healthCommand } from "../commands/health.js";
import { sendCommand } from "../commands/send.js";
import { sessionsCommand } from "../commands/sessions.js";
import { statusCommand } from "../commands/status.js";
import { startGatewayServer } from "../gateway/server.js";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import { loadConfig } from "../config/config.js";
import { danger, info, setVerbose } from "../globals.js";
import { acquireRelayLock, RelayLockError } from "../infra/relay-lock.js";
import { getResolvedLoggerSettings } from "../logging.js";
import {
  loginWeb,
  logoutWeb,
  monitorWebProvider,
  resolveHeartbeatRecipients,
  runWebHeartbeatOnce,
  setHeartbeatsEnabled,
  type WebMonitorTuning,
} from "../provider-web.js";
import { runRpcLoop } from "../rpc/loop.js";
import { defaultRuntime } from "../runtime.js";
import { VERSION } from "../version.js";
import {
  resolveHeartbeatSeconds,
  resolveReconnectPolicy,
} from "../web/reconnect.js";
import {
  ensureWebChatServerFromConfig,
  startWebChatServer,
} from "../webchat/server.js";
import { createDefaultDeps, logWebSelfId } from "./deps.js";

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
      'clawdis agent --to +15555550123 --message "Run summary" --deliver',
      "Talk directly to the agent using the same session handling; optionally send the WhatsApp reply.",
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

  program
    .command("rpc")
    .description("Run stdin/stdout JSON RPC loop for agent sends")
    .action(async () => {
      // stdout must stay JSON-only for the macOS app's RPC bridge.
      // Forward all console output to stderr so stray logs (e.g., WhatsApp sender)
      // don't corrupt the stream the app parses.
      const forwardToStderr = (...args: unknown[]) => console.error(...args);
      console.log = forwardToStderr;
      console.info = forwardToStderr;
      console.warn = forwardToStderr;
      console.debug = forwardToStderr;
      console.trace = forwardToStderr;

      await runRpcLoop({ input: process.stdin, output: process.stdout });
      await new Promise<never>(() => {});
    });

  program
    .command("heartbeat")
    .description("Trigger a heartbeat or manual send once (web provider only)")
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
    .command("gateway")
    .description("Run the WebSocket Gateway (replaces relay)")
    .option("--port <port>", "Port for the gateway WebSocket", "18789")
    .option(
      "--token <token>",
      "Shared token required in hello.auth.token (default: CLAWDIS_GATEWAY_TOKEN env if set)",
    )
    .action(async (opts) => {
      const port = Number.parseInt(String(opts.port ?? "18789"), 10);
      if (Number.isNaN(port) || port <= 0) {
        defaultRuntime.error("Invalid port");
        defaultRuntime.exit(1);
      }
      if (opts.token) {
        process.env.CLAWDIS_GATEWAY_TOKEN = String(opts.token);
      }
      try {
        await startGatewayServer(port);
      } catch (err) {
        defaultRuntime.error(`Gateway failed to start: ${String(err)}`);
        defaultRuntime.exit(1);
      }
      // Keep process alive
      await new Promise<never>(() => {});
    });

  const gatewayCallOpts = (cmd: Command) =>
    cmd
      .option("--url <url>", "Gateway WebSocket URL", "ws://127.0.0.1:18789")
      .option("--token <token>", "Gateway token (if required)")
      .option("--timeout <ms>", "Timeout in ms", "10000")
      .option("--expect-final", "Wait for final response (agent)" , false);

  gatewayCallOpts(
    program
      .command("gw:call")
      .description("Call a Gateway method over WS and print JSON")
      .argument("<method>", "Method name (health/status/system-presence/send/agent)")
      .option("--params <json>", "JSON object string for params", "{}")
      .action(async (method, opts) => {
        try {
          const params = JSON.parse(String(opts.params ?? "{}"));
          const result = await callGateway({
            url: opts.url,
            token: opts.token,
            method,
            params,
            expectFinal: Boolean(opts.expectFinal),
            timeoutMs: Number(opts.timeout ?? 10000),
            clientName: "cli",
            mode: "cli",
          });
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(`Gateway call failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  gatewayCallOpts(
    program
      .command("gw:health")
      .description("Fetch Gateway health over WS")
      .action(async (opts) => {
        try {
          const result = await callGateway({
            url: opts.url,
            token: opts.token,
            method: "health",
            timeoutMs: Number(opts.timeout ?? 10000),
          });
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      }),
  );

  gatewayCallOpts(
    program
      .command("gw:status")
      .description("Fetch Gateway status over WS")
      .action(async (opts) => {
        try {
          const result = await callGateway({
            url: opts.url,
            token: opts.token,
            method: "status",
            timeoutMs: Number(opts.timeout ?? 10000),
          });
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      }),
  );

  gatewayCallOpts(
    program
      .command("gw:send")
      .description("Send a message via the Gateway")
      .requiredOption("--to <jidOrPhone>", "Destination (E.164 or jid)")
      .requiredOption("--message <text>", "Message text")
      .option("--media-url <url>", "Optional media URL")
      .option("--idempotency-key <key>", "Idempotency key")
      .action(async (opts) => {
        try {
          const idempotencyKey = opts.idempotencyKey ?? randomIdempotencyKey();
          const result = await callGateway({
            url: opts.url,
            token: opts.token,
            method: "send",
            params: {
              to: opts.to,
              message: opts.message,
              mediaUrl: opts.mediaUrl,
              idempotencyKey,
            },
            timeoutMs: Number(opts.timeout ?? 10000),
          });
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      }),
  );

  gatewayCallOpts(
    program
      .command("gw:agent")
      .description("Run an agent turn via the Gateway (waits for final)")
      .requiredOption("--message <text>", "User message")
      .option("--to <jidOrPhone>", "Destination")
      .option("--session-id <id>", "Session id")
      .option("--thinking <level>", "Thinking level")
      .option("--deliver", "Deliver response", false)
      .option("--timeout-seconds <n>", "Agent timeout seconds")
      .option("--idempotency-key <key>", "Idempotency key")
      .action(async (opts) => {
        try {
          const idempotencyKey = opts.idempotencyKey ?? randomIdempotencyKey();
          const result = await callGateway({
            url: opts.url,
            token: opts.token,
            method: "agent",
            params: {
              message: opts.message,
              to: opts.to,
              sessionId: opts.sessionId,
              thinking: opts.thinking,
              deliver: Boolean(opts.deliver),
              timeout: opts.timeoutSeconds
                ? Number.parseInt(String(opts.timeoutSeconds), 10)
                : undefined,
              idempotencyKey,
            },
            expectFinal: true,
            timeoutMs: Number(opts.timeout ?? 10000),
          });
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      }),
  );

  program
    .command("relay")
    .description(
      "Auto-reply to inbound messages across configured providers (web, Telegram)",
    )
    .option(
      "--provider <auto|web|telegram|all>",
      "Which providers to start: auto (default), web, telegram, or all",
    )
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
    .option(
      "--webhook",
      "Run Telegram webhook server instead of long-poll",
      false,
    )
    .option(
      "--webhook-path <path>",
      "Telegram webhook path (default /telegram-webhook when webhook enabled)",
    )
    .option(
      "--webhook-secret <secret>",
      "Secret token to verify Telegram webhook requests",
    )
    .option("--port <port>", "Port for Telegram webhook server (default 8787)")
    .option(
      "--webhook-url <url>",
      "Public Telegram webhook URL to register (overrides localhost autodetect)",
    )
    .option("--verbose", "Verbose logging", false)
    .addHelpText(
      "after",
      `
Examples:
  clawdis relay                     # starts WhatsApp; also Telegram if bot token set
  clawdis relay --provider web      # force WhatsApp-only
  clawdis relay --provider telegram # Telegram-only (needs TELEGRAM_BOT_TOKEN)
  clawdis relay --heartbeat-now     # send immediate agent heartbeat on start (web)
  clawdis relay --web-heartbeat 60  # override WhatsApp heartbeat interval
  # Troubleshooting: docs/refactor/web-relay-troubleshooting.md
`,
    )
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const { file: logFile, level: logLevel } = getResolvedLoggerSettings();
      defaultRuntime.log(info(`logs: ${logFile} (level ${logLevel})`));

      let releaseRelayLock: (() => Promise<void>) | null = null;
      try {
        releaseRelayLock = await acquireRelayLock();
      } catch (err) {
        if (err instanceof RelayLockError) {
          defaultRuntime.error(danger(`Relay already running: ${err.message}`));
          defaultRuntime.exit(1);
          return;
        }
        throw err;
      }

      const providerOpt = (opts.provider ?? "auto").toLowerCase();
      const cfg = loadConfig();
      const telegramToken =
        process.env.TELEGRAM_BOT_TOKEN ?? cfg.telegram?.botToken;

      let startWeb = false;
      let startTelegram = false;
      switch (providerOpt) {
        case "web":
          startWeb = true;
          break;
        case "telegram":
          startTelegram = true;
          break;
        case "all":
          startWeb = true;
          startTelegram = true;
          break;
        default:
          startWeb = true;
          startTelegram = Boolean(telegramToken);
          break;
      }

      if (startTelegram && !telegramToken) {
        defaultRuntime.error(
          danger(
            "Telegram relay requires TELEGRAM_BOT_TOKEN or telegram.botToken in config",
          ),
        );
        defaultRuntime.exit(1);
        return;
      }

      if (!startWeb && !startTelegram) {
        defaultRuntime.error(
          danger("No providers selected. Use --provider web|telegram|all."),
        );
        defaultRuntime.exit(1);
        return;
      }

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

      const controller = new AbortController();
      const stopAll = () => controller.abort();
      process.once("SIGINT", stopAll);

      const runners: Array<Promise<unknown>> = [];

      if (startWeb) {
        const webTuning: WebMonitorTuning = {};
        if (webHeartbeat !== undefined)
          webTuning.heartbeatSeconds = webHeartbeat;
        if (heartbeatNow) webTuning.replyHeartbeatNow = true;
        const reconnect: WebMonitorTuning["reconnect"] = {};
        if (webRetries !== undefined) reconnect.maxAttempts = webRetries;
        if (webRetryInitial !== undefined)
          reconnect.initialMs = webRetryInitial;
        if (webRetryMax !== undefined) reconnect.maxMs = webRetryMax;
        if (Object.keys(reconnect).length > 0) {
          webTuning.reconnect = reconnect;
        }
        logWebSelfId(defaultRuntime, true);
        const effectiveHeartbeat = resolveHeartbeatSeconds(
          cfg,
          webTuning.heartbeatSeconds,
        );
        const effectivePolicy = resolveReconnectPolicy(
          cfg,
          webTuning.reconnect,
        );
        defaultRuntime.log(
          info(
            `Web relay health: heartbeat ${effectiveHeartbeat}s, retries ${effectivePolicy.maxAttempts || "∞"}, backoff ${effectivePolicy.initialMs}→${effectivePolicy.maxMs}ms x${effectivePolicy.factor} (jitter ${Math.round(effectivePolicy.jitter * 100)}%)`,
          ),
        );

        const webchatServer = await ensureWebChatServerFromConfig();
        if (webchatServer) {
          defaultRuntime.log(
            info(
              `webchat listening on http://127.0.0.1:${webchatServer.port}/webchat/`,
            ),
          );
        }

        runners.push(
          monitorWebProvider(
            Boolean(opts.verbose),
            undefined,
            true,
            undefined,
            defaultRuntime,
            controller.signal,
            webTuning,
          ),
        );
      }

      if (startTelegram) {
        const useWebhook = Boolean(opts.webhook);
        const telegramRunner = (async () => {
          const { monitorTelegramProvider } = await import(
            "../telegram/monitor.js"
          );
          const sharedOpts = {
            token: telegramToken,
            runtime: defaultRuntime,
            abortSignal: controller.signal,
          } as const;
          if (useWebhook) {
            const port = opts.port
              ? Number.parseInt(String(opts.port), 10)
              : 8787;
            const path = opts.webhookPath ?? "/telegram-webhook";
            return monitorTelegramProvider({
              ...sharedOpts,
              useWebhook: true,
              webhookPath: path,
              webhookPort: port,
              webhookSecret: opts.webhookSecret ?? cfg.telegram?.webhookSecret,
              webhookUrl: opts.webhookUrl ?? cfg.telegram?.webhookUrl,
            });
          }
          return monitorTelegramProvider(sharedOpts);
        })();
        runners.push(telegramRunner);
      }

      try {
        await Promise.all(runners);
      } catch (err) {
        defaultRuntime.error(danger(`Relay failed: ${String(err)}`));
        defaultRuntime.exit(1);
      } finally {
        if (releaseRelayLock) await releaseRelayLock();
      }
    });

  // relay is the single entry point; heartbeat/Telegram helpers removed.

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
    .command("health")
    .description(
      "Probe WhatsApp Web health (creds + Baileys connect) and session store",
    )
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
          { json: Boolean(opts.json), timeoutMs: timeout },
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
      const payload = {
        port: server.port,
        basePath: "/webchat/",
        host: "127.0.0.1",
      };
      if (opts.json) {
        defaultRuntime.log(JSON.stringify(payload));
      } else {
        defaultRuntime.log(
          info(`webchat listening on http://127.0.0.1:${server.port}/webchat/`),
        );
      }
    });

  return program;
}
