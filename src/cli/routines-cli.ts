// Durable routines CLI.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { CronPayload, CronSchedule } from "../cron/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatTimestamp } from "../logging/timestamps.js";
import { sanitizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { resolveCronCreateScheduleFromArgs } from "./cron-cli/schedule-options.js";
import {
  getCronChannelOptions,
  handleCronCliError,
  printCronJson,
  warnIfCronSchedulerDisabled,
} from "./cron-cli/shared.js";
import {
  normalizeCronSessionTargetOption,
  parseCronThreadIdOption,
} from "./cron-cli/thread-id-shared.js";
import { addGatewayClientOptions, callGatewayFromCli, type GatewayRpcOpts } from "./gateway-rpc.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

type RoutineCliOpts = GatewayRpcOpts & Record<string, unknown>;

type RoutineView = {
  id: string;
  name: string;
  enabled: boolean;
  trigger?: {
    kind?: string;
    schedule?: CronSchedule;
    cronJobId?: string;
  };
  status?: {
    status?: string;
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    lastRunStatus?: string;
    lastError?: string;
  };
};

function formatMaybeTime(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? formatTimestamp(new Date(value), { style: "short" })
    : "-";
}

function formatSchedule(schedule: CronSchedule | undefined): string {
  if (!schedule) {
    return "-";
  }
  if (schedule.kind === "at") {
    return `at ${schedule.at}`;
  }
  if (schedule.kind === "every") {
    return `every ${schedule.everyMs}ms`;
  }
  return `cron ${schedule.expr}`;
}

function printRoutineList(routines: RoutineView[]) {
  if (routines.length === 0) {
    defaultRuntime.log(theme.muted("No routines found."));
    return;
  }
  defaultRuntime.writeStdout(
    renderTable({
      width: getTerminalTableWidth(),
      border: "none",
      columns: [
        { key: "id", header: "ID", minWidth: 10, maxWidth: 24 },
        { key: "status", header: "Status", minWidth: 8, maxWidth: 12 },
        { key: "next", header: "Next", minWidth: 12, maxWidth: 22 },
        { key: "last", header: "Last", minWidth: 12, maxWidth: 22 },
        { key: "schedule", header: "Schedule", minWidth: 16, maxWidth: 28 },
        { key: "name", header: "Name", minWidth: 12, flex: true },
      ],
      rows: routines.map((routine) => ({
        id: routine.id,
        status: routine.status?.status ?? (routine.enabled ? "enabled" : "disabled"),
        next: formatMaybeTime(routine.status?.nextRunAtMs),
        last:
          routine.status?.lastRunStatus && routine.status?.lastRunAtMs
            ? `${routine.status.lastRunStatus} ${formatMaybeTime(routine.status.lastRunAtMs)}`
            : "-",
        schedule: formatSchedule(routine.trigger?.schedule),
        name: routine.name,
      })),
    }),
  );
}

function parseRoutinePayload(opts: RoutineCliOpts, messageArg: string | undefined): CronPayload {
  const systemEvent = normalizeOptionalString(opts.systemEvent);
  const optionMessage = normalizeOptionalString(opts.message);
  const positionalMessage = normalizeOptionalString(messageArg);
  if (optionMessage && positionalMessage && optionMessage !== positionalMessage) {
    throw new Error("Pass the routine message either positionally or with --message, not both.");
  }
  const message = optionMessage ?? positionalMessage;
  const chosen = [Boolean(systemEvent), Boolean(message)].filter(Boolean).length;
  if (chosen !== 1) {
    throw new Error("Choose exactly one payload: --system-event or --message.");
  }
  if (systemEvent) {
    return { kind: "systemEvent", text: systemEvent };
  }
  return { kind: "agentTurn", message: message ?? "" };
}

function resolveSessionTarget(opts: RoutineCliOpts, payload: CronPayload): string {
  const raw = normalizeOptionalString(opts.session);
  const parsed = raw ? normalizeCronSessionTargetOption(raw) : undefined;
  if (raw && !parsed) {
    throw new Error("--session must be main, isolated, current, or session:<id>");
  }
  return parsed ?? (payload.kind === "systemEvent" ? "main" : "isolated");
}

function assertPayloadMatchesTarget(sessionTarget: string, payload: CronPayload) {
  const normalizedTarget = normalizeLowercaseStringOrEmpty(sessionTarget);
  const isCustomSessionTarget =
    normalizedTarget.startsWith("session:") &&
    Boolean(normalizeOptionalString(sessionTarget.slice(8)));
  const isIsolatedLike =
    sessionTarget === "isolated" || sessionTarget === "current" || isCustomSessionTarget;
  if (sessionTarget === "main" && payload.kind !== "systemEvent") {
    throw new Error("Main routines require --system-event.");
  }
  if (isIsolatedLike && payload.kind === "systemEvent") {
    throw new Error("Isolated/current/custom-session routines require --message.");
  }
}

function resolveDelivery(opts: RoutineCliOpts, payload: CronPayload, sessionTarget: string) {
  const webhookUrl = normalizeOptionalString(opts.webhook);
  const hasWebhook = typeof opts.webhook === "string";
  const hasAnnounce = Boolean(opts.announce);
  const hasNoDeliver = opts.deliver === false;
  const deliveryFlagCount = [hasAnnounce, hasNoDeliver, hasWebhook].filter(Boolean).length;
  if (deliveryFlagCount > 1) {
    throw new Error("Choose at most one of --announce, --no-deliver, or --webhook.");
  }
  const accountId = normalizeOptionalString(opts.account);
  const threadId = parseCronThreadIdOption(opts.threadId);
  const hasChatDeliveryTarget =
    typeof opts.channel === "string" ||
    typeof opts.to === "string" ||
    Boolean(accountId) ||
    typeof threadId === "number";
  if (hasWebhook && hasChatDeliveryTarget) {
    throw new Error("--webhook cannot be combined with chat delivery options.");
  }
  if (payload.kind === "systemEvent" || sessionTarget === "main") {
    if (deliveryFlagCount > 0 || hasChatDeliveryTarget) {
      throw new Error("Delivery options require a non-main message routine.");
    }
    return undefined;
  }
  const mode = hasWebhook
    ? "webhook"
    : hasNoDeliver
      ? "none"
      : hasAnnounce
        ? "announce"
        : undefined;
  if (!mode && !hasChatDeliveryTarget) {
    return undefined;
  }
  return {
    mode: mode ?? "announce",
    channel: hasWebhook ? undefined : normalizeOptionalString(opts.channel),
    to: hasWebhook ? webhookUrl : normalizeOptionalString(opts.to),
    threadId: hasWebhook ? undefined : threadId,
    accountId: hasWebhook ? undefined : accountId,
  };
}

async function createRoutineFromCli(
  scheduleArg: string | undefined,
  messageArg: string | undefined,
  opts: RoutineCliOpts,
) {
  const hasScheduleFlag =
    typeof opts.at === "string" || typeof opts.cron === "string" || typeof opts.every === "string";
  const schedule = resolveCronCreateScheduleFromArgs({
    at: opts.at,
    cron: opts.cron,
    every: opts.every,
    exact: opts.exact,
    positionalSchedule: hasScheduleFlag ? undefined : scheduleArg,
    stagger: opts.stagger,
    tz: opts.tz,
  });
  const payload = parseRoutinePayload(opts, messageArg);
  const wakeMode = normalizeOptionalString(opts.wake) ?? "now";
  if (wakeMode !== "now" && wakeMode !== "next-heartbeat") {
    throw new Error("--wake must be now or next-heartbeat");
  }
  const sessionTarget = resolveSessionTarget(opts, payload);
  assertPayloadMatchesTarget(sessionTarget, payload);
  const agentId = normalizeOptionalString(opts.agent);
  const params = {
    id: normalizeOptionalString(opts.id),
    name: normalizeOptionalString(opts.name),
    description: normalizeOptionalString(opts.description),
    enabled: opts.disabled ? false : undefined,
    owner: {
      ...(agentId ? { agentId: sanitizeAgentId(agentId) } : {}),
      ...(normalizeOptionalString(opts.sessionKey)
        ? { sessionKey: normalizeOptionalString(opts.sessionKey) }
        : {}),
    },
    target: {
      sessionTarget,
      wakeMode,
      delivery: resolveDelivery(opts, payload, sessionTarget),
    },
    trigger: {
      kind: "schedule",
      schedule,
    },
    action: payload,
  };
  if (!params.name) {
    throw new Error("Routine name is required. Pass --name <name>.");
  }
  const res = await callGatewayFromCli("routines.create", opts, params);
  if (opts.json) {
    printCronJson(res);
  } else {
    const created = (res as { created?: boolean; idempotent?: boolean })?.created;
    const routine = (res as { routine?: RoutineView })?.routine;
    defaultRuntime.log(
      `${created ? "Created" : "Unchanged"} routine ${routine?.id ?? params.id ?? ""}`.trim(),
    );
  }
  await warnIfCronSchedulerDisabled(opts);
}

function registerRoutinesListCommand(routines: Command) {
  addGatewayClientOptions(
    routines
      .command("list")
      .description("List durable routines")
      .option("--all", "Include disabled routines", false)
      .option("--agent <id>", "Filter by owner agent id")
      .option("--query <text>", "Filter by name or description")
      .option("--limit <n>", "Maximum routines to return")
      .option("--offset <n>", "Offset into routine list")
      .option("--json", "Output JSON", false)
      .action(async (opts: RoutineCliOpts) => {
        try {
          const params = {
            includeDisabled: Boolean(opts.all),
            agentId: normalizeOptionalString(opts.agent),
            query: normalizeOptionalString(opts.query),
            limit: opts.limit === undefined ? undefined : Number(opts.limit),
            offset: opts.offset === undefined ? undefined : Number(opts.offset),
          };
          const res = await callGatewayFromCli("routines.list", opts, params);
          if (opts.json) {
            printCronJson(res);
            return;
          }
          printRoutineList((res as { routines?: RoutineView[] })?.routines ?? []);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}

function registerRoutinesGetCommand(routines: Command) {
  addGatewayClientOptions(
    routines
      .command("get")
      .alias("show")
      .description("Inspect a durable routine")
      .argument("<id>", "Routine id")
      .option("--json", "Output JSON", false)
      .action(async (id: string, opts: RoutineCliOpts) => {
        try {
          const res = await callGatewayFromCli("routines.get", opts, { id });
          printCronJson(res);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}

function registerRoutinesCreateCommand(routines: Command) {
  addGatewayClientOptions(
    routines
      .command("create")
      .alias("add")
      .description("Create a durable scheduled routine")
      .argument("[schedule]", "Schedule string when not using --at/--every/--cron")
      .argument("[message]", "Agent message when using a positional schedule")
      .option("--id <id>", "Stable routine id for idempotent create")
      .option("--name <name>", "Routine name")
      .option("--description <text>", "Optional description")
      .option("--disabled", "Create routine disabled", false)
      .option("--agent <id>", "Owner agent id")
      .option("--session-key <key>", "Owner session key")
      .option("--session <target>", "Target session (main|isolated|current|session:<id>)")
      .option("--wake <mode>", "Wake mode (now|next-heartbeat)", "now")
      .option("--at <when>", "Run once at time (ISO with offset, or +duration)")
      .option("--every <duration>", "Run every duration (e.g. 10m, 1h)")
      .option("--cron <expr>", "Cron expression (5-field or 6-field with seconds)")
      .option("--tz <iana>", "Timezone for cron expressions", "")
      .option("--stagger <duration>", "Cron stagger window (e.g. 30s, 5m)")
      .option("--exact", "Disable cron staggering (set stagger to 0)", false)
      .option("--system-event <text>", "System event payload for main session routines")
      .option("--message <text>", "Agent message payload")
      .option("--announce", "Deliver final text to a chat", false)
      .option("--no-deliver", "Disable runner fallback delivery")
      .option("--webhook <url>", "POST the finished payload to a webhook URL")
      .option("--channel <channel>", `Delivery channel (${getCronChannelOptions()})`)
      .option("--to <dest>", "Delivery destination")
      .option("--thread-id <id>", "Telegram forum topic thread id")
      .option("--account <id>", "Channel account id for delivery")
      .option("--json", "Output JSON", false)
      .action(
        async (
          scheduleArg: string | undefined,
          messageArg: string | undefined,
          opts: RoutineCliOpts,
        ) => {
          try {
            await createRoutineFromCli(scheduleArg, messageArg, opts);
          } catch (err) {
            defaultRuntime.error(formatErrorMessage(err));
            defaultRuntime.exit(1);
          }
        },
      ),
  );
}

function registerRoutinesToggleCommand(
  routines: Command,
  name: "enable" | "disable",
  method: "routines.enable" | "routines.disable",
) {
  addGatewayClientOptions(
    routines
      .command(name)
      .description(`${name === "enable" ? "Enable" : "Disable"} a durable routine`)
      .argument("<id>", "Routine id")
      .option("--json", "Output JSON", false)
      .action(async (id: string, opts: RoutineCliOpts) => {
        try {
          const res = await callGatewayFromCli(method, opts, { id });
          if (opts.json) {
            printCronJson(res);
          } else {
            defaultRuntime.log(`${name === "enable" ? "Enabled" : "Disabled"} routine ${id}`);
          }
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}

function registerRoutinesDeleteCommand(routines: Command) {
  addGatewayClientOptions(
    routines
      .command("delete")
      .alias("rm")
      .description("Delete a durable routine and its backing cron job")
      .argument("<id>", "Routine id")
      .option("--json", "Output JSON", false)
      .action(async (id: string, opts: RoutineCliOpts) => {
        try {
          const res = await callGatewayFromCli("routines.delete", opts, { id });
          if (opts.json) {
            printCronJson(res);
          } else {
            const deleted = (res as { deleted?: boolean })?.deleted;
            defaultRuntime.log(`${deleted ? "Deleted" : "No existing"} routine ${id}`);
          }
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}

export function registerRoutinesCli(program: Command) {
  const routines = program
    .command("routines")
    .description("Manage durable team-operation routines")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/routines", "docs.openclaw.ai/cli/routines")}\n`,
    );

  registerRoutinesListCommand(routines);
  registerRoutinesGetCommand(routines);
  registerRoutinesCreateCommand(routines);
  registerRoutinesToggleCommand(routines, "enable", "routines.enable");
  registerRoutinesToggleCommand(routines, "disable", "routines.disable");
  registerRoutinesDeleteCommand(routines);

  applyParentDefaultHelpAction(routines);
}
