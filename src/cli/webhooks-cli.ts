import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
// Webhook CLI registrations, currently Gmail Pub/Sub setup and service runner commands.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
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
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime } from "../runtime.js";
import { formatCliCommand } from "./command-format.js";
import { formatDocsHelp } from "./help-format.js";

function addGmailDeliveryOptions(command: Command, defaults = false): Command {
  return command
    .option(
      "--subscription <name>",
      "Pub/Sub subscription name",
      defaults ? DEFAULT_GMAIL_SUBSCRIPTION : undefined,
    )
    .option("--label <label>", "Gmail label to watch", defaults ? DEFAULT_GMAIL_LABEL : undefined)
    .option("--hook-url <url>", "OpenClaw hook URL")
    .option("--hook-token <token>", "OpenClaw hook token")
    .option("--push-token <token>", "Push token for gog watch serve")
    .option(
      "--bind <host>",
      "gog watch serve bind host",
      defaults ? DEFAULT_GMAIL_SERVE_BIND : undefined,
    )
    .option(
      "--port <port>",
      "gog watch serve port",
      defaults ? String(DEFAULT_GMAIL_SERVE_PORT) : undefined,
    )
    .option(
      "--path <path>",
      "gog watch serve path",
      defaults ? DEFAULT_GMAIL_SERVE_PATH : undefined,
    )
    .option("--include-body", "Include email body snippets", defaults ? true : undefined)
    .option(
      "--max-bytes <n>",
      "Max bytes for body snippets",
      defaults ? String(DEFAULT_GMAIL_MAX_BYTES) : undefined,
    )
    .option(
      "--renew-minutes <n>",
      "Renew watch every N minutes",
      defaults ? String(DEFAULT_GMAIL_RENEW_MINUTES) : undefined,
    )
    .option(
      "--tailscale <mode>",
      "Expose push endpoint via tailscale (funnel|serve|off)",
      defaults ? "funnel" : undefined,
    )
    .option("--tailscale-path <path>", "Path for tailscale serve/funnel")
    .option(
      "--tailscale-target <target>",
      "Tailscale serve/funnel target (port, host:port, or URL)",
    );
}

/** Register webhook-related subcommands on the root Commander program. */
export function registerWebhooksCli(program: Command) {
  const webhooks = program
    .command("webhooks")
    .description("Webhook helpers and integrations")
    .addHelpText("after", () => formatDocsHelp("/cli/webhooks"));

  const gmail = webhooks.command("gmail").description("Gmail Pub/Sub hooks (via gogcli)");

  addGmailDeliveryOptions(
    gmail
      .command("setup")
      .description("Configure Gmail watch + Pub/Sub + OpenClaw hooks")
      .requiredOption("--account <email>", "Gmail account to watch")
      .option("--project <id>", "GCP project id (OAuth client owner)")
      .option("--topic <name>", "Pub/Sub topic name", DEFAULT_GMAIL_TOPIC),
    true,
  )
    .option("--push-endpoint <url>", "Explicit Pub/Sub push endpoint")
    .option("--json", "Output JSON summary", false)
    .action(async (opts) => {
      try {
        const parsed = parseGmailSetupOptions(opts);
        await runGmailSetup(parsed);
      } catch (err) {
        if (opts.json) {
          throw new Error(formatErrorMessage(err), { cause: err });
        }
        defaultRuntime.error(danger(formatErrorMessage(err)));
        defaultRuntime.exit(1);
      }
    });

  addGmailDeliveryOptions(
    gmail
      .command("run")
      .description("Run gog watch serve + auto-renew loop")
      .option("--account <email>", "Gmail account to watch")
      .option("--topic <topic>", "Pub/Sub topic path (projects/.../topics/..)"),
  ).action(async (opts) => {
    try {
      const parsed = parseGmailRunOptions(opts);
      await runGmailService(parsed);
    } catch (err) {
      defaultRuntime.error(danger(formatErrorMessage(err)));
      defaultRuntime.exit(1);
    }
  });
}

function parseGmailSetupOptions(raw: Record<string, unknown>): GmailSetupOptions {
  const accountRaw = raw.account;
  const account = normalizeOptionalString(accountRaw) ?? "";
  if (!account) {
    throw new Error(
      `--account is required. Example: ${formatCliCommand("openclaw webhooks gmail setup --account default")}.`,
    );
  }
  const common = parseGmailCommonOptions(raw);
  return {
    account,
    project: normalizeOptionalString(raw.project),
    ...common,
    pushEndpoint: normalizeOptionalString(raw.pushEndpoint),
    json: Boolean(raw.json),
  };
}

function parseGmailRunOptions(raw: Record<string, unknown>): GmailRunOptions {
  const common = parseGmailCommonOptions(raw);
  return {
    account: normalizeOptionalString(raw.account),
    ...common,
  };
}

function parseGmailCommonOptions(raw: Record<string, unknown>): Omit<GmailRunOptions, "account"> {
  return {
    topic: normalizeOptionalString(raw.topic),
    subscription: normalizeOptionalString(raw.subscription),
    label: normalizeOptionalString(raw.label),
    hookUrl: normalizeOptionalString(raw.hookUrl),
    hookToken: normalizeOptionalString(raw.hookToken),
    pushToken: normalizeOptionalString(raw.pushToken),
    bind: normalizeOptionalString(raw.bind),
    port: numberOption(raw.port, "--port"),
    path: normalizeOptionalString(raw.path),
    includeBody: booleanOption(raw.includeBody),
    maxBytes: numberOption(raw.maxBytes, "--max-bytes"),
    renewEveryMinutes: numberOption(raw.renewMinutes, "--renew-minutes"),
    tailscale: tailscaleModeOption(raw.tailscale),
    tailscalePath: normalizeOptionalString(raw.tailscalePath),
    tailscaleTarget: normalizeOptionalString(raw.tailscaleTarget),
  };
}

function tailscaleModeOption(value: unknown): GmailRunOptions["tailscale"] {
  if (value === undefined || value === null) {
    return undefined;
  }
  const mode = normalizeOptionalString(value);
  if (mode === "funnel" || mode === "serve" || mode === "off") {
    return mode;
  }
  throw new Error("Invalid --tailscale (must be funnel, serve, or off).");
}

function numberOption(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const n = parseStrictPositiveInteger(value);
  if (n === undefined) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return n;
}

function booleanOption(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return Boolean(value);
}
