import type { Command } from "commander";
import type { CronJob } from "../../cron/types.js";
import { danger } from "../../globals.js";
import { sanitizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import {
  applyExistingCronSchedulePatch,
  resolveCronEditScheduleRequest,
} from "./schedule-options.js";
import { getCronChannelOptions, parseDurationMs, warnIfCronSchedulerDisabled } from "./shared.js";
import { resolveDefaultCronStaggerMs } from "../../cron/stagger.js";
import {
  normalizeRequiredName,
} from "../../cron/service/normalize.js";
import { theme } from "../../terminal/theme.js";

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

function sortObjectKeys(val: unknown): unknown {
  if (Array.isArray(val)) { return val.map(sortObjectKeys); }
  if (val !== null && typeof val === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(val as Record<string, unknown>).toSorted()) {
      sorted[key] = sortObjectKeys((val as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return val;
}

function formatPatchValue(val: unknown): string {
  if (val === null) { return theme.muted("(cleared)"); }
  if (val === undefined) { return theme.muted("(unchanged)"); }
  if (typeof val === "object") { return JSON.stringify(sortObjectKeys(val)); }
  // val is narrowed to string | number | boolean | bigint | symbol here
  return String(val as string | number | boolean | bigint | symbol);
}

// Mirror the merge semantics of applyJobPatch so the preview diff is accurate.
//
// schedule: when kind==="cron" and patch omits staggerMs, the real update
//   preserves the existing staggerMs. All other cases replace wholesale.
//
// payload: when patch.kind === existing.kind, the real update merges fields.
//   When kind changes (or existing is absent), it replaces wholesale.

function computeDisplayAfterSchedule(
  patchVal: unknown,
  existingVal: unknown,
): unknown {
  if (
    patchVal !== null &&
    typeof patchVal === "object" &&
    !Array.isArray(patchVal)
  ) {
    const p = patchVal as Record<string, unknown>;
    if (
      p["kind"] === "cron" &&
      p["staggerMs"] === undefined
    ) {
      if (
        existingVal !== null &&
        typeof existingVal === "object" &&
        !Array.isArray(existingVal)
      ) {
        const e = existingVal as Record<string, unknown>;
        if (e["kind"] === "cron") {
          // Path 1: cron → cron — preserve existing staggerMs (or keep it absent if undefined),
          // mirroring applyJobPatch which never synthesizes a default for an existing cron job.
          return e["staggerMs"] !== undefined
            ? { ...p, staggerMs: e["staggerMs"] }
            : p;
        }
      }
      // Path 2: non-cron → cron conversion — synthesize default stagger just as applyJobPatch does
      if (typeof p["expr"] === "string") {
        const defaultStaggerMs = resolveDefaultCronStaggerMs(p["expr"]);
        if (defaultStaggerMs !== undefined) {
          return { ...p, staggerMs: defaultStaggerMs };
        }
      }
    }
  }
  return patchVal;
}

function computeDisplayAfterPayload(
  patchVal: unknown,
  existingVal: unknown,
): unknown {
  if (
    patchVal === null ||
    typeof patchVal !== "object" ||
    Array.isArray(patchVal)
  ) {
    return patchVal;
  }
  const p = patchVal as Record<string, unknown>;
  if (
    existingVal === null ||
    typeof existingVal !== "object" ||
    Array.isArray(existingVal)
  ) {
    return patchVal;
  }
  const e = existingVal as Record<string, unknown>;
  // Different kind: real update replaces wholesale
  if (p["kind"] !== e["kind"]) {
    return patchVal;
  }
  // Same kind: real update merges fields — mirror that here.
  // Also mirror the null-as-delete semantics used by mergeCronPayload:
  // a null patch value means "clear this field", so remove it from the preview.
  const merged: Record<string, unknown> = { ...e, ...p };
  for (const k of Object.keys(merged)) {
    if (merged[k] === null) {
      delete merged[k];
    }
  }
  return merged;
}

function computeDisplayAfter(
  key: string,
  patchVal: unknown,
  existingVal: unknown,
): unknown {
  if (key === "schedule") {
    return computeDisplayAfterSchedule(patchVal, existingVal);
  }
  if (key === "payload") {
    return computeDisplayAfterPayload(patchVal, existingVal);
  }
  if (key === "name") {
    return typeof patchVal === "string" ? normalizeRequiredName(patchVal) : patchVal;
  }
  if (key === "description") {
    if (typeof patchVal === "string") {
      const normalized = normalizeOptionalString(patchVal);
      // normalizeOptionalString returns undefined when the value is blank/whitespace-only,
      // which means the real update will clear the field. Return null here so
      // formatPatchValue renders "(cleared)" instead of the misleading "(unchanged)".
      return normalized === undefined ? null : normalized;
    }
    return patchVal;
  }
  // Default: shallow-merge objects, pass-through primitives/arrays
  if (
    patchVal !== null &&
    typeof patchVal === "object" &&
    !Array.isArray(patchVal) &&
    existingVal !== null &&
    typeof existingVal === "object" &&
    !Array.isArray(existingVal)
  ) {
    return { ...existingVal, ...patchVal };
  }
  return patchVal;
}

function buildCronPatchDiff(existing: CronJob, patch: Record<string, unknown>): string[] {
  const lines: string[] = [];

  // Determine whether the main-session side-effect block will handle `delivery`
  // explicitly below. If so, skip `delivery` in the generic loop to avoid showing
  // a contradictory intermediate state that cron.update never persists.
  //
  // Mirror applyJobPatch semantics exactly: delivery is cleared only when
  // sessionTarget is "main" AND the effective delivery mode is NOT "webhook".
  // Webhook delivery is valid for any sessionTarget and must show in the diff.
  const effectiveSessionTarget =
    typeof patch["sessionTarget"] === "string"
      ? patch["sessionTarget"]
      : existing.sessionTarget;
  const effectiveDeliveryForSkip =
    "delivery" in patch
      ? computeDisplayAfter("delivery", patch["delivery"], existing.delivery)
      : existing.delivery;
  const effectiveDeliveryMode =
    effectiveDeliveryForSkip !== null &&
    typeof effectiveDeliveryForSkip === "object" &&
    !Array.isArray(effectiveDeliveryForSkip)
      ? (effectiveDeliveryForSkip as Record<string, unknown>)["mode"]
      : undefined;
  const willClearDeliveryForMain =
    effectiveSessionTarget === "main" && effectiveDeliveryMode !== "webhook";

  for (const [key, next] of Object.entries(patch)) {
    // Skip delivery here when the main-session side-effect block will handle it.
    if (key === "delivery" && willClearDeliveryForMain) {
      continue;
    }
    const prev = (existing as Record<string, unknown>)[key];
    const displayAfter = computeDisplayAfter(key, next, prev);
    const prevStr = formatPatchValue(prev);
    const nextStr = formatPatchValue(displayAfter);
    if (prevStr !== nextStr) {
      lines.push(
        `  ${theme.muted(key + ":")} ${prevStr} ${theme.muted("→")} ${nextStr}`,
      );
    }
  }

  // Mirror the side-effect in applyJobPatch: when sessionTarget becomes "main",
  // any non-webhook delivery config is silently cleared by the real update path.
  // Show this as an explicit delivery → (cleared) line so the preview is accurate.
  if (effectiveSessionTarget === "main") {
    const effectiveDelivery =
      "delivery" in patch
        ? computeDisplayAfter("delivery", patch["delivery"], existing.delivery)
        : existing.delivery;
    const deliveryMode =
      effectiveDelivery !== null &&
      typeof effectiveDelivery === "object" &&
      !Array.isArray(effectiveDelivery)
        ? (effectiveDelivery as Record<string, unknown>)["mode"]
        : undefined;
    if (effectiveDelivery !== undefined && deliveryMode !== "webhook") {
      // The real applyJobPatch will clear delivery; show that in the preview.
      const prevDeliveryStr = formatPatchValue(
        "delivery" in patch ? effectiveDelivery : existing.delivery,
      );
      const clearedStr = formatPatchValue(undefined);
      if (prevDeliveryStr !== clearedStr) {
        lines.push(
          `  ${theme.muted("delivery:")} ${prevDeliveryStr} ${theme.muted("→")} ${theme.muted("(cleared — main jobs do not support channel delivery)")}`,
        );
      }
    }
  }

  if (lines.length > 0) {
    lines.unshift(theme.warn("Applying changes:"));
  }
  return lines;
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

          let prefetchedList: { jobs?: CronJob[] } | null = null;

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
            prefetchedList = (await callGatewayFromCli("cron.list", opts, {
              includeDisabled: true,
            })) as { jobs?: CronJob[] } | null;
            const existing = (prefetchedList?.jobs ?? []).find((job) => job.id === id);
            if (!existing) {
              throw new Error(`unknown cron job id: ${id}`);
            }
            patch.schedule = applyExistingCronSchedulePatch(existing.schedule, scheduleRequest);
          }

          const hasSystemEventPatch = typeof opts.systemEvent === "string";
          const model = normalizeOptionalString(opts.model);
          const thinking = normalizeOptionalString(opts.thinking);
          const timeoutSeconds = opts.timeoutSeconds
            ? Number.parseInt(String(opts.timeoutSeconds), 10)
            : undefined;
          const hasTimeoutSeconds = Boolean(timeoutSeconds && Number.isFinite(timeoutSeconds));
          const hasDeliveryModeFlag = opts.announce || typeof opts.deliver === "boolean";
          const hasDeliveryTarget = typeof opts.channel === "string" || typeof opts.to === "string";
          const hasDeliveryAccount = typeof opts.account === "string";
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

          if (hasDeliveryModeFlag || hasDeliveryTarget || hasDeliveryAccount || hasBestEffort) {
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
            if (typeof opts.to === "string") {
              const to = opts.to.trim();
              delivery.to = to ? to : undefined;
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
              failureAlert.channel = normalizeOptionalLowercaseString(opts.failureAlertChannel);
            }
            if (hasFailureAlertTo) {
              const to = normalizeOptionalString(opts.failureAlertTo) ?? "";
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
              const mode = normalizeOptionalLowercaseString(opts.failureAlertMode);
              if (mode !== "announce" && mode !== "webhook") {
                throw new Error("Invalid --failure-alert-mode (must be 'announce' or 'webhook').");
              }
              failureAlert.mode = mode;
            }
            if (hasFailureAlertAccountId) {
              const accountId = normalizeOptionalString(opts.failureAlertAccountId) ?? "";
              failureAlert.accountId = accountId ? accountId : undefined;
            }
            patch.failureAlert = failureAlert;
          }

          // Fetch current job to show a before/after diff before applying changes.
          // Non-blocking: if listing fails, skip the diff but proceed with the update.
          if (Object.keys(patch).length > 0) {
            try {
              const listed = prefetchedList ?? ((await callGatewayFromCli("cron.list", opts, {
                includeDisabled: true,
              })) as { jobs?: CronJob[] } | null);
              const existing = (listed?.jobs ?? []).find((job) => job.id === id);
              if (existing) {
                const diffLines = buildCronPatchDiff(existing, patch);
                if (diffLines.length > 0) {
                  defaultRuntime.error(diffLines.join("\n"));
                }
              }
            } catch {
              // Diff display is best-effort; listing failure should not block the update.
            }
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


/**
 * Test-only thin wrapper: runs the cron-edit command with the given argv and runtime.
 *
 * Builds a minimal Commander program, registers the cron-edit subcommand, and
 * drives it with `program.parseAsync`. Designed for unit tests that need to
 * exercise the action handler directly without constructing a full CLI program.
 *
 * @internal
 */
export async function registerCronEdit(
  args: string[],
  _runtime: typeof defaultRuntime,
): Promise<void> {
  const { Command } = await import("commander");
  const program = new Command("openclaw").exitOverride();
  const cron = program.command("cron").exitOverride();
  registerCronEditCommand(cron);
  await program.parseAsync(args, { from: "user" });
}
