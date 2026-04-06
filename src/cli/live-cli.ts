import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatHelpExamples } from "./help-format.js";
import {
  collectLiveStatus,
  createDraftWorktree,
  listLiveJournal,
  promoteLiveSource,
  startLiveRuntime,
  type LiveStatusSnapshot,
} from "./live-control.js";

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function renderWatcherStatus(status: LiveStatusSnapshot["watcher"]): string {
  if (status.status === "inactive") {
    return "inactive (dev reload off)";
  }
  return `${status.status}${status.pid ? ` (pid ${status.pid})` : ""}`;
}

function renderDraftSummary(status: LiveStatusSnapshot): string {
  if (status.drafts.length === 0) {
    return "0";
  }
  const dirtyCount = status.drafts.filter((draft) => draft.dirty).length;
  return dirtyCount > 0
    ? `${status.drafts.length} (${dirtyCount} dirty)`
    : `${status.drafts.length}`;
}

function renderDraftLabel(draft: LiveStatusSnapshot["drafts"][number]): string {
  const parts = [];
  if (draft.branch) {
    parts.push(draft.branch);
  }
  parts.push(draft.dirty ? "dirty" : "clean");
  return `${draft.path} (${parts.join(", ")})`;
}

function renderLiveStatus(status: LiveStatusSnapshot): string[] {
  const rich = isRich();
  const lines = [
    colorize(rich, theme.heading, "Live Control"),
    `${colorize(rich, theme.muted, "Live checkout:")} ${status.manifest.liveCheckoutPath}`,
    `${colorize(rich, theme.muted, "Live branch:")} ${status.liveGit.branch} (policy: ${status.manifest.liveBranch})`,
    `${colorize(rich, theme.muted, "Live HEAD:")} ${status.liveGit.head.slice(0, 7)}`,
    `${colorize(rich, theme.muted, "Promoted:")} ${status.manifest.promotedCommit?.slice(0, 7) ?? "none"}`,
    `${colorize(rich, theme.muted, "Live dirty:")} ${status.liveGit.dirty ? colorize(rich, theme.warn, "yes") : colorize(rich, theme.success, "no")}`,
    `${colorize(rich, theme.muted, "Runtime:")} ${status.runtime.summary}`,
    `${colorize(rich, theme.muted, "Runtime source:")} ${status.runtime.sourcePath ?? "unknown"}`,
    `${colorize(rich, theme.muted, "Watcher:")} ${renderWatcherStatus(status.watcher)}`,
    `${colorize(rich, theme.muted, "Actor lock:")} ${status.actorLock ? `${status.actorLock.operation} by ${status.actorLock.actor} (pid ${status.actorLock.pid})` : "none"}`,
    `${colorize(rich, theme.muted, "Draft worktrees:")} ${renderDraftSummary(status)}`,
  ];
  if (status.issues.length > 0) {
    lines.push(colorize(rich, theme.warn, "Issues:"));
    for (const issue of status.issues) {
      lines.push(`- ${issue.message}`);
    }
  } else {
    lines.push(colorize(rich, theme.success, "Issues: none"));
  }
  if (status.recentJournal.length > 0) {
    lines.push(colorize(rich, theme.heading, "Recent journal"));
    for (const entry of status.recentJournal) {
      lines.push(`- ${entry.ts} · ${entry.type} · ${entry.message}`);
    }
  }
  if (status.drafts.length > 0) {
    lines.push(colorize(rich, theme.heading, "Draft paths"));
    for (const draft of status.drafts) {
      lines.push(`- ${renderDraftLabel(draft)}`);
    }
  }
  return lines;
}

export function registerLiveCli(program: Command) {
  const live = program
    .command("live")
    .description("Inspect and control the live/draft workflow boundary")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw live status", "Show live vs draft state, runtime source, and journal."],
          ["openclaw live start", "Restart the Telegram-facing runtime from the live checkout."],
          ["openclaw live propose codex-local", "Create a dedicated draft worktree."],
          [
            "openclaw live promote /path/to/draft",
            "Promote a clean draft worktree into live state.",
          ],
          ["openclaw live promote rollback", "Roll back to the previous promoted commit."],
          ["openclaw live journal --limit 20", "Show recent live-control events."],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/live", "docs.openclaw.ai/cli/live")}\n`,
    );

  live
    .command("status")
    .description("Show live vs draft state, runtime source, and recent journal events")
    .option("--checkout <path>", "Explicit live checkout path")
    .option("--limit <n>", "Recent journal entries to include", "10")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const status = await collectLiveStatus({
          checkout: opts.checkout as string | undefined,
          journalLimit: parsePositiveInt(opts.limit, 10),
        });
        if (opts.json) {
          defaultRuntime.writeJson(status);
          return;
        }
        for (const line of renderLiveStatus(status)) {
          defaultRuntime.log(line);
        }
      });
    });

  live
    .command("start")
    .description("Restart the live runtime from the canonical live checkout")
    .option("--checkout <path>", "Explicit live checkout path")
    .option("--actor <name>", "Actor label for journal entries")
    .option("--smoke-timeout <ms>", "RPC smoke-check timeout", "10000")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const status = await startLiveRuntime({
          actor: opts.actor as string | undefined,
          checkout: opts.checkout as string | undefined,
          smokeTimeoutMs: parsePositiveInt(opts.smokeTimeout, 10_000),
        });
        defaultRuntime.log(
          `Live runtime restarted from ${status.manifest.liveCheckoutPath} (${status.manifest.promotedCommit?.slice(0, 7) ?? "no promoted commit"}).`,
        );
      });
    });

  live
    .command("propose")
    .description("Create a dedicated draft worktree for local or agent-proposed changes")
    .argument("<name>", "Draft name")
    .option("--message <text>", "Draft intent to record in the journal")
    .option("--checkout <path>", "Explicit live checkout path")
    .option("--actor <name>", "Actor label for journal entries")
    .action(async (name, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await createDraftWorktree({
          actor: opts.actor as string | undefined,
          checkout: opts.checkout as string | undefined,
          message: opts.message as string | undefined,
          name,
        });
        defaultRuntime.log(`Draft created: ${result.path}`);
        defaultRuntime.log(`Branch: ${result.branch}`);
      });
    });

  live
    .command("promote")
    .description("Promote a clean draft checkout into live state, or roll back")
    .argument("[source]", "Draft checkout path, `current`, or `rollback`", "current")
    .option("--checkout <path>", "Explicit live checkout path")
    .option("--actor <name>", "Actor label for journal entries")
    .option("--build-timeout <ms>", "Build timeout in milliseconds", "1200000")
    .option("--smoke-timeout <ms>", "RPC smoke-check timeout", "10000")
    .action(async (source, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await promoteLiveSource({
          actor: opts.actor as string | undefined,
          buildTimeoutMs: parsePositiveInt(opts.buildTimeout, 1_200_000),
          checkout: opts.checkout as string | undefined,
          smokeTimeoutMs: parsePositiveInt(opts.smokeTimeout, 10_000),
          source: source as string | undefined,
        });
        const promoted = result.manifest.promotedCommit?.slice(0, 7) ?? "unknown";
        if ((source as string | undefined)?.trim() === "rollback") {
          defaultRuntime.log(`Live state rolled back to ${promoted}.`);
          return;
        }
        defaultRuntime.log(`Live state promoted to ${promoted} from ${result.sourceRoot}.`);
      });
    });

  live
    .command("journal")
    .description("Show recent live-control journal entries")
    .option("--checkout <path>", "Explicit live checkout path")
    .option("--limit <n>", "Entries to show", "10")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await listLiveJournal({
          checkout: opts.checkout as string | undefined,
          limit: parsePositiveInt(opts.limit, 10),
        });
        if (opts.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        const rich = isRich();
        defaultRuntime.log(colorize(rich, theme.heading, "Live Journal"));
        defaultRuntime.log(
          `${colorize(rich, theme.muted, "Live checkout:")} ${result.manifest.liveCheckoutPath}`,
        );
        if (result.entries.length === 0) {
          defaultRuntime.log(colorize(rich, theme.muted, "No journal entries yet."));
          return;
        }
        for (const entry of result.entries) {
          defaultRuntime.log(`- ${entry.ts} · ${entry.actor} · ${entry.type} · ${entry.message}`);
        }
      });
    });
}
