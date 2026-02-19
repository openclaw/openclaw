import type { Command } from "commander";
import type { CronJob } from "../../cron/types.js";
import { danger } from "../../globals.js";
import { sanitizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { parsePositiveIntOrUndefined } from "../program/helpers.js";
import {
  getCronChannelOptions,
  parseAt,
  parseDurationMs,
  printCronList,
  warnIfCronSchedulerDisabled,
} from "./shared.js";

export function registerCronStatusCommand(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("status")
      .description("Show cron scheduler status")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const res = await callGatewayFromCli("cron.status", opts, {});
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}

export function registerCronListCommand(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("list")
      .description("List cron jobs")
      .option("--all", "Include disabled jobs", false)
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const res = await callGatewayFromCli("cron.list", opts, {
            includeDisabled: Boolean(opts.all),
          });
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(res, null, 2));
            return;
          }
          const jobs = (res as { jobs?: CronJob[] } | null)?.jobs ?? [];
          printCronList(jobs, defaultRuntime);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}

export function registerCronAddCommand(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("add")
      .alias("create")
      .description("Add a cron job")
      .requiredOption("--name <name>", "Job name")
      .option("--description <text>", "Optional description")
      .option("--disabled", "Create job disabled", false)
      .option("--delete-after-run", "Delete one-shot job after it succeeds", false)
      .option("--keep-after-run", "Keep one-shot job after it succeeds", false)
      .option("--agent <id>", "Agent id for this job")
      .option("--session <target>", "Session target (main|isolated)")
      .option("--wake <mode>", "Wake mode (now|next-heartbeat)", "now")
      .option("--at <when>", "Run once at time (ISO) or +duration (e.g. 20m)")
      .option("--every <duration>", "Run every duration (e.g. 10m, 1h)")
      .option("--cron <expr>", "Cron expression (5-field or 6-field with seconds)")
      .option("--tz <iana>", "Timezone for cron expressions (IANA)", "")
      .option("--stagger <duration>", "Cron stagger window (e.g. 30s, 5m)")
      .option("--exact", "Disable cron staggering (set stagger to 0)", false)
      .option("--system-event <text>", "System event payload (main session)")
      .option("--message <text>", "Agent message payload")
      .option("--command <cmd>", "Direct command executable path/name")
      .option("--arg <value>", "Direct command arg (repeatable)", collectCliList, [])
      .option("--cwd <path>", "Direct command working directory")
      .option("--env <name=value>", "Direct command env var (repeatable)", collectCliList, [])
      .option("--thinking <level>", "Thinking level for agent jobs (off|minimal|low|medium|high)")
      .option("--model <model>", "Model override for agent jobs (provider/model or alias)")
      .option("--timeout-seconds <n>", "Timeout seconds for agent/direct-command jobs")
      .option("--max-output-bytes <n>", "Max captured stdout/stderr bytes for direct-command jobs")
      .option("--announce", "Announce summary to a chat (subagent-style)", false)
      .option("--deliver", "Deprecated (use --announce). Announces a summary to a chat.")
      .option("--no-deliver", "Disable announce delivery and skip main-session summary")
      .option("--channel <channel>", `Delivery channel (${getCronChannelOptions()})`, "last")
      .option(
        "--to <dest>",
        "Delivery destination (E.164, Telegram chatId, or Discord channel/user)",
      )
      .option("--best-effort-deliver", "Do not fail the job if delivery fails", false)
      .option("--json", "Output JSON", false)
      .action(async (opts: GatewayRpcOpts & Record<string, unknown>, cmd?: Command) => {
        try {
          const staggerRaw = typeof opts.stagger === "string" ? opts.stagger.trim() : "";
          const useExact = Boolean(opts.exact);
          if (staggerRaw && useExact) {
            throw new Error("Choose either --stagger or --exact, not both");
          }

          const schedule = (() => {
            const at = typeof opts.at === "string" ? opts.at : "";
            const every = typeof opts.every === "string" ? opts.every : "";
            const cronExpr = typeof opts.cron === "string" ? opts.cron : "";
            const chosen = [Boolean(at), Boolean(every), Boolean(cronExpr)].filter(Boolean).length;
            if (chosen !== 1) {
              throw new Error("Choose exactly one schedule: --at, --every, or --cron");
            }
            if ((useExact || staggerRaw) && !cronExpr) {
              throw new Error("--stagger/--exact are only valid with --cron");
            }
            if (at) {
              const atIso = parseAt(at);
              if (!atIso) {
                throw new Error("Invalid --at; use ISO time or duration like 20m");
              }
              return { kind: "at" as const, at: atIso };
            }
            if (every) {
              const everyMs = parseDurationMs(every);
              if (!everyMs) {
                throw new Error("Invalid --every; use e.g. 10m, 1h, 1d");
              }
              return { kind: "every" as const, everyMs };
            }
            const staggerMs = (() => {
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
            return {
              kind: "cron" as const,
              expr: cronExpr,
              tz: typeof opts.tz === "string" && opts.tz.trim() ? opts.tz.trim() : undefined,
              staggerMs,
            };
          })();

          const wakeModeRaw = typeof opts.wake === "string" ? opts.wake : "now";
          const wakeMode = wakeModeRaw.trim() || "now";
          if (wakeMode !== "now" && wakeMode !== "next-heartbeat") {
            throw new Error("--wake must be now or next-heartbeat");
          }

          const agentId =
            typeof opts.agent === "string" && opts.agent.trim()
              ? sanitizeAgentId(opts.agent.trim())
              : undefined;

          const hasAnnounce = Boolean(opts.announce) || opts.deliver === true;
          const hasNoDeliver = opts.deliver === false;
          const deliveryFlagCount = [hasAnnounce, hasNoDeliver].filter(Boolean).length;
          if (deliveryFlagCount > 1) {
            throw new Error("Choose at most one of --announce or --no-deliver");
          }

          const payload = (() => {
            const systemEvent = typeof opts.systemEvent === "string" ? opts.systemEvent.trim() : "";
            const message = typeof opts.message === "string" ? opts.message.trim() : "";
            const command = typeof opts.command === "string" ? opts.command.trim() : "";
            const chosen = [Boolean(systemEvent), Boolean(message), Boolean(command)].filter(
              Boolean,
            ).length;
            if (chosen !== 1) {
              throw new Error(
                "Choose exactly one payload: --system-event, --message, or --command",
              );
            }
            if (systemEvent) {
              return { kind: "systemEvent" as const, text: systemEvent };
            }
            const timeoutSeconds = parsePositiveIntOrUndefined(opts.timeoutSeconds);
            if (command) {
              const args = normalizeCliList(opts.arg);
              const cwd =
                typeof opts.cwd === "string" && opts.cwd.trim() ? opts.cwd.trim() : undefined;
              const env = parseEnvAssignments(normalizeCliList(opts.env));
              const maxOutputBytes = parsePositiveIntOrUndefined(opts.maxOutputBytes);
              return {
                kind: "directCommand" as const,
                command,
                args: args.length > 0 ? args : undefined,
                cwd,
                env: Object.keys(env).length > 0 ? env : undefined,
                timeoutSeconds:
                  timeoutSeconds && Number.isFinite(timeoutSeconds) ? timeoutSeconds : undefined,
                maxOutputBytes:
                  maxOutputBytes && Number.isFinite(maxOutputBytes) ? maxOutputBytes : undefined,
              };
            }
            return {
              kind: "agentTurn" as const,
              message,
              model:
                typeof opts.model === "string" && opts.model.trim() ? opts.model.trim() : undefined,
              thinking:
                typeof opts.thinking === "string" && opts.thinking.trim()
                  ? opts.thinking.trim()
                  : undefined,
              timeoutSeconds:
                timeoutSeconds && Number.isFinite(timeoutSeconds) ? timeoutSeconds : undefined,
            };
          })();

          const optionSource =
            typeof cmd?.getOptionValueSource === "function"
              ? (name: string) => cmd.getOptionValueSource(name)
              : () => undefined;
          const sessionSource = optionSource("session");
          const sessionTargetRaw = typeof opts.session === "string" ? opts.session.trim() : "";
          const inferredSessionTarget =
            payload.kind === "agentTurn" || payload.kind === "directCommand" ? "isolated" : "main";
          const sessionTarget =
            sessionSource === "cli" ? sessionTargetRaw || "" : inferredSessionTarget;
          if (sessionTarget !== "main" && sessionTarget !== "isolated") {
            throw new Error("--session must be main or isolated");
          }

          if (opts.deleteAfterRun && opts.keepAfterRun) {
            throw new Error("Choose --delete-after-run or --keep-after-run, not both");
          }

          if (sessionTarget === "main" && payload.kind !== "systemEvent") {
            throw new Error("Main jobs require --system-event (systemEvent).");
          }
          if (
            sessionTarget === "isolated" &&
            payload.kind !== "agentTurn" &&
            payload.kind !== "directCommand"
          ) {
            throw new Error(
              "Isolated jobs require --message (agentTurn) or --command (directCommand).",
            );
          }
          if (
            (opts.announce || typeof opts.deliver === "boolean") &&
            (sessionTarget !== "isolated" ||
              (payload.kind !== "agentTurn" && payload.kind !== "directCommand"))
          ) {
            throw new Error("--announce/--no-deliver require --session isolated.");
          }

          const deliveryMode =
            sessionTarget === "isolated" &&
            (payload.kind === "agentTurn" || payload.kind === "directCommand")
              ? hasAnnounce
                ? "announce"
                : hasNoDeliver
                  ? "none"
                  : "announce"
              : undefined;

          const nameRaw = typeof opts.name === "string" ? opts.name : "";
          const name = nameRaw.trim();
          if (!name) {
            throw new Error("--name is required");
          }

          const description =
            typeof opts.description === "string" && opts.description.trim()
              ? opts.description.trim()
              : undefined;

          const params = {
            name,
            description,
            enabled: !opts.disabled,
            deleteAfterRun: opts.deleteAfterRun ? true : opts.keepAfterRun ? false : undefined,
            agentId,
            schedule,
            sessionTarget,
            wakeMode,
            payload,
            delivery: deliveryMode
              ? {
                  mode: deliveryMode,
                  channel:
                    typeof opts.channel === "string" && opts.channel.trim()
                      ? opts.channel.trim()
                      : undefined,
                  to: typeof opts.to === "string" && opts.to.trim() ? opts.to.trim() : undefined,
                  bestEffort: opts.bestEffortDeliver ? true : undefined,
                }
              : undefined,
          };

          const res = await callGatewayFromCli("cron.add", opts, params);
          defaultRuntime.log(JSON.stringify(res, null, 2));
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}

function normalizeCliList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function collectCliList(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseEnvAssignments(entries: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Invalid --env entry: ${entry}. Expected NAME=value.`);
    }
    const key = entry.slice(0, separator).trim();
    if (!key) {
      throw new Error(`Invalid --env entry: ${entry}. Expected NAME=value.`);
    }
    env[key] = entry.slice(separator + 1);
  }
  return env;
}
