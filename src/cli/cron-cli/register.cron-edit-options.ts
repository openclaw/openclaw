import {
  normalizeOptionalString,
  readNonBlankString,
} from "@openclaw/normalization-core/string-coerce";
import type { CronJob } from "../../cron/types.js";
import { CronCliError } from "./cron-cli-error.js";
import { parseCronDeliveryPolicyOptions } from "./register.cron-options.js";
import {
  assertCronTimeoutSupported,
  parseCronCommandArgv,
  parseCronCommandEnv,
  parseCronIntegerOption,
  parseCronNoOutputTimeoutOption,
  parseCronStringList,
  parseCronThinkingOption,
} from "./shared.js";
import { normalizeCronSessionTargetOption, parseCronThreadIdOption } from "./thread-id-shared.js";
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
  const deliveryPolicy = parseCronDeliveryPolicyOptions(opts);
  const hasDeliveryPolicy = Object.keys(deliveryPolicy).length > 0;
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
  const hasDeliveryThreadId = typeof threadId === "number";
  const hasDeliveryRecipient = Boolean(normalizeOptionalString(opts.to));
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
    typeof opts.lightContext === "boolean" ||
    typeof opts.skipIfScratchEmpty === "boolean" ||
    typeof opts.includeReasoning === "boolean";
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
  } else if (requestedPayloadKinds.length > 1) {
    throw new CronCliError("Choose at most one payload change");
  }
  for (const [key, flag] of [
    ["skipIfScratchEmpty", "skip-if-scratch-empty"],
    ["includeReasoning", "include-reasoning"],
  ] as const) {
    if (
      typeof opts[key] === "boolean" &&
      typeof opts.message !== "string" &&
      (await loadExistingJob()).payload.kind !== "agentTurn"
    ) {
      throw new CronCliError(`--${flag}/--no-${flag} require an agentTurn job or --message`);
    }
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
    assignIf(
      payload,
      "skipIfScratchEmpty",
      opts.skipIfScratchEmpty,
      typeof opts.skipIfScratchEmpty === "boolean",
    );
    assignIf(
      payload,
      "includeReasoning",
      opts.includeReasoning,
      typeof opts.includeReasoning === "boolean",
    );
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

  if (hasDeliveryModeFlag || hasDeliveryTarget || hasBestEffort || hasDeliveryPolicy) {
    const delivery: Record<string, unknown> = { ...deliveryPolicy };
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
    if (hasDeliveryPolicy || hasDeliveryRecipient || hasDeliveryThreadId || hasWebhookDelivery) {
      const existing = await loadExistingJob();
      if (deliveryPolicy.target === "owner") {
        // Owner lookup must never inherit a group/topic or primary webhook URL.
        // Preserve channel/account constraints and an explicitly disabled mode.
        delivery.to = null;
        delivery.threadId = null;
        if (delivery.mode === undefined && existing.delivery?.mode === "webhook") {
          delivery.mode = "announce";
        }
      } else if (
        existing.delivery?.target === "owner" &&
        (hasDeliveryRecipient || hasDeliveryThreadId || hasWebhookDelivery)
      ) {
        delivery.target = null;
      }
      const mode = delivery.mode ?? existing.delivery?.mode;
      if (deliveryPolicy.target === "owner" || deliveryPolicy.directPolicy != null) {
        const sessionTarget =
          normalizeCronSessionTargetOption(opts.session) ?? existing.sessionTarget;
        if (sessionTarget === "main" || hasSystemEventPatch) {
          throw new CronCliError(
            "--delivery-target/--direct-policy require a non-main job; use --session isolated or session:<id>",
          );
        }
        if (mode === "webhook") {
          throw new CronCliError(
            "--direct-policy requires chat delivery; use --announce or --no-deliver",
          );
        }
      }
    }
    patch.delivery = delivery;
  }

  return patch;
}
