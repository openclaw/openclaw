import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readNonBlankString,
} from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { isSystemMonitorDeclaration } from "../../cron/system-owned-declaration.js";
import type { CronJob } from "../../cron/types.js";
import { normalizeHttpWebhookUrl } from "../../cron/webhook-url.js";
import { sanitizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { parseDurationMs } from "../parse-duration.js";
import { CronCliError } from "./cron-cli-error.js";
import { isUnknownCronGetMethodError, listCronJobsFromGateway } from "./list-jobs.js";
import { createCronOutputCommand } from "./output-mode.js";
import { registerCronMutationOptions } from "./register.cron-options.js";
import {
  applyExistingCronSchedulePatch,
  applyExistingStreamSchedulePatch,
  resolveCronEditScheduleRequest,
  validateStreamScheduleMetadata,
} from "./schedule-options.js";
import {
  assertCronCliJobSpec,
  assertCronTimeoutSupported,
  parseCronCommandArgv,
  parseCronCommandEnv,
  parseCronNoOutputTimeoutOption,
  parseCronStringList,
  parseCronThinkingOption,
  getCronChannelOptions,
  handleCronCliError,
  parseCronIntegerOption,
  parseCronStringOption,
  warnIfCronSchedulerDisabled,
  requireCronJobId,
} from "./shared.js";
import { normalizeCronSessionTargetOption, parseCronThreadIdOption } from "./thread-id-shared.js";
import { readCronPayloadScript, readCronTriggerScript } from "./trigger-options.js";

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

type CronJobForEdit = CronJob & { configRevision?: string };
type CronEditOptions = GatewayRpcOpts &
  Parameters<typeof resolveCronEditScheduleRequest>[0] &
  Record<string, unknown>;

async function readCronJobForEdit(opts: GatewayRpcOpts, id: string): Promise<CronJobForEdit> {
  try {
    return (await callGatewayFromCli("cron.get", opts, { id })) as CronJobForEdit;
  } catch (error) {
    if (!isUnknownCronGetMethodError(error)) {
      throw error;
    }
    // Protocol-v4 gateways shipped before cron.get; keep remote edits working
    // without paying the paginated lookup cost on current gateways.
    const inventory = await listCronJobsFromGateway(
      opts,
      { includeDisabled: true },
      { allowLegacyUnversionedPagination: true },
    );
    const existing = inventory.jobs.find((job) => job.id === id);
    if (!existing) {
      throw new CronCliError(`unknown automation id: ${id}`, { cause: error });
    }
    return existing;
  }
}

export function registerCronEditCommand(cron: Command) {
  addGatewayClientOptions(
    registerCronMutationOptions(
      createCronOutputCommand(cron, "edit")
        .description("Edit an automation (patch fields)")
        .argument("<id>", "Job id"),
      "edit",
    )
      .option("--clear-display-name", "Restore the stable name in list and detail views", false)
      .option("--enable", "Enable job", false)
      .option("--disable", "Disable job", false)
      .option("--clear-agent", "Unset agent and use default", false)
      .option("--clear-session-key", "Unset session key", false)
      .option("--clear-pacing", "Remove dynamic-cadence bounds", false)
      .option("--clear-trigger", "Remove the condition trigger", false)
      .option(
        "--clear-thinking",
        "Remove the per-job thinking override (restore normal cron thinking precedence)",
        false,
      )
      .option("--clear-fallbacks", "Remove per-job fallback override", false)
      .option(
        "--clear-model",
        "Remove the per-job model override (restore normal cron model precedence)",
        false,
      )
      .option("--no-light-context", "Disable lightweight bootstrap context for agent jobs")
      .option("--clear-tools", "Remove tool allow-list (use all tools)", false)
      .option("--clear-channel", "Unset the delivery channel", false)
      .option("--clear-to", "Unset the delivery destination", false)
      .option("--clear-thread-id", "Unset the Telegram forum topic thread id", false)
      .option("--clear-account", "Unset the per-job delivery account override", false)
      .option("--no-best-effort-deliver", "Fail job when delivery fails")
      .option("--failure-alert", "Enable failure alerts for this job")
      .option("--no-failure-alert", "Disable failure alerts for this job")
      .option("--failure-alert-after <n>", "Alert after N consecutive job errors")
      .option(
        "--failure-alert-channel <channel>",
        `Failure alert channel (${getCronChannelOptions()})`,
      )
      .option("--failure-alert-to <dest>", "Failure alert destination")
      .option("--failure-alert-cooldown <duration>", "Minimum time between alerts (e.g. 1h, 30m)")
      .option("--failure-alert-include-skipped", "Count consecutive skipped runs toward alerts")
      .option("--failure-alert-exclude-skipped", "Exclude skips except local-provider outages")
      .option("--failure-alert-mode <mode>", "Failure alert delivery mode (announce or webhook)")
      .option(
        "--failure-alert-account-id <id>",
        "Account ID for failure alert channel (multi-account setups)",
      )
      .action(async (idArg, opts: CronEditOptions) => {
        try {
          const id = requireCronJobId(idArg);
          if (opts.clearTools && opts.tools !== undefined) {
            throw new CronCliError("Use --tools or --clear-tools, not both");
          }
          if (typeof opts.script === "string" && !readNonBlankString(opts.script)) {
            throw new CronCliError("--script must not be blank");
          }
          if (typeof opts.command === "string" && !readNonBlankString(opts.command)) {
            throw new CronCliError("--command must not be blank");
          }
          const commandCwd = parseCronStringOption(opts.commandCwd, "--command-cwd");
          let existingJobPromise: Promise<CronJobForEdit> | undefined;
          let expectedConfigRevision: string | undefined;
          const readExistingCronJob = async (): Promise<CronJobForEdit> => {
            const existing = await (existingJobPromise ??= readCronJobForEdit(opts, id));
            if (typeof existing.configRevision === "string") {
              expectedConfigRevision = existing.configRevision;
            }
            return existing;
          };
          const sessionTarget =
            typeof opts.session === "string"
              ? normalizeCronSessionTargetOption(opts.session)
              : undefined;
          if (typeof opts.session === "string" && !sessionTarget) {
            throw new CronCliError("--session must be main, isolated, current, or session:<id>");
          }
          const initialPayloadKind = opts.systemEvent
            ? "systemEvent"
            : typeof opts.script === "string"
              ? "script"
              : opts.command || opts.commandArgv
                ? "command"
                : opts.message
                  ? "agentTurn"
                  : undefined;
          if (sessionTarget && initialPayloadKind) {
            await assertCronCliJobSpec({ sessionTarget, payload: { kind: initialPayloadKind } });
          }
          const hasExplicitChatDelivery =
            parseCronThreadIdOption(opts.threadId) !== undefined ||
            typeof opts.channel === "string" ||
            typeof opts.to === "string" ||
            typeof opts.account === "string";
          if (
            sessionTarget === "main" &&
            typeof opts.systemEvent === "string" &&
            hasExplicitChatDelivery
          ) {
            throw new CronCliError(
              "--channel, --to, --account, and --thread-id require a non-main agentTurn or command job with delivery.",
            );
          }
          const webhookUrl =
            typeof opts.webhook === "string"
              ? (normalizeHttpWebhookUrl(opts.webhook) ?? undefined)
              : undefined;
          if (typeof opts.webhook === "string" && !webhookUrl) {
            throw new CronCliError("--webhook must be a valid http(s) URL");
          }
          const hasWebhookDelivery = Boolean(webhookUrl);
          const deliveryModeFlagCount = [
            Boolean(opts.announce),
            typeof opts.deliver === "boolean",
            hasWebhookDelivery,
          ].filter(Boolean).length;
          if (deliveryModeFlagCount > 1) {
            throw new CronCliError("Choose at most one of --announce, --no-deliver, or --webhook.");
          }
          const triggerScriptPath = readNonBlankString(opts.triggerScript);
          if (typeof opts.triggerScript === "string" && !triggerScriptPath) {
            throw new CronCliError("--trigger-script must not be blank");
          }
          if (opts.clearTrigger && (triggerScriptPath || opts.triggerOnce)) {
            throw new CronCliError("Use --clear-trigger or trigger options, not both");
          }
          // Local input errors must not depend on Gateway availability, even when
          // another edit field needs the existing job.
          const triggerScript = triggerScriptPath
            ? await readCronTriggerScript(triggerScriptPath)
            : undefined;
          const patch: Record<string, unknown> = {};
          if (typeof opts.name === "string") {
            patch.name = opts.name;
          }
          const displayName = parseCronStringOption(opts.displayName, "--display-name");
          if (displayName && opts.clearDisplayName) {
            throw new CronCliError("Use --display-name or --clear-display-name, not both");
          }
          if (displayName || opts.clearDisplayName) {
            patch.displayName = displayName ?? null;
          }
          if (typeof opts.description === "string") {
            patch.description = opts.description;
          }
          if (opts.enable && opts.disable) {
            throw new CronCliError("Choose --enable or --disable, not both");
          }
          if (opts.enable || opts.disable) {
            patch.enabled = Boolean(opts.enable);
          }
          if (opts.deleteAfterRun && opts.keepAfterRun) {
            throw new CronCliError("Choose --delete-after-run or --keep-after-run, not both");
          }
          if (opts.deleteAfterRun || opts.keepAfterRun) {
            patch.deleteAfterRun = Boolean(opts.deleteAfterRun);
          }
          if (typeof opts.session === "string") {
            patch.sessionTarget = sessionTarget;
          }
          if (typeof opts.wake === "string") {
            const wakeMode = opts.wake.trim();
            if (wakeMode !== "now" && wakeMode !== "next-heartbeat") {
              throw new CronCliError("--wake must be now or next-heartbeat");
            }
            patch.wakeMode = wakeMode;
          }
          const agentId = parseCronStringOption(opts.agent, "--agent");
          if (agentId && opts.clearAgent) {
            throw new CronCliError("Use --agent or --clear-agent, not both");
          }
          if (agentId || opts.clearAgent) {
            patch.agentId = agentId ? sanitizeAgentId(agentId) : null;
          }
          const sessionKey = parseCronStringOption(opts.sessionKey, "--session-key");
          if (sessionKey && opts.clearSessionKey) {
            throw new CronCliError("Use --session-key or --clear-session-key, not both");
          }
          if (sessionKey || opts.clearSessionKey) {
            patch.sessionKey = sessionKey ?? null;
          }

          const pacingMin = parseCronStringOption(opts.pacingMin, "--pacing-min");
          const pacingMax = parseCronStringOption(opts.pacingMax, "--pacing-max");
          const hasPacingMin = typeof opts.pacingMin === "string";
          const hasPacingMax = typeof opts.pacingMax === "string";
          if (opts.clearPacing && (hasPacingMin || hasPacingMax)) {
            throw new CronCliError("Use --clear-pacing or pacing bounds, not both");
          }
          if (opts.clearPacing) {
            patch.pacing = null;
          } else if (hasPacingMin || hasPacingMax) {
            const existing = await readExistingCronJob();
            patch.pacing = {
              ...existing.pacing,
              ...(pacingMin ? { min: pacingMin } : {}),
              ...(pacingMax ? { max: pacingMax } : {}),
            };
          }
          if (opts.clearTrigger) {
            patch.trigger = null;
          } else if (triggerScript !== undefined) {
            const existing = await readExistingCronJob();
            patch.trigger = {
              ...existing.trigger,
              script: triggerScript,
              ...(opts.triggerOnce ? { once: true } : {}),
            };
          } else if (opts.triggerOnce) {
            const existing = await readExistingCronJob();
            if (!existing.trigger) {
              throw new CronCliError(
                "--trigger-once requires an existing trigger or --trigger-script",
              );
            }
            patch.trigger = { ...existing.trigger, once: true };
          }

          const scheduleRequest = resolveCronEditScheduleRequest(opts);
          if (scheduleRequest.kind === "direct") {
            if (scheduleRequest.schedule.kind === "stream") {
              const existing = await readExistingCronJob();
              if (existing.schedule.kind === "stream") {
                const metadataRequest = resolveCronEditScheduleRequest({
                  streamCwd: opts.streamCwd,
                  streamMode: opts.streamMode,
                  streamMatch: opts.streamMatch,
                  streamBatchMs: opts.streamBatchMs,
                  streamMaxBatchBytes: opts.streamMaxBatchBytes,
                });
                const merged =
                  metadataRequest.kind === "patch-existing-stream"
                    ? applyExistingStreamSchedulePatch(existing.schedule, metadataRequest)
                    : existing.schedule;
                patch.schedule = { ...merged, command: scheduleRequest.schedule.command };
              } else {
                validateStreamScheduleMetadata(scheduleRequest.schedule);
                patch.schedule = scheduleRequest.schedule;
              }
            } else if (
              scheduleRequest.schedule.kind === "cron" &&
              scheduleRequest.schedule.tz === undefined
            ) {
              const existing = await readExistingCronJob();
              patch.schedule =
                existing.schedule.kind === "cron" && existing.schedule.tz !== undefined
                  ? { ...scheduleRequest.schedule, tz: existing.schedule.tz }
                  : scheduleRequest.schedule;
            } else {
              patch.schedule = scheduleRequest.schedule;
            }
          } else if (scheduleRequest.kind === "patch-existing-cron") {
            const existing = await readExistingCronJob();
            patch.schedule = applyExistingCronSchedulePatch(existing.schedule, scheduleRequest);
          } else if (scheduleRequest.kind === "patch-existing-stream") {
            const existing = await readExistingCronJob();
            patch.schedule = applyExistingStreamSchedulePatch(existing.schedule, scheduleRequest);
          }

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
          const scriptToolBudget = parseCronIntegerOption(
            opts.scriptToolBudget,
            "--script-tool-budget",
          );

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
            Boolean(scriptPath) ||
            scriptTimeoutSeconds !== undefined ||
            scriptToolBudget !== undefined;
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
            const existingJob = await readExistingCronJob();
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
            assignIf(
              payload,
              "lightContext",
              opts.lightContext,
              typeof opts.lightContext === "boolean",
            );
          } else if (payloadKind === "command") {
            payload = { kind: "command" };
            assignIf(payload, "argv", commandArgv, Boolean(commandArgv));
            assignIf(payload, "argv", ["sh", "-lc", commandShell], Boolean(commandShell));
            assignIf(payload, "cwd", commandCwd, Boolean(commandCwd));
            assignIf(
              payload,
              "env",
              parseCronCommandEnv(opts.commandEnv),
              opts.commandEnv !== undefined,
            );
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
                delivery[key] = clear
                  ? null
                  : key === "threadId"
                    ? value
                    : normalizeOptionalString(value);
              }
            }
            if (typeof opts.bestEffortDeliver === "boolean") {
              delivery.bestEffort = opts.bestEffortDeliver;
            }
            patch.delivery = delivery;
          }

          const hasFailureAlertIncludeSkipped =
            typeof opts.failureAlertIncludeSkipped === "boolean";
          const hasFailureAlertExcludeSkipped =
            typeof opts.failureAlertExcludeSkipped === "boolean";
          if (hasFailureAlertIncludeSkipped && hasFailureAlertExcludeSkipped) {
            throw new CronCliError(
              "Use either --failure-alert-include-skipped or --failure-alert-exclude-skipped.",
            );
          }
          const hasFailureAlertFields =
            [
              "failureAlertAfter",
              "failureAlertChannel",
              "failureAlertTo",
              "failureAlertCooldown",
              "failureAlertMode",
              "failureAlertAccountId",
            ].some((key) => typeof opts[key] === "string") ||
            hasFailureAlertIncludeSkipped ||
            hasFailureAlertExcludeSkipped;
          const failureAlertFlag =
            typeof opts.failureAlert === "boolean" ? opts.failureAlert : undefined;
          if (failureAlertFlag === false && hasFailureAlertFields) {
            throw new CronCliError(
              "Use --no-failure-alert alone (without failure-alert-* options).",
            );
          }
          if (failureAlertFlag === false) {
            patch.failureAlert = false;
          } else if (failureAlertFlag === true || hasFailureAlertFields) {
            const failureAlert: Record<string, unknown> = {};
            if (typeof opts.failureAlertAfter === "string") {
              failureAlert.after = parseCronIntegerOption(
                opts.failureAlertAfter,
                "--failure-alert-after",
              );
            }
            if (typeof opts.failureAlertChannel === "string") {
              failureAlert.channel = normalizeOptionalLowercaseString(opts.failureAlertChannel);
            }
            if (typeof opts.failureAlertTo === "string") {
              failureAlert.to = normalizeOptionalString(opts.failureAlertTo);
            }
            if (typeof opts.failureAlertCooldown === "string") {
              let cooldownMs: number;
              try {
                cooldownMs = parseDurationMs(opts.failureAlertCooldown);
              } catch {
                throw new CronCliError("Invalid --failure-alert-cooldown.");
              }
              failureAlert.cooldownMs = cooldownMs;
            }
            if (hasFailureAlertIncludeSkipped || hasFailureAlertExcludeSkipped) {
              failureAlert.includeSkipped = hasFailureAlertIncludeSkipped;
            }
            if (typeof opts.failureAlertMode === "string") {
              const mode = normalizeOptionalLowercaseString(opts.failureAlertMode);
              if (mode !== "announce" && mode !== "webhook") {
                throw new CronCliError(
                  "Invalid --failure-alert-mode (must be 'announce' or 'webhook').",
                );
              }
              failureAlert.mode = mode;
            }
            if (typeof opts.failureAlertAccountId === "string") {
              failureAlert.accountId = normalizeOptionalString(opts.failureAlertAccountId);
            }
            patch.failureAlert = failureAlert;
          }

          const res = await callGatewayFromCli("cron.update", opts, {
            id,
            patch,
            ...(expectedConfigRevision !== undefined ? { expectedConfigRevision } : {}),
          });
          defaultRuntime.writeJson(res);
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}
