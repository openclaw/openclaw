import type {
  SkillsWorkshopReadResult,
  SkillWorkshopChange,
  SkillWorkshopSkillSummary,
} from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import type { SessionMethodAccess } from "../../lib/session-method-access.ts";
import type { SkillWorkshopAccess } from "./access.ts";
import type { WorkshopMutation, WorkshopSnapshot } from "./api.ts";
import type { SkillWorkshopMode } from "./mode.ts";

export function renderWorkshopChangeText(change: SkillWorkshopChange, prefix: string) {
  return html`<span class=${`${prefix}who`}
      >${t(`skillWorkshop.changes.actors.${change.actor}`)}
      ${t(`skillWorkshop.changes.actions.${change.action}`)}</span
    >
    ${change.summary ? html`<span class=${`${prefix}why`}>${change.summary}</span>` : nothing}
    <span class=${`${prefix}when`}>${formatRelativeTimestamp(change.createdAtMs)}</span>`;
}

export function renderMutationButton(
  props: SkillWorkshopViewProps,
  params: {
    label: string;
    title?: string;
    mutation: WorkshopMutation;
    key: string;
    variant?: "default" | "danger" | "link";
  },
) {
  const allowed =
    params.mutation.method === "skills.workshop.archive"
      ? props.access.canArchive
      : props.access.canRestore;
  if (!allowed) {
    return nothing;
  }
  const variant = params.variant ?? "default";
  const className =
    variant === "link"
      ? "sw-link-button"
      : variant === "danger"
        ? "btn btn--sm danger"
        : "btn btn--sm oc-action";
  return html`<button
    type="button"
    class=${className}
    title=${params.title ?? nothing}
    ?disabled=${props.pendingAction !== null}
    @click=${(event: Event) => {
      event.stopPropagation();
      props.onMutate(params.mutation, params.key);
    }}
  >
    ${variant === "danger" ? html`<span aria-hidden="true">${icons.archive}</span>` : nothing}
    ${props.pendingAction === params.key ? t("skillWorkshop.viewer.loading") : params.label}
  </button>`;
}

export function unusedDays(
  skill: SkillWorkshopSkillSummary,
  change: SkillWorkshopChange | undefined,
  mode: SkillWorkshopMode | null,
): number | null {
  if (mode !== "auto") {
    return null;
  }
  const days = Math.floor((Date.now() - lastActivityMs(skill, change)) / DAY_MS);
  return days >= UNUSED_NOTICE_DAYS ? days : null;
}

export function renderUses(count: number | undefined) {
  if (!count) {
    return t("skillWorkshop.skills.noUses");
  }
  return count === 1
    ? t("skillWorkshop.skills.usesOne")
    : t("skillWorkshop.skills.uses", { count: String(count) });
}

const DAY_MS = 24 * 60 * 60_000;
// Cleanup archives a learned skill after 30 idle days; flag it once half that has passed.
export const UNUSED_ARCHIVE_DAYS = 30;
const UNUSED_NOTICE_DAYS = 14;

/** Newest change per skill; the feed is newest first. */
export function latestChanges(changes: readonly SkillWorkshopChange[]) {
  const latest = new Map<string, SkillWorkshopChange>();
  for (const change of changes) {
    if (!latest.has(change.skillName)) {
      latest.set(change.skillName, change);
    }
  }
  return latest;
}

export function lastActivityMs(skill: SkillWorkshopSkillSummary, change?: SkillWorkshopChange) {
  return Math.max(skill.updatedAtMs, skill.lastUsedAtMs ?? 0, change?.createdAtMs ?? 0);
}

export type WorkshopViewerTarget = { name: string; filePath: string; versionId?: string };

export type WorkshopViewer =
  | { target: WorkshopViewerTarget; status: "loading" }
  | {
      target: WorkshopViewerTarget;
      status: "ready";
      result: SkillsWorkshopReadResult;
      /** Live SKILL.md, loaded when a past version of a live skill is open, for the diff. */
      current?: string;
    }
  | { target: WorkshopViewerTarget; status: "error"; error: string };

export type WorkshopFilter = "active" | "archived";
export type WorkshopSort = "uses" | "recent" | "name";
export type WorkshopTab = "instructions" | "files" | "history";

export type SkillWorkshopViewProps = {
  context: ApplicationContext;
  agentId: string | null;
  access: SkillWorkshopAccess;
  snapshot: WorkshopSnapshot | null;
  loading: boolean;
  error: string | null;
  viewer: WorkshopViewer | null;
  filter: WorkshopFilter;
  sort: WorkshopSort;
  tab: WorkshopTab;
  pendingAction: string | null;
  actionError: string | null;
  mode: SkillWorkshopMode | null;
  modeBusy: boolean;
  modeError: string | null;
  learningAccess: SessionMethodAccess;
  learningBusy: boolean;
  learningError: string | null;
  onRetry: () => void;
  onSelectSkill: (name: string) => void;
  onOpen: (target: WorkshopViewerTarget) => void;
  onMutate: (mutation: WorkshopMutation, key: string) => void;
  onModeChange: (mode: SkillWorkshopMode) => void;
  onLearn: () => void;
  onFilter: (filter: WorkshopFilter) => void;
  onSort: (sort: WorkshopSort) => void;
  onTab: (tab: WorkshopTab) => void;
};
