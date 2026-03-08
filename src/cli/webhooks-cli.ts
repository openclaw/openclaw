import type { Command } from "commander";
import { danger } from "../globals.js";
import {
  type GmailRunOptions,
  type GmailSetupOptions,
  runGmailService,
  runGmailSetup,
} from "../hooks/gmail-ops.js";
import {
  DEFAULT_GMAIL_LABEL,
  DEFAULT_GMAIL_MAX_BYTES,
  DEFAULT_GMAIL_RENEW_MINUTES,
  DEFAULT_GMAIL_SERVE_BIND,
  DEFAULT_GMAIL_SERVE_PATH,
  DEFAULT_GMAIL_SERVE_PORT,
  DEFAULT_GMAIL_SUBSCRIPTION,
  DEFAULT_GMAIL_TOPIC,
} from "../hooks/gmail.js";
import {
  type ImapRunOptions,
  type ImapSetupOptions,
  runImapService,
  runImapSetup,
} from "../hooks/imap-ops.js";
import {
  DEFAULT_IMAP_FOLDER,
  DEFAULT_IMAP_MAX_BYTES,
  DEFAULT_IMAP_POLL_INTERVAL_SECONDS,
  DEFAULT_IMAP_QUERY,
} from "../hooks/imap.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

export function registerWebhooksCli(program: Command) {
  const webhooks = program
    .command("webhooks")
    .description("Webhook helpers and integrations")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/webhooks", "docs.openclaw.ai/cli/webhooks")}\n`,
    );

  const gmail = webhooks.command("gmail").description("Gmail Pub/Sub hooks (via gogcli)");

  gmail
    .command("setup")
    .description("Configure Gmail watch + Pub/Sub + OpenClaw hooks")
    .requiredOption("--account <email>", "Gmail account to watch")
    .option("--project <id>", "GCP project id (OAuth client owner)")
    .option("--topic <name>", "Pub/Sub topic name", DEFAULT_GMAIL_TOPIC)
    .option("--subscription <name>", "Pub/Sub subscription name", DEFAULT_GMAIL_SUBSCRIPTION)
    .option("--label <label>", "Gmail label to watch", DEFAULT_GMAIL_LABEL)
    .option("--hook-url <url>", "OpenClaw hook URL")
    .option("--hook-token <token>", "OpenClaw hook token")
    .option("--push-token <token>", "Push token for gog watch serve")
    .option("--bind <host>", "gog watch serve bind host", DEFAULT_GMAIL_SERVE_BIND)
    .option("--port <port>", "gog watch serve port", String(DEFAULT_GMAIL_SERVE_PORT))
    .option("--path <path>", "gog watch serve path", DEFAULT_GMAIL_SERVE_PATH)
    .option("--include-body", "Include email body snippets", true)
    .option("--max-bytes <n>", "Max bytes for body snippets", String(DEFAULT_GMAIL_MAX_BYTES))
    .option(
      "--renew-minutes <n>",
      "Renew watch every N minutes",
      String(DEFAULT_GMAIL_RENEW_MINUTES),
    )
    .option("--tailscale <mode>", "Expose push endpoint via tailscale (funnel|serve|off)", "funnel")
    .option("--tailscale-path <path>", "Path for tailscale serve/funnel")
    .option(
      "--tailscale-target <target>",
      "Tailscale serve/funnel target (port, host:port, or URL)",
    )
    .option("--push-endpoint <url>", "Explicit Pub/Sub push endpoint")
    .option("--json", "Output JSON summary", false)
    .action(async (opts) => {
      try {
        const parsed = parseGmailSetupOptions(opts);
        await runGmailSetup(parsed);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  gmail
    .command("run")
    .description("Run gog watch serve + auto-renew loop")
    .option("--account <email>", "Gmail account to watch")
    .option("--topic <topic>", "Pub/Sub topic path (projects/.../topics/..)")
    .option("--subscription <name>", "Pub/Sub subscription name")
    .option("--label <label>", "Gmail label to watch")
    .option("--hook-url <url>", "OpenClaw hook URL")
    .option("--hook-token <token>", "OpenClaw hook token")
    .option("--push-token <token>", "Push token for gog watch serve")
    .option("--bind <host>", "gog watch serve bind host")
    .option("--port <port>", "gog watch serve port")
    .option("--path <path>", "gog watch serve path")
    .option("--include-body", "Include email body snippets")
    .option("--max-bytes <n>", "Max bytes for body snippets")
    .option("--renew-minutes <n>", "Renew watch every N minutes")
    .option("--tailscale <mode>", "Expose push endpoint via tailscale (funnel|serve|off)")
    .option("--tailscale-path <path>", "Path for tailscale serve/funnel")
    .option(
      "--tailscale-target <target>",
      "Tailscale serve/funnel target (port, host:port, or URL)",
    )
    .action(async (opts) => {
      try {
        const parsed = parseGmailRunOptions(opts);
        await runGmailService(parsed);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  const imap = webhooks.command("imap").description("IMAP email hooks (via himalaya)");

  imap
    .command("setup")
    .description("Configure IMAP watcher + OpenClaw hooks")
    .requiredOption("--account <name>", "Himalaya account name")
    .requiredOption(
      "--allowed-senders <emails>",
      "Comma-separated list of allowlisted sender emails",
    )
    .option("--folder <name>", "IMAP folder to watch", DEFAULT_IMAP_FOLDER)
    .option(
      "--poll-interval <seconds>",
      "Poll interval in seconds",
      String(DEFAULT_IMAP_POLL_INTERVAL_SECONDS),
    )
    .option("--include-body", "Include email body content", true)
    .option("--max-bytes <n>", "Max body bytes per message", String(DEFAULT_IMAP_MAX_BYTES))
    .option("--mark-seen", "Mark messages as seen after processing", true)
    .option("--hook-url <url>", "OpenClaw hook URL")
    .option("--hook-token <token>", "OpenClaw hook token")
    .option("--himalaya-config <path>", "Path to himalaya config file")
    .option("--query <query>", "Envelope filter query", DEFAULT_IMAP_QUERY)
    .option("--json", "Output JSON summary", false)
    .action(async (opts) => {
      try {
        const parsed = parseImapSetupOptions(opts);
        await runImapSetup(parsed);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  imap
    .command("run")
    .description("Run IMAP poll watcher loop")
    .option("--account <name>", "Himalaya account name")
    .option("--allowed-senders <emails>", "Comma-separated list of allowlisted sender emails")
    .option("--folder <name>", "IMAP folder to watch")
    .option("--poll-interval <seconds>", "Poll interval in seconds")
    .option("--include-body", "Include email body content")
    .option("--max-bytes <n>", "Max body bytes per message")
    .option("--mark-seen", "Mark messages as seen after processing")
    .option("--no-mark-seen", "Do not mark messages as seen after processing")
    .option("--hook-url <url>", "OpenClaw hook URL")
    .option("--hook-token <token>", "OpenClaw hook token")
    .option("--himalaya-config <path>", "Path to himalaya config file")
    .option("--query <query>", "Envelope filter query")
    .action(async (opts) => {
      try {
        const parsed = parseImapRunOptions(opts);
        await runImapService(parsed);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}

function parseGmailSetupOptions(raw: Record<string, unknown>): GmailSetupOptions {
  const accountRaw = raw.account;
  const account = typeof accountRaw === "string" ? accountRaw.trim() : "";
  if (!account) {
    throw new Error("--account is required");
  }
  const common = parseGmailCommonOptions(raw);
  return {
    account,
    project: stringOption(raw.project),
    ...gmailOptionsFromCommon(common),
    pushEndpoint: stringOption(raw.pushEndpoint),
    json: Boolean(raw.json),
  };
}

function parseGmailRunOptions(raw: Record<string, unknown>): GmailRunOptions {
  const common = parseGmailCommonOptions(raw);
  return {
    account: stringOption(raw.account),
    ...gmailOptionsFromCommon(common),
  };
}

function parseGmailCommonOptions(raw: Record<string, unknown>) {
  return {
    topic: stringOption(raw.topic),
    subscription: stringOption(raw.subscription),
    label: stringOption(raw.label),
    hookUrl: stringOption(raw.hookUrl),
    hookToken: stringOption(raw.hookToken),
    pushToken: stringOption(raw.pushToken),
    bind: stringOption(raw.bind),
    port: numberOption(raw.port),
    path: stringOption(raw.path),
    includeBody: booleanOption(raw.includeBody),
    maxBytes: numberOption(raw.maxBytes),
    renewEveryMinutes: numberOption(raw.renewMinutes),
    tailscaleRaw: stringOption(raw.tailscale),
    tailscalePath: stringOption(raw.tailscalePath),
    tailscaleTarget: stringOption(raw.tailscaleTarget),
  };
}

function gmailOptionsFromCommon(
  common: ReturnType<typeof parseGmailCommonOptions>,
): Omit<GmailRunOptions, "account"> {
  return {
    topic: common.topic,
    subscription: common.subscription,
    label: common.label,
    hookUrl: common.hookUrl,
    hookToken: common.hookToken,
    pushToken: common.pushToken,
    bind: common.bind,
    port: common.port,
    path: common.path,
    includeBody: common.includeBody,
    maxBytes: common.maxBytes,
    renewEveryMinutes: common.renewEveryMinutes,
    tailscale: common.tailscaleRaw as GmailRunOptions["tailscale"],
    tailscalePath: common.tailscalePath,
    tailscaleTarget: common.tailscaleTarget,
  };
}

function stringOption(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function numberOption(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return Math.floor(n);
}

function booleanOption(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim();
    if (lower === "false" || lower === "0" || lower === "no" || lower === "off") {
      return false;
    }
    if (lower === "true" || lower === "1" || lower === "yes" || lower === "on") {
      return true;
    }
    // Non-empty string defaults to true
    return true;
  }
  return Boolean(value);
}

function parseImapSetupOptions(raw: Record<string, unknown>): ImapSetupOptions {
  const accountRaw = raw.account;
  const account = typeof accountRaw === "string" ? accountRaw.trim() : "";
  if (!account) {
    throw new Error("--account is required");
  }
  return {
    account,
    folder: stringOption(raw.folder),
    pollInterval: numberOption(raw.pollInterval),
    includeBody: booleanOption(raw.includeBody),
    maxBytes: numberOption(raw.maxBytes),
    markSeen: booleanOption(raw.markSeen),
    hookUrl: stringOption(raw.hookUrl),
    hookToken: stringOption(raw.hookToken),
    himalayaConfig: stringOption(raw.himalayaConfig),
    query: stringOption(raw.query),
    allowedSenders: parseAllowedSenders(raw.allowedSenders),
    json: Boolean(raw.json),
  };
}

function parseImapRunOptions(raw: Record<string, unknown>): ImapRunOptions {
  return {
    account: stringOption(raw.account),
    folder: stringOption(raw.folder),
    pollInterval: numberOption(raw.pollInterval),
    includeBody: booleanOption(raw.includeBody),
    maxBytes: numberOption(raw.maxBytes),
    markSeen: booleanOption(raw.markSeen),
    hookUrl: stringOption(raw.hookUrl),
    hookToken: stringOption(raw.hookToken),
    himalayaConfig: stringOption(raw.himalayaConfig),
    query: stringOption(raw.query),
    allowedSenders: parseAllowedSenders(raw.allowedSenders),
  };
}

function parseAllowedSenders(value: unknown): string[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parts = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}
