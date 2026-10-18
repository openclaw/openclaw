import {
  normalizeOptionalString,
  readNonBlankString,
} from "@openclaw/normalization-core/string-coerce";
import { isSystemMonitorDeclaration } from "../../cron/system-owned-declaration.js";
import type { CronJob } from "../../cron/types.js";
import { CronCliError } from "./cron-cli-error.js";
import {
  assertCronTimeoutSupported,
  parseCronCommandArgv,
  parseCronCommandEnv,
  parseCronIntegerOption,
  parseCronNoOutputTimeoutOption,
  parseCronStringList,
  parseCronThinkingOption,
} from "./shared.js";
import { parseCronThreadIdOption } from "./thread-id-shared.js";
import { readCronPayloadScript } from "./trigger-options.js";

const assignIf = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  shouldAssign = value !== undefined,
) => {
  if (shouldAssign) {
    target[key] = value;
  }
};

export async function resolveCronEditPayloadDeliveryPatch(
  opts: Record<string, unknown>,
  loadExistingJob: () => Promise<CronJob>,
  webhookUrl: string | undefined,
  commandCwd: string | undefined,
): Promise<Record<string, unknown>> {
  const patch: Record<string, unknown> = {};
  const hasSystemEventPatch = typeof opts.systemEvent === "string";
  const scriptPath = readNonBlankString(opts.script);
  const commandShell = readNonBlankString(opts.command);
  const commandArgv = parseCronCommandArgv(opts.commandArgv);
  if (commandShell && commandArgv) {
    throw new CronCliError(
      "Pass command payload either with --command or --command-argv, not both.",
    );
  }
  // Raw flag presence owns the set/clear mutex even when normalization omits a blank value.
  const hasModel = typeof opts.model === "string";
  const model = normalizeOptionalString(opts.model);
  if (hasModel && opts.clearModel) {
    throw new CronCliError("Use --model or --clear-model, not both");
  }
  const hasThinking = typeof opts.thinking === "string";
  const thinking = normalizeOptionalString(opts.thinking);
  if (hasThinking && opts.clearThinking) {
    throw new CronCliError("Use --thinking or --clear-thinking, not both");
  }
  const fallbacks = parseCronStringList(opts.fallbacks);
  if (typeof opts.fallbacks === "string" && opts.clearFallbacks) {
    throw new CronCliError("Use --fallbacks or --clear-fallbacks, not both");
  }
  const toolsAllow = parseCronStringList(opts.tools);
  const timeoutSeconds = parseCronIntegerOption(
    opts.timeoutSeconds,
    "--timeout-seconds",
    "non-negative",
  );
  const hasTimeoutSeconds = timeoutSeconds !== undefined;
  const noOutputTimeoutSeconds = parseCronNoOutputTimeoutOption(opts);
  const outputMaxBytes = parseCronIntegerOption(opts.outputMaxBytes, "--output-max-bytes");
  const scriptTimeoutSeconds = parseCronIntegerOption(
    opts.scriptTimeoutSeconds,
    "--script-timeout-seconds",
  );
  const scriptToolBudget = parseCronIntegerOption(opts.scriptToolBudget, "--script-tool-budget");

  const hasWebhookDelivery = Boolean(webhookUrl);
  const hasDeliveryModeFlag =
    opts.announce || typeof opts.deliver === "boolean" || hasWebhookDelivery;
  const threadId = parseCronThreadIdOption(opts.threadId);
  const deliveryFields = (
    [
      ["channel", "channel", opts.channel, opts.clearChannel],
      ["to", "to", opts.to, opts.clearTo],
      ["thread-id", "threadId", threadId, opts.clearThreadId],
      ["account", "accountId", opts.account, opts.clearAccount],
    ] as const
  ).map(([flag, key, value, clear]) => ({
    flag,
    key,
    value,
    clear,
    present: key === "threadId" ? typeof value === "number" : typeof value === "string",
  }));
  const hasDeliveryTarget = deliveryFields.some((field) => field.present || field.clear);
  const hasBestEffort = typeof opts.bestEffortDeliver === "boolean";
  if (hasWebhookDelivery && hasDeliveryTarget) {
    throw new CronCliError("--webhook cannot be combined with chat delivery options.");
  }
  for (const { flag, present, clear } of deliveryFields) {
    if (present && clear) {
      throw new CronCliError(`Use --${flag} or --clear-${flag}, not both`);
    }
  }

  // Unlike cwd, command stdin intentionally accepts empty and whitespace strings.
  const hasCommandInput = typeof opts.commandInput === "string";
  const hasCommandSpecificPayloadField =
    Boolean(commandShell) ||
    Boolean(commandArgv) ||
    Boolean(commandCwd) ||
    hasCommandInput ||
    opts.commandEnv !== undefined ||
    noOutputTimeoutSeconds !== undefined ||
    outputMaxBytes !== undefined;
  const hasToolsAllowPatch =
    typeof opts.tools === "string" || Array.isArray(opts.tools) || Boolean(opts.clearTools);
  const hasAgentTurnSpecificPayloadField =
    typeof opts.message === "string" ||
    Boolean(model) ||
    Boolean(opts.clearModel) ||
    typeof opts.fallbacks === "string" ||
    Boolean(opts.clearFallbacks) ||
    Boolean(thinking) ||
    Boolean(opts.clearThinking) ||
    typeof opts.lightContext === "boolean";
  const hasScriptSpecificPayloadField =
    Boolean(scriptPath) || scriptTimeoutSeconds !== undefined || scriptToolBudget !== undefined;
  if (hasTimeoutSeconds && hasScriptSpecificPayloadField) {
    assertCronTimeoutSupported("script");
  }
  if (hasTimeoutSeconds && hasSystemEventPatch) {
    assertCronTimeoutSupported("systemEvent");
  }
  const requestedPayloadKinds = (
    [
      ["systemEvent", hasSystemEventPatch],
      ["agentTurn", hasAgentTurnSpecificPayloadField],
      ["command", hasCommandSpecificPayloadField],
      ["script", hasScriptSpecificPayloadField],
    ] as const
  )
    .filter(([, requested]) => requested)
    .map(([kind]) => kind);
  let payloadKind: CronJob["payload"]["kind"] | undefined = requestedPayloadKinds[0];
  if (requestedPayloadKinds.length === 0 && (hasTimeoutSeconds || hasToolsAllowPatch)) {
    // Shared policy-only edits preserve the stored execution kind.
    const existingJob = await loadExistingJob();
    payloadKind = existingJob.payload.kind;
    if (hasTimeoutSeconds) {
      assertCronTimeoutSupported(payloadKind);
    }
    if (isSystemMonitorDeclaration(existingJob.declarationKey)) {
      throw new CronCliError(
        hasTimeoutSeconds
          ? `--timeout-seconds is not supported for ${payloadKind} jobs.`
          : "System-owned cron jobs cannot be edited by cron clients.",
      );
    }
  } else if (requestedPayloadKinds.length > 1) {
    throw new CronCliError("Choose at most one payload change");
  }
  let payload: Record<string, unknown> | undefined;
  if (payloadKind === "systemEvent") {
    payload = { kind: "systemEvent" };
    assignIf(payload, "text", String(opts.systemEvent), hasSystemEventPatch);
  } else if (payloadKind === "agentTurn") {
    payload = { kind: "agentTurn" };
    assignIf(payload, "message", String(opts.message), typeof opts.message === "string");
    assignIf(payload, "model", opts.clearModel ? null : model);
    assignIf(payload, "fallbacks", fallbacks, typeof opts.fallbacks === "string");
    assignIf(payload, "fallbacks", null, Boolean(opts.clearFallbacks));
    if (opts.clearThinking) {
      payload.thinking = null;
    } else {
      assignIf(payload, "thinking", parseCronThinkingOption(thinking), Boolean(thinking));
    }
    assignIf(payload, "timeoutSeconds", timeoutSeconds, hasTimeoutSeconds);
    assignIf(payload, "lightContext", opts.lightContext, typeof opts.lightContext === "boolean");
  } else if (payloadKind === "command") {
    payload = { kind: "command" };
    assignIf(payload, "argv", commandArgv, Boolean(commandArgv));
    assignIf(payload, "argv", ["sh", "-lc", commandShell], Boolean(commandShell));
    assignIf(payload, "cwd", commandCwd, Boolean(commandCwd));
    assignIf(payload, "env", parseCronCommandEnv(opts.commandEnv), opts.commandEnv !== undefined);
    assignIf(payload, "input", opts.commandInput, hasCommandInput);
    assignIf(payload, "timeoutSeconds", timeoutSeconds, hasTimeoutSeconds);
    assignIf(payload, "noOutputTimeoutSeconds", noOutputTimeoutSeconds);
    assignIf(payload, "outputMaxBytes", outputMaxBytes);
  } else if (payloadKind === "script") {
    payload = { kind: "script" };
    if (scriptPath) {
      payload.script = await readCronPayloadScript(scriptPath);
    }
    assignIf(payload, "timeoutSeconds", scriptTimeoutSeconds);
    assignIf(payload, "toolBudget", scriptToolBudget);
  }
  if (payload) {
    if (opts.clearTools) {
      // Clearing a restriction means an explicit unrestricted grant. Persisting
      // a wildcard avoids creating a new capless legacy job at the upgrade boundary.
      payload.toolsAllow = ["*"];
    } else if (toolsAllow) {
      payload.toolsAllow = toolsAllow;
    }
    patch.payload = payload;
  }

  if (hasDeliveryModeFlag || hasDeliveryTarget || hasBestEffort) {
    const delivery: Record<string, unknown> = {};
    if (hasDeliveryModeFlag) {
      delivery.mode = hasWebhookDelivery
        ? "webhook"
        : opts.announce || opts.deliver === true
          ? "announce"
          : "none";
    } else if (opts.bestEffortDeliver === true) {
      // Back-compat: enabling best-effort historically implied announce mode.
      delivery.mode = "announce";
    }
    for (const { key, value, present, clear } of deliveryFields) {
      if (key === "to" && hasWebhookDelivery) {
        delivery.to = webhookUrl;
      } else if (clear || present) {
        delivery[key] = clear ? null : key === "threadId" ? value : normalizeOptionalString(value);
      }
    }
    if (typeof opts.bestEffortDeliver === "boolean") {
      delivery.bestEffort = opts.bestEffortDeliver;
    }
    patch.delivery = delivery;
  }

  return patch;
}
