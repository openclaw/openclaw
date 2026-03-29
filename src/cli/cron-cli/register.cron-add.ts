import type { Command } from "commander";
import type { CronJob } from "../../cron/types.js";
import { sanitizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { parsePositiveIntOrUndefined } from "../program/helpers.js";
import { resolveCronCreateSchedule } from "./schedule-options.js";
import {
  getCronChannelOptions,
  handleCronCliError,
  printCronJson,
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
          printCronJson(res);
        } catch (err) {
          handleCronCliError(err);
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
            printCronJson(res);
            return;
          }
          const jobs = (res as { jobs?: CronJob[] } | null)?.jobs ?? [];
          printCronList(jobs, defaultRuntime);
        } catch (err) {
          handleCronCliError(err);
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
      .option("--session-key <key>", "Session key for job routing (e.g. agent:my-agent:my-session)")
      .option("--wake <mode>", "Wake mode (now|next-heartbeat)", "now")
      .option(
        "--at <when>",
        "Run once at time (ISO with offset, or +duration). Use --tz for offset-less datetimes",
      )
      .option("--every <duration>", "Run every duration (e.g. 10m, 1h)")
      .option("--cron <expr>", "Cron expression (5-field or 6-field with seconds)")
      .option("--tz <iana>", "Timezone for cron expressions (IANA)", "")
      .option("--stagger <duration>", "Cron stagger window (e.g. 30s, 5m)")
      .option("--exact", "Disable cron staggering (set stagger to 0)", false)
      .option("--system-event <text>", "System event payload (main session)")
      .option("--message <text>", "Agent message payload")
      .option("--script <command>", "Script payload: execute a file directly (no LLM turn)")
      .option(
        "--script-arg <arg>",
        "Argument for the script (repeatable)",
        (val: string, acc: string[]) => [...acc, val],
        [] as string[],
      )
      .option(
        "--script-env <KEY=VALUE>",
        "Environment variable for the script (repeatable)",
        (val: string, acc: string[]) => [...acc, val],
        [] as string[],
      )
      .option("--script-cwd <dir>", "Working directory for the script")
      .option(
        "--thinking <level>",
        "Thinking level for agent jobs (off|minimal|low|medium|high|xhigh)",
      )
      .option("--model <model>", "Model override for agent jobs (provider/model or alias)")
      .option("--timeout-seconds <n>", "Timeout seconds for agent jobs")
      .option("--light-context", "Use lightweight bootstrap context for agent jobs", false)
      .option("--announce", "Announce summary to a chat (subagent-style)", false)
      .option("--deliver", "Deprecated (use --announce). Announces a summary to a chat.")
      .option("--no-deliver", "Disable announce delivery and skip main-session summary")
      .option("--channel <channel>", `Delivery channel (${getCronChannelOptions()})`, "last")
      .option(
        "--to <dest>",
        "Delivery destination (E.164, Telegram chatId, or Discord channel/user)",
      )
      .option("--account <id>", "Channel account id for delivery (multi-account setups)")
      .option("--best-effort-deliver", "Do not fail the job if delivery fails", false)
      .option("--json", "Output JSON", false)
      .action(async (opts: GatewayRpcOpts & Record<string, unknown>, cmd?: Command) => {
        try {
          const schedule = resolveCronCreateSchedule({
            at: opts.at,
            cron: opts.cron,
            every: opts.every,
            exact: opts.exact,
            stagger: opts.stagger,
            tz: opts.tz,
          });

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
            const scriptCommand = typeof opts.script === "string" ? opts.script.trim() : "";
            const chosen = [Boolean(systemEvent), Boolean(message), Boolean(scriptCommand)].filter(
              Boolean,
            ).length;
            if (chosen !== 1) {
              throw new Error("Choose exactly one payload: --system-event, --message, or --script");
            }
            if (systemEvent) {
              return { kind: "systemEvent" as const, text: systemEvent };
            }
            if (scriptCommand) {
              const scriptArgs = Array.isArray(opts.scriptArg) ? (opts.scriptArg as string[]) : [];
              const scriptEnvEntries = Array.isArray(opts.scriptEnv)
                ? (opts.scriptEnv as string[])
                : [];
              // Parse KEY=VALUE pairs; throw on malformed entries so the user
              // isn't surprised by silently missing env vars.
              const malformed = scriptEnvEntries.filter((e) => e.indexOf("=") <= 0);
              if (malformed.length > 0) {
                throw new Error(
                  `Malformed --script-env entries (expected KEY=VALUE): ${malformed.join(", ")}`,
                );
              }
              const scriptEnv =
                scriptEnvEntries.length > 0
                  ? Object.fromEntries(
                      scriptEnvEntries.map((e) => {
                        const idx = e.indexOf("=");
                        return [e.slice(0, idx), e.slice(idx + 1)] as [string, string];
                      }),
                    )
                  : undefined;
              const scriptCwd =
                typeof opts.scriptCwd === "string" && opts.scriptCwd.trim()
                  ? opts.scriptCwd.trim()
                  : undefined;
              const timeoutSeconds = parsePositiveIntOrUndefined(opts.timeoutSeconds);
              return {
                kind: "script" as const,
                command: scriptCommand,
                args: scriptArgs.length > 0 ? scriptArgs : undefined,
                env: scriptEnv,
                cwd: scriptCwd,
                timeoutSeconds:
                  timeoutSeconds && Number.isFinite(timeoutSeconds) ? timeoutSeconds : undefined,
                deliver: hasAnnounce ? true : hasNoDeliver ? false : undefined,
              };
            }
            const timeoutSeconds = parsePositiveIntOrUndefined(opts.timeoutSeconds);
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
              lightContext: opts.lightContext === true ? true : undefined,
            };
          })();

          const optionSource =
            typeof cmd?.getOptionValueSource === "function"
              ? (name: string) => cmd.getOptionValueSource(name)
              : () => undefined;
          const sessionSource = optionSource("session");
          const sessionTargetRaw = typeof opts.session === "string" ? opts.session.trim() : "";
          // Scripts don't use a session; default to "isolated" for bookkeeping.
          const inferredSessionTarget = payload.kind === "systemEvent" ? "main" : "isolated";
          const sessionTarget =
            sessionSource === "cli" ? sessionTargetRaw || "" : inferredSessionTarget;
          const isCustomSessionTarget =
            sessionTarget.toLowerCase().startsWith("session:") &&
            sessionTarget.slice(8).trim().length > 0;
          const isIsolatedLikeSessionTarget =
            sessionTarget === "isolated" || sessionTarget === "current" || isCustomSessionTarget;
          if (sessionTarget !== "main" && !isIsolatedLikeSessionTarget) {
            throw new Error("--session must be main, isolated, current, or session:<id>");
          }

          if (opts.deleteAfterRun && opts.keepAfterRun) {
            throw new Error("Choose --delete-after-run or --keep-after-run, not both");
          }

          if (sessionTarget === "main" && payload.kind !== "systemEvent") {
            throw new Error(
              "--session main requires --system-event; --message and --script are not allowed for main sessions.",
            );
          }
          if (isIsolatedLikeSessionTarget && payload.kind === "systemEvent") {
            throw new Error(
              "--system-event is not allowed for isolated/current/session targets; use --message or --script instead.",
            );
          }
          if (
            (opts.announce || typeof opts.deliver === "boolean") &&
            payload.kind === "systemEvent"
          ) {
            throw new Error("--announce/--no-deliver require --message or --script.");
          }

          const accountId =
            typeof opts.account === "string" && opts.account.trim()
              ? opts.account.trim()
              : undefined;

          if (accountId && payload.kind === "systemEvent") {
            throw new Error("--account requires a --message or --script job with delivery.");
          }

          // agentTurn defaults to "announce"; script delivery is opt-in (requires --announce).
          const deliveryMode =
            payload.kind === "agentTurn" && isIsolatedLikeSessionTarget
              ? hasAnnounce
                ? "announce"
                : hasNoDeliver
                  ? "none"
                  : "announce"
              : payload.kind === "script" && isIsolatedLikeSessionTarget
                ? hasAnnounce
                  ? "announce"
                  : hasNoDeliver
                    ? "none"
                    : undefined
                : undefined;

          // Delivery-targeting flags only make sense when announce mode is active.
          if (deliveryMode !== "announce") {
            const hasExplicitDeliveryFlags =
              (typeof opts.to === "string" && opts.to.trim().length > 0) ||
              Boolean(accountId) ||
              opts.bestEffortDeliver === true ||
              optionSource("channel") === "cli";
            if (hasExplicitDeliveryFlags) {
              throw new Error(
                "Delivery flags (--to, --channel, --account, --best-effort-deliver) require --announce. Add --announce to enable delivery.",
              );
            }
          }

          const nameRaw = typeof opts.name === "string" ? opts.name : "";
          const name = nameRaw.trim();
          if (!name) {
            throw new Error("--name is required");
          }

          const description =
            typeof opts.description === "string" && opts.description.trim()
              ? opts.description.trim()
              : undefined;

          const sessionKey =
            typeof opts.sessionKey === "string" && opts.sessionKey.trim()
              ? opts.sessionKey.trim()
              : undefined;

          const params = {
            name,
            description,
            enabled: !opts.disabled,
            deleteAfterRun: opts.deleteAfterRun ? true : opts.keepAfterRun ? false : undefined,
            agentId,
            sessionKey,
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
                  accountId,
                  bestEffort: opts.bestEffortDeliver ? true : undefined,
                }
              : undefined,
          };

          const res = await callGatewayFromCli("cron.add", opts, params);
          printCronJson(res);
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}
