import type {
  SkillsWorkshopListResult,
  SkillsWorkshopReadResult,
  SkillWorkshopChange,
  SkillWorkshopSkillSummary,
} from "@openclaw/gateway-protocol";
import { Show } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { SessionMethodAccess } from "../../lib/session-method-access.ts";
import { canRunWorkshopMutation, type resolveWorkshopAccess } from "./access.ts";
import type { WorkshopMutation, WorkshopSnapshot } from "./api.ts";
import type { SkillWorkshopMode } from "./mode.ts";
import type { WorkshopPluginAvailability } from "./plugin-availability.ts";

export type WorkshopView = () => {
  context: ApplicationContext;
  agentId: string | null;
  /** The sidebar shows all agents; only then does the page offer its agent picker. */
  allAgentsScope: boolean;
  access: ReturnType<typeof resolveWorkshopAccess>;
  /** Set while the Gateway serves no Workshop methods. */
  plugin: WorkshopPluginAvailability | null;
  onEnablePlugin: () => void;
  onRetryPlugin: () => void;
  /** Config sets `plugins.enabled: false`, so enabling one plugin cannot succeed. */
  pluginsDisabled: boolean;
  snapshot: WorkshopSnapshot | null;
  error: string | null;
  viewer: WorkshopViewer | null;
  /** The URL names a skill or draft page (`?skill=` / `?draft=`). */
  pageOpen: boolean;
  onOpenPage: () => void;
  onClosePage: () => void;
  /** The start page's view: drafts waiting for a decision, what changed, or every skill. */
  startView: WorkshopStartView;
  /** Drafts is offered in Propose mode, while drafts wait, or while it is the open view. */
  draftsShown: boolean;
  onStartView: (view: WorkshopStartView) => void;
  /** Learned skills: the active or the archived list. */
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
  onSelectDraft: (draftId: string) => void;
  onOpen: (target: WorkshopViewerTarget) => void;
  onMutate: (mutation: WorkshopMutation, key: string) => void;
  onModeChange: (mode: SkillWorkshopMode) => void;
  onLearn: () => void;
  onFilter: (filter: WorkshopFilter) => void;
  onSort: (sort: WorkshopSort) => void;
  onTab: (tab: WorkshopTab) => void;
};

export function WorkshopChangeText(props: { change: SkillWorkshopChange; prefix: string }) {
  return (
    <>
      <span class={[`${props.prefix}who`]}>
        {t(`skillWorkshop.changes.actors.${props.change.actor}`)}{" "}
        {t(`skillWorkshop.changes.actions.${props.change.action}`)}
      </span>
      {props.change.summary && <span class={[`${props.prefix}why`]}>{props.change.summary}</span>}
      <span class={[`${props.prefix}when`]}>
        {formatRelativeTimestamp(props.change.createdAtMs)}
      </span>
    </>
  );
}

export function MutationButton(props: {
  view: WorkshopView;
  label: string;
  title?: string;
  mutation: WorkshopMutation;
  actionKey: string;
  variant?: "default" | "primary" | "danger" | "link";
  icon?: IconName;
}) {
  const allowed = () => canRunWorkshopMutation(props.view().access, props.mutation.method);
  const icon = () => props.icon ?? (props.variant === "danger" ? "archive" : undefined);
  return (
    <Show when={allowed()}>
      <button
        type="button"
        class={
          props.variant === "link"
            ? "sw-link-button"
            : [
                "btn btn--sm",
                props.variant === "danger"
                  ? "danger"
                  : props.variant === "primary"
                    ? "primary"
                    : "oc-action",
              ]
        }
        title={props.title}
        disabled={props.view().pendingAction !== null}
        onClick={(event) => {
          event.stopPropagation();
          props.view().onMutate(props.mutation, props.actionKey);
        }}
      >
        <Show when={props.variant !== "link" && icon()}>
          {(name) => (
            <span aria-hidden="true">
              <Icon name={name()} />
            </span>
          )}
        </Show>
        {props.view().pendingAction === props.actionKey
          ? t("skillWorkshop.viewer.loading")
          : props.label}
      </button>
    </Show>
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
function latestChanges(changes: readonly SkillWorkshopChange[]) {
  const latest = new Map<string, SkillWorkshopChange>();
  for (const change of changes) {
    if (!latest.has(change.skillName)) {
      latest.set(change.skillName, change);
    }
  }
  return latest;
}

function lastActivityMs(skill: SkillWorkshopSkillSummary, change?: SkillWorkshopChange) {
  return Math.max(skill.updatedAtMs, skill.lastUsedAtMs ?? 0, change?.createdAtMs ?? 0);
}

/** `name` is the skill; `draftId` opens a waiting draft for it instead of the skill itself. */
export type WorkshopViewerTarget = {
  name: string;
  filePath: string;
  versionId?: string;
  draftId?: string;
};

export type WorkshopViewerResult = {
  target: WorkshopViewerTarget;
  result: SkillsWorkshopReadResult;
  /** Live SKILL.md, loaded when a past version or a draft of a live skill is open, for the diff. */
  current?: string;
};

export type WorkshopViewer = { target: WorkshopViewerTarget } & Partial<WorkshopViewerResult>;

export type WorkshopReads = {
  listRequest: () => { result: Promise<unknown> } | null;
  list: () => WorkshopSnapshot | null;
  viewerRequest: () => { result: Promise<unknown> } | null;
  viewer: () => WorkshopViewerResult | null;
};

/** The start page lists skills; `open` shows the selected skill or draft as its own page. */
export type WorkshopPage = { open: () => void; close: () => void };

export type WorkshopFilter = "active" | "archived";
export type WorkshopStartView = "drafts" | "history" | "skills";
export type WorkshopSort = "uses" | "recent" | "name";
export type WorkshopTab = "instructions" | "files" | "history";

export function sortWorkshopSkills(
  skills: readonly SkillWorkshopSkillSummary[],
  changes: readonly SkillWorkshopChange[],
  sort: WorkshopSort,
): SkillWorkshopSkillSummary[] {
  const latest = latestChanges(changes);
  const recent = (skill: SkillWorkshopSkillSummary) =>
    lastActivityMs(skill, latest.get(skill.name));
  return skills.toSorted((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name)
      : sort === "recent"
        ? recent(b) - recent(a)
        : (b.useCount ?? 0) - (a.useCount ?? 0) ||
          recent(b) - recent(a) ||
          a.name.localeCompare(b.name),
  );
}

export function archivedWorkshopSkills(list: SkillsWorkshopListResult) {
  return list.archived
    .filter((skill) => !skill.live && skill.versions.length > 0)
    .toSorted((a, b) => (b.versions[0]?.createdAtMs ?? 0) - (a.versions[0]?.createdAtMs ?? 0));
}

/** History: each skill's latest change, newest first, for skills whose page can open. */
export function workshopHistory(snapshot: WorkshopSnapshot): SkillWorkshopChange[] {
  const { skills, archived } = snapshot.list;
  return [...latestChanges(snapshot.changes).values()]
    .filter(
      (change) =>
        skills.some((skill) => skill.name === change.skillName) ||
        archived.some((skill) => skill.name === change.skillName && skill.versions.length > 0),
    )
    .toSorted((a, b) => b.createdAtMs - a.createdAtMs);
}

/** The page opens on what needs the person: drafts, else what changed, else the skills. */
export function defaultStartView(snapshot: WorkshopSnapshot): WorkshopStartView {
  if ((snapshot.list.drafts?.length ?? 0) > 0) {
    return "drafts";
  }
  return workshopHistory(snapshot).length > 0 || snapshot.list.skills.length === 0
    ? "history"
    : "skills";
}
