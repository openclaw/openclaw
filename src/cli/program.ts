import chalk from "chalk";
import { Command } from "commander";
import { agentCommand } from "../commands/agent.js";
import { healthCommand } from "../commands/health.js";
import { sendCommand } from "../commands/send.js";
import { sessionsCommand } from "../commands/sessions.js";
import { statusCommand } from "../commands/status.js";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import { startGatewayServer } from "../gateway/server.js";
import { danger, info, setVerbose } from "../globals.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import { loginWeb, logoutWeb } from "../provider-web.js";
import { defaultRuntime } from "../runtime.js";
import { VERSION } from "../version.js";
import { startWebChatServer } from "../webchat/server.js";
import { createDefaultDeps } from "./deps.js";
import { forceFreePort, listPortListeners, parseLsofOutput } from "./ports.js";

export { forceFreePort, listPortListeners, parseLsofOutput };

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
    .option(
      "--spawn-gateway",
      "Start a local gateway on 127.0.0.1:18789 if none is running",
      false,
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

  program;
  const gateway = program
    .command("gateway")
    .description("Run the WebSocket Gateway")
    .option("--port <port>", "Port for the gateway WebSocket", "18789")
    .option(
      "--token <token>",
      "Shared token required in hello.auth.token (default: CLAWDIS_GATEWAY_TOKEN env if set)",
    )
    .option(
      "--force",
      "Kill any existing listener on the target port before starting",
      false,
    )
    .option("--verbose", "Verbose logging to stdout/stderr", false)
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const port = Number.parseInt(String(opts.port ?? "18789"), 10);
      if (Number.isNaN(port) || port <= 0) {
        defaultRuntime.error("Invalid port");
        defaultRuntime.exit(1);
      }
      if (opts.force) {
        try {
          const killed = forceFreePort(port);
          if (killed.length === 0) {
            defaultRuntime.log(info(`Force: no listeners on port ${port}`));
          } else {
            for (const proc of killed) {
              defaultRuntime.log(
                info(
                  `Force: killed pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""} on port ${port}`,
                ),
              );
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        } catch (err) {
          defaultRuntime.error(`Force: ${String(err)}`);
          defaultRuntime.exit(1);
          return;
        }
      }
      if (opts.token) {
        process.env.CLAWDIS_GATEWAY_TOKEN = String(opts.token);
      }
      try {
        await startGatewayServer(port);
      } catch (err) {
        if (err instanceof GatewayLockError) {
          defaultRuntime.error(`Gateway failed to start: ${err.message}`);
          defaultRuntime.exit(1);
          return;
        }
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
      .option("--expect-final", "Wait for final response (agent)", false)
      .option(
        "--spawn-gateway",
        "Start a local gateway if none is listening on --url",
        false,
      );

  const callWithSpawn = async (
    method: string,
    opts: {
      url?: string;
      token?: string;
      timeout?: string;
      expectFinal?: boolean;
      spawnGateway?: boolean;
    },
    params?: unknown,
  ) => {
    const timeoutMs = Number(opts.timeout ?? 10_000);
    const attempt = async () =>
      callGateway({
        url: opts.url,
        token: opts.token,
        method,
        params,
        expectFinal: Boolean(opts.expectFinal),
        timeoutMs,
        clientName: "cli",
        mode: "cli",
      });

    try {
      return await attempt();
    } catch (err) {
      if (!opts.spawnGateway) throw err;
      // Only spawn if there is clearly no listener.
      const url = new URL(opts.url ?? "ws://127.0.0.1:18789");
      const port = Number(url.port || 18789);
      const listeners = listPortListeners(port);
      if (listeners.length > 0) throw err;
      await startGatewayServer(port);
      return await attempt();
    }
  };

  gatewayCallOpts(
    gateway
      .command("call")
      .description("Call a Gateway method and print JSON")
      .argument(
        "<method>",
        "Method name (health/status/system-presence/send/agent)",
      )
      .option("--params <json>", "JSON object string for params", "{}")
      .action(async (method, opts) => {
        try {
          const params = JSON.parse(String(opts.params ?? "{}"));
          const result = await callWithSpawn(method, opts, params);
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(`Gateway call failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  gatewayCallOpts(
    gateway
      .command("health")
      .description("Fetch Gateway health")
      .action(async (opts) => {
        try {
          const result = await callWithSpawn("health", opts);
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      }),
  );

  gatewayCallOpts(
    gateway
      .command("status")
      .description("Fetch Gateway status")
      .action(async (opts) => {
        try {
          const result = await callWithSpawn("status", opts);
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      }),
  );

  gatewayCallOpts(
    gateway
      .command("send")
      .description("Send a message via the Gateway")
      .requiredOption("--to <jidOrPhone>", "Destination (E.164 or jid)")
      .requiredOption("--message <text>", "Message text")
      .option("--media-url <url>", "Optional media URL")
      .option("--idempotency-key <key>", "Idempotency key")
      .action(async (opts) => {
        try {
          const idempotencyKey = opts.idempotencyKey ?? randomIdempotencyKey();
          const result = await callWithSpawn("send", opts, {
            to: opts.to,
            message: opts.message,
            mediaUrl: opts.mediaUrl,
            idempotencyKey,
          });
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      }),
  );

  gatewayCallOpts(
    gateway
      .command("agent")
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
          const result = await callWithSpawn(
            "agent",
            { ...opts, expectFinal: true },
            {
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
          );
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      }),
  );
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
    .description(
      "Probe WhatsApp Web health (creds + Baileys connect) and session store",
    )
    .option("--json", "Output JSON instead of text", false)
    .option("--timeout <ms>", "Connection timeout in milliseconds", "10000")
    .option("--verbose", "Verbose logging", false)
    .option(
      "--probe",
      "Also attempt a live Baileys connect (can conflict if gateway is already connected)",
      true,
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
        await healthCommand(
          {
            json: Boolean(opts.json),
            timeoutMs: timeout,
            probe: opts.probe ?? true,
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

  return program;
}
