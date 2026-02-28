import type { Command } from "commander";
import type { CronJob } from "../../cron/types.js";
import { danger } from "../../globals.js";
import { sanitizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import {
  getCronChannelOptions,
  parseAt,
  parseDurationMs,
  warnIfCronSchedulerDisabled,
} from "./shared.js";

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
      .option("--thinking <level>", "Thinking level for agent jobs")
      .option("--model <model>", "Model override for agent jobs")
      .option("--timeout-seconds <n>", "Timeout seconds for agent jobs")
      .option("--announce", "Announce summary to a chat (subagent-style)")
      .option("--deliver", "Deprecated (use --announce). Announces a summary to a chat.")
      .option("--no-deliver", "Disable announce delivery")
      .option("--channel <channel>", `Delivery channel (${getCronChannelOptions()})`)
      .option(
        "--to <dest>",
        "Delivery destination (E.164, Telegram chatId, or Discord channel/user)",
      )
      .option("--best-effort-deliver", "Do not fail job if delivery fails")
      .option("--no-best-effort-deliver", "Fail job when delivery fails")
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
          const staggerRaw = typeof opts.stagger === "string" ? opts.stagger.trim() : "";
          const useExact = Boolean(opts.exact);
          if (staggerRaw && useExact) {
            throw new Error("Choose either --stagger or --exact, not both");
          }
          const requestedStaggerMs = (() => {
            if (useExact) {
              return 0;
            }
            if (!staggerRaw) {
              return undefined;
            }
            const parsed = parseDurationMs(staggerRaw);
            if (!parsed) {
              throw new Error("Invalid --stagger; use e.g. 30s, 1m, 5m");
            }
            return parsed;
          })();

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

          const scheduleChosen = [opts.at, opts.every, opts.cron].filter(Boolean).length;
          if (scheduleChosen > 1) {
            throw new Error("Choose at most one schedule change");
          }
          if (
            (requestedStaggerMs !== undefined || typeof opts.tz === "string") &&
            (opts.at || opts.every)
          ) {
            throw new Error("--stagger/--exact/--tz are only valid for cron schedules");
          }
          if (opts.at) {
            const atIso = parseAt(String(opts.at));
            if (!atIso) {
              throw new Error("Invalid --at");
            }
            patch.schedule = { kind: "at", at: atIso };
          } else if (opts.every) {
            const everyMs = parseDurationMs(String(opts.every));
            if (!everyMs) {
              throw new Error("Invalid --every");
            }
            patch.schedule = { kind: "every", everyMs };
          } else if (opts.cron) {
            patch.schedule = {
              kind: "cron",
              expr: String(opts.cron),
              tz: typeof opts.tz === "string" && opts.tz.trim() ? opts.tz.trim() : undefined,
              staggerMs: requestedStaggerMs,
            };
          } else if (requestedStaggerMs !== undefined || typeof opts.tz === "string") {
            const listed = (await callGatewayFromCli("cron.list", opts, {
              includeDisabled: true,
            })) as { jobs?: CronJob[] } | null;
            const existing = (listed?.jobs ?? []).find((job) => job.id === id);
            if (!existing) {
              throw new Error(`unknown cron job id: ${id}`);
            }
            if (existing.schedule.kind !== "cron") {
              throw new Error("Current job is not a cron schedule; use --cron to convert first");
            }
            const tz =
              typeof opts.tz === "string" ? opts.tz.trim() || undefined : existing.schedule.tz;
            patch.schedule = {
              kind: "cron",
              expr: existing.schedule.expr,
              tz,
              staggerMs:
                requestedStaggerMs !== undefined ? requestedStaggerMs : existing.schedule.staggerMs,
            };
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
          const hasBestEffort = typeof opts.bestEffortDeliver === "boolean";
          const hasAgentTurnPatch =
            typeof opts.message === "string" ||
            Boolean(model) ||
            Boolean(thinking) ||
            hasTimeoutSeconds ||
            hasDeliveryModeFlag ||
            hasDeliveryTarget ||
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
            patch.payload = payload;
          }

          if (hasDeliveryModeFlag || hasDeliveryTarget || hasBestEffort) {
            const deliveryMode =
              opts.announce || opts.deliver === true
                ? "announce"
                : opts.deliver === false
                  ? "none"
                  : "announce";
            const delivery: Record<string, unknown> = { mode: deliveryMode };
            if (typeof opts.channel === "string") {
              const channel = opts.channel.trim();
              delivery.channel = channel ? channel : undefined;
            }
            if (typeof opts.to === "string") {
              const to = opts.to.trim();
              delivery.to = to ? to : undefined;
            }
            if (typeof opts.bestEffortDeliver === "boolean") {
              delivery.bestEffort = opts.bestEffortDeliver;
            }
            patch.delivery = delivery;
          }

          const res = await callGatewayFromCli("cron.update", opts, {
            id,
            patch,
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}
