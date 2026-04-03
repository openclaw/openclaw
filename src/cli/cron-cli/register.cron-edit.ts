import type { Command } from "commander";
import type { CronJob } from "../../cron/types.js";
import { danger } from "../../globals.js";
import { sanitizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import {
  applyExistingCronSchedulePatch,
  resolveCronEditScheduleRequest,
} from "./schedule-options.js";
import { getCronChannelOptions, parseDurationMs, warnIfCronSchedulerDisabled } from "./shared.js";

const assignIf = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  shouldAssign: boolean,
) => {
  if (shouldAssign) {
    target[key] = value;
  }
};

async function findCronJobById(params: {
  id: string;
  opts: Record<string, unknown>;
}): Promise<CronJob | undefined> {
  const pageSize = 200;
  let offset = 0;
  const visitedOffsets = new Set<number>();
  while (!visitedOffsets.has(offset)) {
    visitedOffsets.add(offset);
    const listed = (await callGatewayFromCli("cron.list", params.opts, {
      includeDisabled: true,
      limit: pageSize,
      offset,
    })) as {
      jobs?: CronJob[];
      hasMore?: boolean;
      nextOffset?: number | null;
    } | null;
    const jobs = listed?.jobs ?? [];
    const found = jobs.find((job) => job.id === params.id);
    if (found) {
      return found;
    }
    if (listed?.hasMore !== true) {
      return undefined;
    }
    const candidate =
      typeof listed.nextOffset === "number" && Number.isFinite(listed.nextOffset)
        ? listed.nextOffset
        : offset + jobs.length;
    if (!Number.isFinite(candidate) || candidate <= offset) {
      return undefined;
    }
    offset = candidate;
  }
  return undefined;
}

export function registerCronEditCommand(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("edit")
      .description("Edit a cron job (patch fields)")
      .argument("<id>", "Job id")
      .option("--name <name>", "Set name")
      .option("--description <text>", "Set description")
      .option("--enable", "Enable job", false)
      .option("--disable", "Disable job", false)
      .option("--delete-after-run", "Delete one-shot job after it succeeds", false)
      .option("--keep-after-run", "Keep one-shot job after it succeeds", false)
      .option("--session <target>", "Session target (main|isolated)")
      .option("--agent <id>", "Set agent id")
      .option("--clear-agent", "Unset agent and use default", false)
      .option("--session-key <key>", "Set session key for job routing")
      .option("--clear-session-key", "Unset session key", false)
      .option("--wake <mode>", "Wake mode (now|next-heartbeat)")
      .option("--at <when>", "Set one-shot time (ISO) or duration like 20m")
      .option("--every <duration>", "Set interval duration like 10m")
      .option("--cron <expr>", "Set cron expression")
      .option("--tz <iana>", "Timezone for cron expressions (IANA)")
      .option("--stagger <duration>", "Cron stagger window (e.g. 30s, 5m)")
      .option("--exact", "Disable cron staggering (set stagger to 0)")
      .option("--system-event <text>", "Set systemEvent payload")
      .option("--message <text>", "Set agentTurn payload message")
      .option(
        "--thinking <level>",
        "Thinking level for agent jobs (off|minimal|low|medium|high|xhigh)",
      )
      .option("--model <model>", "Model override for agent jobs")
      .option("--timeout-seconds <n>", "Timeout seconds for agent jobs")
      .option("--light-context", "Enable lightweight bootstrap context for agent jobs")
      .option("--no-light-context", "Disable lightweight bootstrap context for agent jobs")
      .option("--tools <csv>", "Comma-separated tool allow-list (e.g. exec,read,write)")
      .option("--clear-tools", "Remove tool allow-list (use all tools)", false)
      .option("--announce", "Announce summary to a chat (subagent-style)")
      .option("--deliver", "Deprecated (use --announce). Announces a summary to a chat.")
      .option("--no-deliver", "Disable announce delivery")
      .option("--channel <channel>", `Delivery channel (${getCronChannelOptions()})`)
      .option(
        "--to <dest>",
        "Delivery destination (E.164, Telegram chatId, or Discord channel/user)",
      )
      .option("--thread-id <id>", "Thread id (Telegram forum topic, must be a number)")
      .option("--account <id>", "Channel account id for delivery (multi-account setups)")
      .option("--best-effort-deliver", "Do not fail job if delivery fails")
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
      .option("--failure-alert-mode <mode>", "Failure alert delivery mode (announce or webhook)")
      .option(
        "--failure-alert-account-id <id>",
        "Account ID for failure alert channel (multi-account setups)",
      )
      .action(async (id, opts) => {
        try {
          let cachedExistingJob: CronJob | null | undefined;
          const getExistingJob = async (): Promise<CronJob | undefined> => {
            if (cachedExistingJob !== undefined) {
              return cachedExistingJob ?? undefined;
            }
            cachedExistingJob = (await findCronJobById({ id, opts })) ?? null;
            return cachedExistingJob ?? undefined;
          };
          if (opts.session === "main" && opts.message) {
            throw new Error(
              "Main jobs cannot use --message; use --system-event or --session isolated.",
            );
          }
          if (opts.session === "isolated" && opts.systemEvent) {
            throw new Error(
              "Isolated jobs cannot use --system-event; use --message or --session main.",
            );
          }
          if (opts.announce && typeof opts.deliver === "boolean") {
            throw new Error("Choose --announce or --no-deliver (not multiple).");
          }
          const patch: Record<string, unknown> = {};
          if (typeof opts.name === "string") {
            patch.name = opts.name;
          }
          if (typeof opts.description === "string") {
            patch.description = opts.description;
          }
          if (opts.enable && opts.disable) {
            throw new Error("Choose --enable or --disable, not both");
          }
          if (opts.enable) {
            patch.enabled = true;
          }
          if (opts.disable) {
            patch.enabled = false;
          }
          if (opts.deleteAfterRun && opts.keepAfterRun) {
            throw new Error("Choose --delete-after-run or --keep-after-run, not both");
          }
          if (opts.deleteAfterRun) {
            patch.deleteAfterRun = true;
          }
          if (opts.keepAfterRun) {
            patch.deleteAfterRun = false;
          }
          if (typeof opts.session === "string") {
            patch.sessionTarget = opts.session;
          }
          if (typeof opts.wake === "string") {
            patch.wakeMode = opts.wake;
          }
          if (opts.agent && opts.clearAgent) {
            throw new Error("Use --agent or --clear-agent, not both");
          }
          if (typeof opts.agent === "string" && opts.agent.trim()) {
            patch.agentId = sanitizeAgentId(opts.agent.trim());
          }
          if (opts.clearAgent) {
            patch.agentId = null;
          }
          if (opts.sessionKey && opts.clearSessionKey) {
            throw new Error("Use --session-key or --clear-session-key, not both");
          }
          if (typeof opts.sessionKey === "string" && opts.sessionKey.trim()) {
            patch.sessionKey = opts.sessionKey.trim();
          }
          if (opts.clearSessionKey) {
            patch.sessionKey = null;
          }

          const scheduleRequest = resolveCronEditScheduleRequest({
            at: opts.at,
            cron: opts.cron,
            every: opts.every,
            exact: opts.exact,
            stagger: opts.stagger,
            tz: opts.tz,
          });
          if (scheduleRequest.kind === "direct") {
            patch.schedule = scheduleRequest.schedule;
          } else if (scheduleRequest.kind === "patch-existing-cron") {
            const existing = await getExistingJob();
            if (!existing) {
              throw new Error(`unknown cron job id: ${id}`);
            }
            patch.schedule = applyExistingCronSchedulePatch(existing.schedule, scheduleRequest);
          }

          const hasSystemEventPatch = typeof opts.systemEvent === "string";
          const model =
            typeof opts.model === "string" && opts.model.trim() ? opts.model.trim() : undefined;
          const thinking =
            typeof opts.thinking === "string" && opts.thinking.trim()
              ? opts.thinking.trim()
              : undefined;
          const timeoutSeconds = opts.timeoutSeconds
            ? Number.parseInt(String(opts.timeoutSeconds), 10)
            : undefined;
          const hasTimeoutSeconds = Boolean(timeoutSeconds && Number.isFinite(timeoutSeconds));
          const hasDeliveryModeFlag = opts.announce || typeof opts.deliver === "boolean";
          const hasDeliveryTarget = typeof opts.channel === "string" || typeof opts.to === "string";
          const hasDeliveryAccount = typeof opts.account === "string";
          const hasThreadId = typeof opts.threadId === "string";
          const hasBestEffort = typeof opts.bestEffortDeliver === "boolean";
          const hasAgentTurnPatch =
            typeof opts.message === "string" ||
            Boolean(model) ||
            Boolean(thinking) ||
            hasTimeoutSeconds ||
            typeof opts.lightContext === "boolean" ||
            typeof opts.tools === "string" ||
            opts.clearTools ||
            hasDeliveryModeFlag ||
            hasDeliveryTarget ||
            hasDeliveryAccount ||
            hasThreadId ||
            hasBestEffort;
          if (hasSystemEventPatch && hasAgentTurnPatch) {
            throw new Error("Choose at most one payload change");
          }
          if (hasSystemEventPatch) {
            patch.payload = {
              kind: "systemEvent",
              text: String(opts.systemEvent),
            };
          } else if (hasAgentTurnPatch) {
            const payload: Record<string, unknown> = { kind: "agentTurn" };
            assignIf(payload, "message", String(opts.message), typeof opts.message === "string");
            assignIf(payload, "model", model, Boolean(model));
            assignIf(payload, "thinking", thinking, Boolean(thinking));
            assignIf(payload, "timeoutSeconds", timeoutSeconds, hasTimeoutSeconds);
            assignIf(
              payload,
              "lightContext",
              opts.lightContext,
              typeof opts.lightContext === "boolean",
            );
            if (opts.clearTools) {
              payload.toolsAllow = null;
            } else if (typeof opts.tools === "string" && opts.tools.trim()) {
              payload.toolsAllow = opts.tools
                .split(",")
                .map((t: string) => t.trim())
                .filter(Boolean);
            }
            patch.payload = payload;
          }

          if (
            hasDeliveryModeFlag ||
            hasDeliveryTarget ||
            hasDeliveryAccount ||
            hasThreadId ||
            hasBestEffort
          ) {
            const delivery: Record<string, unknown> = {};
            if (hasDeliveryModeFlag) {
              delivery.mode = opts.announce || opts.deliver === true ? "announce" : "none";
            } else if (hasBestEffort) {
              // Back-compat: toggling best-effort alone has historically implied announce mode.
              delivery.mode = "announce";
            }
            if (typeof opts.channel === "string") {
              const channel = opts.channel.trim();
              delivery.channel = channel ? channel : undefined;
            }
            if (typeof opts.to === "string" || hasThreadId) {
              const threadId = typeof opts.threadId === "string" ? opts.threadId.trim() : "";
              if (hasThreadId && !threadId) {
                throw new Error("--thread-id must be a non-empty numeric value");
              }
              if (threadId && !/^\d+$/.test(threadId)) {
                throw new Error("--thread-id must be a numeric value");
              }
              if (threadId && opts.deliver === false) {
                throw new Error("--thread-id is not supported with --no-deliver");
              }
              const explicitChannel =
                typeof opts.channel === "string" ? opts.channel.trim().toLowerCase() : "";
              if (threadId && explicitChannel && explicitChannel !== "telegram") {
                throw new Error("--thread-id requires --channel telegram");
              }
              if (threadId && !opts.announce && typeof opts.deliver !== "boolean") {
                const existing = await getExistingJob();
                const existingMode =
                  (existing?.delivery as Record<string, string> | undefined)?.mode ?? "";
                if (existingMode === "webhook") {
                  throw new Error(
                    "--thread-id is not supported for webhook delivery jobs unless --announce is set",
                  );
                }
              }
              let toRaw = typeof opts.to === "string" ? opts.to.trim() : "";
              if (threadId && (!toRaw || typeof opts.channel !== "string")) {
                const existing = await getExistingJob();
                if (!existing) {
                  throw new Error(`Cron job ${id} not found`);
                }
                const existingChannel =
                  (existing.delivery as Record<string, string> | undefined)?.channel ?? "";
                const existingMode =
                  (existing.delivery as Record<string, string> | undefined)?.mode ?? "";
                if (typeof opts.channel !== "string") {
                  if (existingMode === "webhook") {
                    throw new Error("--thread-id is not supported for webhook delivery jobs");
                  }
                  if (existingChannel.toLowerCase() !== "telegram") {
                    throw new Error("--thread-id requires --channel telegram");
                  }
                }
                if (!toRaw) {
                  if (existingMode === "webhook") {
                    throw new Error(
                      "--thread-id requires --to when re-targeting from webhook delivery",
                    );
                  }
                  if (existingChannel.toLowerCase() !== "telegram") {
                    throw new Error(
                      "--thread-id requires --to when existing target is not Telegram",
                    );
                  }
                  toRaw = (existing.delivery as Record<string, string> | undefined)?.to ?? "";
                }
              }
              const to = threadId ? toRaw.replace(/:(?:topic:)?\d+$/, "") : toRaw;
              if (to && threadId) {
                delivery.to = `${to}:topic:${threadId}`;
              } else if (to) {
                delivery.to = to;
              } else if (threadId) {
                throw new Error(
                  "--thread-id requires a delivery target (use --to or ensure the job has one)",
                );
              } else if (typeof opts.to === "string") {
                delivery.to = undefined;
              }
            }
            if (typeof opts.account === "string") {
              const account = opts.account.trim();
              delivery.accountId = account ? account : undefined;
            }
            if (typeof opts.bestEffortDeliver === "boolean") {
              delivery.bestEffort = opts.bestEffortDeliver;
            }
            patch.delivery = delivery;
          }

          const hasFailureAlertAfter = typeof opts.failureAlertAfter === "string";
          const hasFailureAlertChannel = typeof opts.failureAlertChannel === "string";
          const hasFailureAlertTo = typeof opts.failureAlertTo === "string";
          const hasFailureAlertCooldown = typeof opts.failureAlertCooldown === "string";
          const hasFailureAlertMode = typeof opts.failureAlertMode === "string";
          const hasFailureAlertAccountId = typeof opts.failureAlertAccountId === "string";
          const hasFailureAlertFields =
            hasFailureAlertAfter ||
            hasFailureAlertChannel ||
            hasFailureAlertTo ||
            hasFailureAlertCooldown ||
            hasFailureAlertMode ||
            hasFailureAlertAccountId;
          const failureAlertFlag =
            typeof opts.failureAlert === "boolean" ? opts.failureAlert : undefined;
          if (failureAlertFlag === false && hasFailureAlertFields) {
            throw new Error("Use --no-failure-alert alone (without failure-alert-* options).");
          }
          if (failureAlertFlag === false) {
            patch.failureAlert = false;
          } else if (failureAlertFlag === true || hasFailureAlertFields) {
            const failureAlert: Record<string, unknown> = {};
            if (hasFailureAlertAfter) {
              const after = Number.parseInt(String(opts.failureAlertAfter), 10);
              if (!Number.isFinite(after) || after <= 0) {
                throw new Error("Invalid --failure-alert-after (must be a positive integer).");
              }
              failureAlert.after = after;
            }
            if (hasFailureAlertChannel) {
              const channel = String(opts.failureAlertChannel).trim().toLowerCase();
              failureAlert.channel = channel ? channel : undefined;
            }
            if (hasFailureAlertTo) {
              const to = String(opts.failureAlertTo).trim();
              failureAlert.to = to ? to : undefined;
            }
            if (hasFailureAlertCooldown) {
              const cooldownMs = parseDurationMs(String(opts.failureAlertCooldown));
              if (!cooldownMs && cooldownMs !== 0) {
                throw new Error("Invalid --failure-alert-cooldown.");
              }
              failureAlert.cooldownMs = cooldownMs;
            }
            if (hasFailureAlertMode) {
              const mode = String(opts.failureAlertMode).trim().toLowerCase();
              if (mode !== "announce" && mode !== "webhook") {
                throw new Error("Invalid --failure-alert-mode (must be 'announce' or 'webhook').");
              }
              failureAlert.mode = mode;
            }
            if (hasFailureAlertAccountId) {
              const accountId = String(opts.failureAlertAccountId).trim();
              failureAlert.accountId = accountId ? accountId : undefined;
            }
            patch.failureAlert = failureAlert;
          }

          const res = await callGatewayFromCli("cron.update", opts, {
            id,
            patch,
          });
          defaultRuntime.writeJson(res);
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}
