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
  type WsEventsRunOptions,
  type WsEventsSetupOptions,
  runWsEventsService,
  runWsEventsSetup,
} from "../hooks/ws-events-ops.js";
import {
  DEFAULT_WS_EVENTS_MAX_MESSAGES,
  DEFAULT_WS_EVENTS_POLL_INTERVAL,
} from "../hooks/ws-events.js";
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

  const events = webhooks.command("events").description("Google Workspace Events hooks (via gws)");

  events
    .command("setup")
    .description("Configure workspace events subscription + OpenClaw hooks")
    .requiredOption(
      "--target <uri>",
      "Workspace resource URI (e.g. //chat.googleapis.com/spaces/X)",
    )
    .requiredOption(
      "--event-types <types>",
      "Comma-separated event types (e.g. google.workspace.chat.message.v1.created)",
    )
    .requiredOption("--project <id>", "GCP project id")
    .option("--subscription <name>", "Reuse existing Pub/Sub subscription")
    .option("--hook-url <url>", "OpenClaw hook URL")
    .option("--hook-token <token>", "OpenClaw hook token")
    .option(
      "--poll-interval <n>",
      "Poll interval in seconds",
      String(DEFAULT_WS_EVENTS_POLL_INTERVAL),
    )
    .option("--max-messages <n>", "Max messages per poll", String(DEFAULT_WS_EVENTS_MAX_MESSAGES))
    .option("--cleanup", "Delete Pub/Sub resources on exit", false)
    .option("--json", "Output JSON summary", false)
    .action(async (opts) => {
      try {
        const parsed = parseWsEventsSetupOptions(opts);
        await runWsEventsSetup(parsed);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  events
    .command("run")
    .description("Run workspace events subscription service")
    .option("--target <uri>", "Workspace resource URI")
    .option("--event-types <types>", "Comma-separated event types")
    .option("--project <id>", "GCP project id")
    .option("--subscription <name>", "Reuse existing Pub/Sub subscription")
    .option("--hook-url <url>", "OpenClaw hook URL")
    .option("--hook-token <token>", "OpenClaw hook token")
    .option("--poll-interval <n>", "Poll interval in seconds")
    .option("--max-messages <n>", "Max messages per poll")
    .option("--cleanup", "Delete Pub/Sub resources on exit")
    .action(async (opts) => {
      try {
        const parsed = parseWsEventsRunOptions(opts);
        await runWsEventsService(parsed);
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
  return Boolean(value);
}

function parseEventTypes(raw: unknown): string[] {
  if (typeof raw !== "string") {
    return [];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseWsEventsSetupOptions(raw: Record<string, unknown>): WsEventsSetupOptions {
  const target = stringOption(raw.target);
  if (!target) {
    throw new Error("--target is required");
  }
  const eventTypes = parseEventTypes(raw.eventTypes);
  if (eventTypes.length === 0) {
    throw new Error("--event-types is required (comma-separated)");
  }
  const project = stringOption(raw.project);
  if (!project) {
    throw new Error("--project is required");
  }
  return {
    target,
    eventTypes,
    project,
    subscription: stringOption(raw.subscription),
    hookUrl: stringOption(raw.hookUrl),
    hookToken: stringOption(raw.hookToken),
    pollInterval: numberOption(raw.pollInterval),
    maxMessages: numberOption(raw.maxMessages),
    cleanup: booleanOption(raw.cleanup),
    json: Boolean(raw.json),
  };
}

function parseWsEventsRunOptions(raw: Record<string, unknown>): WsEventsRunOptions {
  const eventTypes = raw.eventTypes ? parseEventTypes(raw.eventTypes) : undefined;
  return {
    target: stringOption(raw.target),
    eventTypes,
    project: stringOption(raw.project),
    subscription: stringOption(raw.subscription),
    hookUrl: stringOption(raw.hookUrl),
    hookToken: stringOption(raw.hookToken),
    pollInterval: numberOption(raw.pollInterval),
    maxMessages: numberOption(raw.maxMessages),
    cleanup: booleanOption(raw.cleanup),
  };
}
