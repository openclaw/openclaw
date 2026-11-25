import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  unwrapToolCallForDisplay,
  unwrapToolResultTextForDisplay,
} from "../../../../../src/agents/tool-display-call.js";
import { registerChatToolLabelsEnglish } from "../../../i18n/locales/en-chat-tool-labels.ts";
import type { ToolCard, ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import { PATCH_TOOL_NAMES, resolveToolCallInput } from "../../../lib/chat/tool-call-input.ts";
import type { ToolCallView } from "../../../lib/chat/tool-call-view.ts";
import { resolveToolDisplayIdentity } from "../../../lib/chat/tool-display-identity.ts";
import { pathDisplayName } from "../../../lib/path-display.ts";
import { getLocale, t } from "../../../lib/reactive/i18n.ts";
import {
  readSubagentCancellation,
  resolveSessionLaunchPresentation,
} from "../chat-spawned-subagent.ts";

registerChatToolLabelsEnglish();

const TOOL_ROW_VERB_KEYS = {
  read: ["reading", "read", "readFailed", "read"],
  search: ["searching", "searched", "searchFailed", "search"],
  fetch: ["fetching", "fetched", "fetchFailed", "fetch"],
} as const;

const MUTATION_VERB_KEYS = {
  update: ["editing", "edited", "edit"],
  add: ["creating", "created", "create"],
  delete: ["deleting", "deleted", "delete"],
  mixed: ["changing", "changed", "change"],
  write: ["writing", "wrote", "write"],
} as const;

function byOutcome<T>(outcome: ToolCardOutcome, running: T, succeeded: T, other: T): T {
  return outcome === "running" ? running : outcome === "succeeded" ? succeeded : other;
}

export function resolveToolRowVerb(
  view: Pick<ToolCallView, "kind" | "fileOperations">,
  outcome: ToolCardOutcome,
): string | undefined {
  let mutation: keyof typeof MUTATION_VERB_KEYS | undefined;
  if (view.kind === "write") {
    mutation = "write";
  } else if (view.kind === "edit") {
    const operations = new Set(view.fileOperations?.map(({ operation }) => operation));
    mutation = operations.size > 1 ? "mixed" : (operations.values().next().value ?? "update");
  }
  if (mutation) {
    const [running, succeeded, fallback] = MUTATION_VERB_KEYS[mutation];
    return t(`chat.toolCards.verbs.${byOutcome(outcome, running, succeeded, fallback)}`);
  }
  if (view.kind === "read" || view.kind === "search" || view.kind === "fetch") {
    const [running, succeeded, failed, fallback] = TOOL_ROW_VERB_KEYS[view.kind];
    return t(
      `chat.toolCards.verbs.${byOutcome(outcome, running, succeeded, outcome === "failed" ? failed : fallback)}`,
    );
  }
  return undefined;
}

export function commandPreview(command: string): string {
  return truncateUtf16Safe(command.replace(/\s+/gu, " ").trim(), 200);
}

export const SESSION_LAUNCH_LIMIT_STYLE = {
  "white-space": "normal",
  "overflow-wrap": "anywhere",
} as const;

export function formatSessionLaunchLimit(
  launch: ReturnType<typeof resolveSessionLaunchPresentation>,
): string | undefined {
  if (launch?.capacity) {
    return t(
      launch.label
        ? "chat.toolCards.launch.subagent.namedLimitReached"
        : "chat.toolCards.launch.subagent.limitReached",
      { ...launch.capacity, name: launch.label ?? "" },
    );
  }
  return undefined;
}

/** Recorded child actions replace containers; a standalone code operation keeps its purpose. */
export function resolveToolOperationLabel(
  card: ToolCard,
  outcome: ToolCardOutcome,
  addressed?: { name?: string; names?: string[] },
  detail = card.activity?.meta,
): string {
  const launch = resolveSessionLaunchPresentation(card, outcome);
  if (launch) {
    return (
      formatSessionLaunchLimit(launch) ??
      [t(`chat.toolCards.launch.${launch.kind}.${launch.phase}`), addressed?.name ?? launch.label]
        .filter(Boolean)
        .join(" ")
    );
  }
  const call = unwrapToolCallForDisplay(card);
  const args = asNullableRecord(call.args);
  const input = resolveToolCallInput(call.name, args);
  if (input.kind === "command") {
    const command = typeof args?.command === "string" ? args.command : undefined;
    if (command?.trim()) {
      return outcome === "running"
        ? t("chat.toolCards.runningCommand", { command: commandPreview(command) })
        : t(
            outcome === "succeeded" || (outcome === "failed" && card.exitCode !== undefined)
              ? "chat.toolCards.ranCommand"
              : "chat.toolCards.runCommand",
            { command: commandPreview(command) },
          );
    }
    if (
      call.name.trim().toLowerCase() === "exec" &&
      typeof args?.title === "string" &&
      args.title.trim()
    ) {
      return args.title.trim();
    }
    return t(
      `chat.toolCards.${byOutcome(outcome, "executingCode", "executedCode", "codeExecution")}`,
    );
  }
  const verb = resolveToolRowVerb(input, outcome);
  const target =
    input.kind === "fetch"
      ? input.url
      : input.kind === "search" && input.pattern
        ? input.pattern
        : input.path && pathDisplayName(input.path);
  if (verb && target) {
    return `${verb} ${target}`;
  }
  const cancellation = readSubagentCancellation(card);
  if (cancellation) {
    const action =
      outcome === "running"
        ? "stoppingSubagent"
        : cancellation.stopped
          ? "stoppedSubagent"
          : "stopSubagent";
    return [t("chat.toolCards." + action), addressed?.name].filter(Boolean).join(" ");
  }
  const display = resolveToolDisplayIdentity(call.name);
  const name = call.name.trim().toLowerCase();
  if (name === "get_goal") {
    return t(`chat.toolCards.${byOutcome(outcome, "checkingGoal", "checkedGoal", "checkGoal")}`);
  }
  if (name === "sessions_send") {
    const result = {
      ...asNullableRecord(card.details),
      ...safeParseJsonRecord(unwrapToolResultTextForDisplay(card.outputText ?? "")),
    };
    let action = outcome === "running" ? "sending" : "send";
    if (
      (outcome === "failed" || outcome === "succeeded") &&
      result.sentBeforeError === true &&
      (result.status === "timeout" || result.status === "error")
    ) {
      // A generic error can also mean that Gateway admission is still pending.
      action = result.status === "timeout" ? "replyTimedOut" : "unconfirmed";
    } else if (outcome === "succeeded") {
      action = "unconfirmed";
      if (result.status === "ok" || result.status === "no_reply") {
        action = "sent";
      } else if (result.status === "accepted" || result.status === "queued") {
        action = result.status;
      } else if (
        result.status === "started" &&
        asNullableRecord(result.retained)?.acceptance === "not_accepted"
      ) {
        action = "deferred";
      }
    }
    const targetName =
      addressed?.name ?? (typeof args?.label === "string" ? args.label.trim() : undefined);
    return t(`chat.toolCards.sessionSend.${action}${targetName ? "Named" : ""}`, {
      name: targetName ?? "",
    });
  }
  if (PATCH_TOOL_NAMES.has(name)) {
    return t(
      `chat.toolCards.${byOutcome(outcome, "changingFiles", "changedFiles", "fileChanges")}`,
    );
  }
  if (name === "view_image") {
    const key = byOutcome(outcome, "viewingImage", "viewedImage", "viewImage");
    return t(`chat.toolCards.${key}`);
  }
  if (name === "ask_user") {
    const key = byOutcome(outcome, "askingQuestion", "askedQuestion", "questionRequest");
    return t(
      `chat.toolCards.${key}${Array.isArray(args?.questions) && args.questions.length > 1 && key !== "questionRequest" ? "s" : ""}`,
    );
  }
  if (name === "agents_wait") {
    if (outcome === "running") {
      return t("chat.toolCards.waitingForAgents");
    }
    const action = outcome === "succeeded" ? "waitedFor" : "waitFor";
    return addressed?.names?.length
      ? t(`chat.toolCards.${action}NamedAgents`, {
          names: new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(addressed.names),
        })
      : t(`chat.toolCards.${action}Agents`);
  }
  if (name === "skills_search" || name === "skills_read") {
    const action =
      name === "skills_search"
        ? byOutcome(outcome, "searchingSkills", "searchedSkills", "skillSearch")
        : byOutcome(outcome, "readingSkill", "readSkill", "readSkill");
    const skillTarget = name === "skills_search" ? args?.query : args?.name;
    return [
      t(`chat.toolCards.${action}`),
      typeof skillTarget === "string" ? skillTarget.trim() : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (name === "subagents" && args?.action === "list") {
    return t(
      `chat.toolCards.${byOutcome(outcome, "listingSubagents", "listedSubagents", "listSubagents")}`,
    );
  }
  const sessionLabel =
    name === "sessions_history"
      ? byOutcome(outcome, "readingChat", "readChat", "chatRead")
      : name === "sessions_search"
        ? byOutcome(outcome, "searchingChats", "searchedChats", "chatSearch")
        : undefined;
  return [
    sessionLabel ? t(`chat.toolCards.${sessionLabel}`) : display.label,
    name === "sessions_history" ? addressed?.name : addressed ? addressed.name : detail,
  ]
    .filter(Boolean)
    .join(" ");
}
