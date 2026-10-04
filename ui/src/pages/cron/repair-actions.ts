import type { CronRunLogEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveSidebarMainSessionKey } from "../../components/app-sidebar-session-navigation-logic.ts";
import { copyMarkdownText } from "../../components/markdown-copy.ts";
import {
  composerDraftSearch,
  resolveSessionNavigationAgentId,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { buildCronRepairDraft, buildCronRepairPrompt, cronRepairRunKey } from "./repair-prompt.ts";

export function openCronRepairDraft(
  context: ApplicationContext,
  draft: string,
  preferredAgentId?: string | null,
) {
  const agentId = resolveSessionNavigationAgentId(context, preferredAgentId);
  const sessionKey = resolveSidebarMainSessionKey({
    agentId,
    agentsList: context.agents.state.agentsList,
    hello: context.gateway.snapshot.hello,
  });
  const target = sessionNavigationTarget({
    context,
    face: "chat",
    sessionKey,
    agentId,
  });
  const search = new URLSearchParams(target.options.search);
  new URLSearchParams(composerDraftSearch(draft)).forEach((value, key) => search.set(key, value));
  context.navigate("chat", { ...target.options, search: `?${search}` });
}

export class CronRepairActions {
  status: { key: string; result: "copied" | "failed" } | null = null;
  private attempt = 0;

  constructor(
    private readonly runs: () => readonly CronRunLogEntry[],
    private readonly notify: () => void,
    private readonly openDraft: (draft: string) => void,
  ) {}

  reset() {
    this.attempt += 1;
    this.status = null;
  }

  viewProps() {
    return {
      repairCopyStatus: this.status,
      onFixRunError: (entry: CronRunLogEntry) => this.fix(entry),
      onCopyRunRepairPrompt: (entry: CronRunLogEntry, trigger: HTMLButtonElement) =>
        this.copy(entry, trigger),
    };
  }

  fix(entry: CronRunLogEntry) {
    this.openDraft(buildCronRepairDraft(entry));
  }

  copy(entry: CronRunLogEntry, button: HTMLButtonElement) {
    const key = cronRepairRunKey(entry);
    const attempt = ++this.attempt;
    if (this.status !== null) {
      this.status = null;
      this.notify();
    }
    copyMarkdownText(
      button,
      buildCronRepairPrompt(entry),
      () => attempt === this.attempt && this.runs().some((run) => cronRepairRunKey(run) === key),
      (copied) => {
        if (attempt !== this.attempt) {
          return;
        }
        this.status = copied === undefined ? null : { key, result: copied ? "copied" : "failed" };
        this.notify();
      },
    );
  }
}
