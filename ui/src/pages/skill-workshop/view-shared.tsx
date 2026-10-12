import type {
  SkillsWorkshopReadResult,
  SkillWorkshopChange,
  SkillWorkshopSkillSummary,
} from "@openclaw/gateway-protocol";
import type { ApplicationContext } from "../../app/context.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { SessionMethodAccess } from "../../lib/session-method-access.ts";
import type { SkillWorkshopAccess } from "./access.ts";
import type { WorkshopMutation, WorkshopSnapshot } from "./api.ts";
import type { SkillWorkshopMode } from "./mode.ts";

export type WorkshopView = () => SkillWorkshopViewProps;

export function WorkshopChangeText(props: { change: SkillWorkshopChange; prefix: string }) {
  return (
    <>
      <span class={`${props.prefix}who`}>
        {t(`skillWorkshop.changes.actors.${props.change.actor}`)}{" "}
        {t(`skillWorkshop.changes.actions.${props.change.action}`)}
      </span>
      {props.change.summary && <span class={`${props.prefix}why`}>{props.change.summary}</span>}
      <span class={`${props.prefix}when`}>{formatRelativeTimestamp(props.change.createdAtMs)}</span>
    </>
  );
}

export function MutationButton(props: {
  view: WorkshopView;
  label: string;
  title?: string;
  mutation: WorkshopMutation;
  actionKey: string;
  variant?: "default" | "danger" | "link";
}) {
  const allowed = () =>
    props.mutation.method === "skills.workshop.archive"
      ? props.view().access.canArchive
      : props.view().access.canRestore;
  return (
    <>
      {allowed() && (
        <button
          type="button"
          class={
            props.variant === "link"
              ? "sw-link-button"
              : props.variant === "danger"
                ? "btn btn--sm danger"
                : "btn btn--sm oc-action"
          }
          title={props.title}
          disabled={props.view().pendingAction !== null}
          onClick={(event) => {
            event.stopPropagation();
            props.view().onMutate(props.mutation, props.actionKey);
          }}
        >
          {props.variant === "danger" && (
            <span aria-hidden="true">
              <Icon name="archive" />
            </span>
          )}
          {props.view().pendingAction === props.actionKey
            ? t("skillWorkshop.viewer.loading")
            : props.label}
        </button>
      )}
    </>
  );
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
