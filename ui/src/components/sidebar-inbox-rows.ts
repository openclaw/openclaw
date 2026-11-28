import { createSignal } from "solid-js";
import type { MentionsCapability } from "../app/mentions.ts";
import type { SidebarInboxEntry } from "./sidebar-attention-entries.ts";
import type { SidebarAttentionFocus } from "./sidebar-attention-focus.ts";

export function inboxEntryIdentity(
  entry: SidebarInboxEntry,
  connectionRevision: number,
  recoveryScope: string | undefined,
): string {
  switch (entry.type) {
    case "approval":
      return JSON.stringify([entry.type, entry.approval.id]);
    case "mention":
      return JSON.stringify([entry.type, entry.mention.id]);
    case "attention":
      return JSON.stringify([entry.type, entry.kind, entry.signature]);
    case "outbox":
      return JSON.stringify([
        entry.type,
        entry.id,
        entry.sessionKey,
        entry.agentId,
        connectionRevision,
        recoveryScope,
      ]);
    case "scopeUpgrade":
    case "update":
      return entry.type;
  }
  return entry satisfies never;
}

/** Only the departing pixels outlive membership; a new tab or viewer discards the exit. */
export function createSidebarMentionExit(
  mentionSource: MentionsCapability,
  focus: SidebarAttentionFocus,
  list: () => HTMLElement | null,
  scope: () => void,
) {
  const [exits, setExits] = createSignal(() => {
    scope();
    return new Set<string>();
  });
  const dismissMentions = (ids: readonly string[]) => {
    const rows = focus.rows();
    const departing = rows.filter((row) => {
      const id = row.closest<HTMLElement>("[data-mention-id]")?.dataset.mentionId;
      return id && ids.includes(id);
    });
    const focused = departing.find((row) => row.contains(document.activeElement));
    if (focused) {
      const index = rows.indexOf(focused);
      (
        rows.slice(index + 1).find((row) => !departing.includes(row)) ??
        rows.slice(0, index).findLast((row) => !departing.includes(row)) ??
        list()
      )?.focus({ preventScroll: true });
    }
    void mentionSource.dismiss(ids);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    for (const target of departing) {
      const row = target.closest<HTMLElement>("[data-mention-id]")!;
      const id = row.dataset.mentionId!;
      if (!row.animate || !mentionSource.snapshot.dismissing.includes(id)) {
        continue;
      }
      setExits((current) => new Set(current).add(id));
      const animation = row.animate(
        [
          { opacity: 1, height: `${row.offsetHeight}px` },
          { opacity: 0, height: "0px" },
        ],
        { duration: 150, easing: "ease-out" },
      );
      const finish = () =>
        setExits((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      void animation.finished.then(finish, finish);
    }
  };
  type Row = { entry: SidebarInboxEntry; identity: string };
  function retainExits(rows: Row[], previous: Row[] | undefined, hasError: boolean) {
    if (exits().size && !hasError) {
      previous?.forEach((row, index) => {
        if (
          row.entry.type === "mention" &&
          exits().has(row.entry.mention.id) &&
          !rows.some((current) => current.identity === row.identity)
        ) {
          rows.splice(index, 0, row);
        }
      });
    }
    return rows;
  }
  return { exits, dismissMentions, retainExits };
}
