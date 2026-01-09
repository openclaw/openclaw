import type { CliDeps } from "../cli/deps.js";
import { withProgress } from "../cli/progress.js";
import { loadConfig } from "../config/config.js";
import { success } from "../globals.js";
import type { OutboundDeliveryResult } from "../infra/outbound/deliver.js";
import { buildOutboundResultEnvelope } from "../infra/outbound/envelope.js";
import {
  buildOutboundDeliveryJson,
  formatGatewaySummary,
  formatOutboundDeliverySummary,
} from "../infra/outbound/format.js";
import {
  type MessagePollResult,
  type MessageSendResult,
  sendMessage,
  sendPoll,
} from "../infra/outbound/message.js";
import type { RuntimeEnv } from "../runtime.js";
import { normalizeMessageProvider } from "../utils/message-provider.js";

type MessageSendOpts = {
  to: string;
  message: string;
  provider?: string;
  json?: boolean;
  dryRun?: boolean;
  media?: string;
  gifPlayback?: boolean;
  account?: string;
};

type MessagePollOpts = {
  to: string;
  question: string;
  option: string[];
  maxSelections?: string;
  durationHours?: string;
  provider?: string;
  json?: boolean;
  dryRun?: boolean;
};

function parseIntOption(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a number`);
  }
  return parsed;
}

function logSendDryRun(
  opts: MessageSendOpts,
  provider: string,
  runtime: RuntimeEnv,
) {
  runtime.log(
    `[dry-run] would send via ${provider} -> ${opts.to}: ${opts.message}${
      opts.media ? ` (media ${opts.media})` : ""
    }`,
  );
}

function logPollDryRun(result: MessagePollResult, runtime: RuntimeEnv) {
  runtime.log(
    `[dry-run] would send poll via ${result.provider} -> ${result.to}:\n  Question: ${result.question}\n  Options: ${result.options.join(
      ", ",
    )}\n  Max selections: ${result.maxSelections}`,
  );
}

function logSendResult(
  result: MessageSendResult,
  opts: MessageSendOpts,
  runtime: RuntimeEnv,
) {
  if (result.via === "direct") {
    const directResult = result.result as OutboundDeliveryResult | undefined;
    const summary = formatOutboundDeliverySummary(
      result.provider,
      directResult,
    );
    runtime.log(success(summary));
    if (opts.json) {
      runtime.log(
        JSON.stringify(
          buildOutboundDeliveryJson({
            provider: result.provider,
            via: "direct",
            to: opts.to,
            result: directResult,
            mediaUrl: opts.media ?? null,
          }),
          null,
          2,
        ),
      );
    }
    return;
  }

  const gatewayResult = result.result as { messageId?: string } | undefined;
  runtime.log(
    success(
      formatGatewaySummary({
        provider: result.provider,
        messageId: gatewayResult?.messageId ?? null,
      }),
    ),
  );
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        buildOutboundResultEnvelope({
          delivery: buildOutboundDeliveryJson({
            provider: result.provider,
            via: "gateway",
            to: opts.to,
            result: gatewayResult,
            mediaUrl: opts.media ?? null,
          }),
        }),
        null,
        2,
      ),
    );
  }
}

export async function messageSendCommand(
  opts: MessageSendOpts,
  deps: CliDeps,
  runtime: RuntimeEnv,
) {
  const provider = normalizeMessageProvider(opts.provider) ?? "whatsapp";
  if (opts.dryRun) {
    logSendDryRun(opts, provider, runtime);
    return;
  }

  const result = await withProgress(
    {
      label: `Sending via ${provider}...`,
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await sendMessage({
        cfg: loadConfig(),
        to: opts.to,
        content: opts.message,
        provider,
        mediaUrl: opts.media,
        gifPlayback: opts.gifPlayback,
        accountId: opts.account,
        dryRun: opts.dryRun,
        deps: deps
          ? {
              sendWhatsApp: deps.sendMessageWhatsApp,
              sendTelegram: deps.sendMessageTelegram,
              sendDiscord: deps.sendMessageDiscord,
              sendSlack: deps.sendMessageSlack,
              sendSignal: deps.sendMessageSignal,
              sendIMessage: deps.sendMessageIMessage,
            }
          : undefined,
        gateway: { clientName: "cli", mode: "cli" },
      }),
  );

  logSendResult(result, opts, runtime);
}

export async function messagePollCommand(
  opts: MessagePollOpts,
  _deps: CliDeps,
  runtime: RuntimeEnv,
) {
  const provider = (opts.provider ?? "whatsapp").toLowerCase();
  const maxSelections = parseIntOption(opts.maxSelections, "max-selections");
  const durationHours = parseIntOption(opts.durationHours, "duration-hours");

  if (opts.dryRun) {
    const result = await sendPoll({
      cfg: loadConfig(),
      to: opts.to,
      question: opts.question,
      options: opts.option,
      maxSelections,
      durationHours,
      provider,
      dryRun: true,
      gateway: { clientName: "cli", mode: "cli" },
    });
    logPollDryRun(result, runtime);
    return;
  }

  const result = await withProgress(
    {
      label: `Sending poll via ${provider}...`,
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await sendPoll({
        cfg: loadConfig(),
        to: opts.to,
        question: opts.question,
        options: opts.option,
        maxSelections,
        durationHours,
        provider,
        dryRun: opts.dryRun,
        gateway: { clientName: "cli", mode: "cli" },
      }),
  );

  runtime.log(
    success(
      formatGatewaySummary({
        action: "Poll sent",
        provider,
        messageId: result.result?.messageId ?? null,
      }),
    ),
  );
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          ...buildOutboundResultEnvelope({
            delivery: buildOutboundDeliveryJson({
              provider,
              via: "gateway",
              to: opts.to,
              result: result.result,
              mediaUrl: null,
            }),
          }),
          question: result.question,
          options: result.options,
          maxSelections: result.maxSelections,
          durationHours: result.durationHours,
        },
        null,
        2,
      ),
    );
  }
}
