import type { JSX } from "@solidjs/web";
import { Errored, For, Loading, Show, createMemo, createSignal, latest, onSettled } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatDetailsEnglish } from "../../../i18n/locales/en-chat-details.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import {
  DETAILS_SUBAGENT_ACTIVITY_PREVIEW_ROWS as PREVIEW_ROWS,
  detailsSubagentCollection,
  projectDetailsSubagents,
} from "../chat-details-snapshot.ts";
import { hasLoadedDetailsSubagents } from "../chat-spawned-subagent.ts";
import {
  listSubagents,
  type ChatSubagentActivity as ChatSubagentActivityRow,
} from "../chat-subagent-wait.ts";
import type { ProcessesPanelData } from "../processes-panel-data.ts";
import {
  ChatDetailsDesktopSection,
  createDetailsDesktopReveal,
} from "./chat-details-desktop-section.tsx";
import { ChatDetailsProcessRow } from "./chat-details-process-row.tsx";
import { createDetailsProcessesPresentation } from "./chat-details-processes-presentation.ts";
import { ChatDetailsSubagents, type ChatDetailsSubagentsProps } from "./chat-details-subagents.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import { createProcessesPresentation } from "./chat-processes-presentation.ts";
import { ChatSubagentActivity } from "./chat-subagent-activity-lazy.tsx";

registerEnglishCatalog(registerChatSessionEnglish);
registerEnglishCatalog(registerChatDetailsEnglish);

type Props = {
  details: ChatDetailsProps;
  presented: boolean;
  /** Desktop renders its own process list; other consumers retain the native summary. */
  showProcesses?: boolean;
  /** Supplied only by the native desktop composition; mobile keeps its own body. */
  desktopSubagents?: {
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
    workingLabel: string;
  };
};
type State = "running" | "queued" | "failed" | "stopped" | "done";
type Tally = Record<State, number>;

// The bar fills settled work from the start; the text leads with what is still going.
const SEGMENTS = ["done", "failed", "stopped", "running", "queued"] as const;
const SUMMARY = ["running", "queued", "done", "failed", "stopped"] as const;
// Rows list what still needs attention first: live work, then failures.
const ORDER: Record<State, number> = { running: 0, queued: 1, failed: 2, stopped: 3, done: 4 };

const subagentState = (row: ChatSubagentActivityRow): State =>
  row.status === "waiting" ? "running" : row.status;

function BackgroundMore(props: {
  hidden: number;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Show when={props.hidden > 0}>
      <button
        type="button"
        class="chat-details__more"
        disabled={props.disabled}
        aria-expanded={props.expanded ? "true" : "false"}
        onClick={() => props.onExpandedChange(!props.expanded)}
      >
        {props.expanded
          ? t("chat.sessionDetails.showLess")
          : t("chat.sessionDetails.showMore", { count: String(props.hidden) })}
      </button>
    </Show>
  );
}

/**
 * One collapsible kind of background work. The heading keeps the observed counts
 * and their bar visible while collapsed; the body previews the first rows.
 */
function BackgroundGroup(props: {
  kind: "subagents" | "processes";
  title: string;
  tally: Tally;
  total: number;
  icon: "bot" | "terminal";
  openAllLabel: string;
  onOpenAll?: () => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: JSX.Element;
  desktop?: Props["desktopSubagents"];
  presented?: boolean;
}) {
  const summary = () =>
    SUMMARY.filter((state) => props.tally[state] > 0)
      .map((state) =>
        t(`chat.sessionDetails.tally.${state}`, { count: String(props.tally[state]) }),
      )
      .join(" · ");
  const heading = () => (
    <>
      <span class="chat-details__caption-title">{props.title}</span>
      <span class="chat-details__tally-summary">{summary()}</span>
      <Icon name="chevronDown" />
      <Show when={props.total > 0}>
        <span class="chat-details__tally" role="img" aria-label={`${props.title}: ${summary()}`}>
          <For each={SEGMENTS.filter((state) => props.tally[state] > 0)}>
            {(state) => (
              <span
                class="chat-details__tally-segment"
                data-state={state}
                style={{ "flex-grow": props.tally[state] }}
              />
            )}
          </For>
        </span>
      </Show>
    </>
  );
  const content = () => (
    <>
      {props.children}
      <BackgroundMore
        hidden={props.total - PREVIEW_ROWS}
        expanded={props.expanded}
        onExpandedChange={props.onExpandedChange}
      />
      <Show when={props.onOpenAll}>
        <button
          type="button"
          class="chat-details__row chat-details__navigation"
          onClick={() => props.onOpenAll?.()}
        >
          <Icon name={props.icon} />
          <span>{props.openAllLabel}</span>
          <Icon name="chevronRight" />
        </button>
      </Show>
    </>
  );
  return (
    <Show
      when={props.desktop}
      fallback={
        <details class="chat-details__group" data-details-group={props.kind} open>
          <summary class="chat-details__caption chat-details__caption--tally">{heading()}</summary>
          {content()}
        </details>
      }
    >
      {(desktop) => (
        <DesktopBackgroundGroup
          kind={props.kind}
          desktop={desktop()}
          presented={props.presented ?? false}
          heading={heading()}
        >
          {content()}
        </DesktopBackgroundGroup>
      )}
    </Show>
  );
}

/** Keep the native fallback's tally/actions while giving desktop the same reveal. */
function DesktopBackgroundGroup(props: {
  kind: "subagents" | "processes";
  desktop: NonNullable<Props["desktopSubagents"]>;
  presented: boolean;
  heading: JSX.Element;
  children: JSX.Element;
}) {
  const reveal = createDetailsDesktopReveal(() => [props.desktop.expanded, props.presented]);
  return (
    <details ref={reveal.details} class="chat-details__group" data-details-group={props.kind}>
      <summary
        class="chat-details__caption chat-details__caption--tally"
        aria-expanded={props.desktop.expanded ? "true" : "false"}
        onClick={(event) => {
          event.preventDefault();
          if (props.presented) {
            reveal.prepareClick(event);
            props.desktop.onExpandedChange(!props.desktop.expanded);
          }
        }}
      >
        {props.heading}
      </summary>
      <div
        ref={reveal.body}
        class="chat-details-desktop-section__body"
        inert={!props.desktop.expanded || !props.presented}
        aria-hidden={props.desktop.expanded ? "false" : "true"}
      >
        <div ref={reveal.content}>{props.children}</div>
      </div>
    </details>
  );
}

/** The subagents and background processes this session started, as two groups. */
export function ChatDetailsBackground(
  props: Props,
  processes: () => ProcessesPanelData | undefined,
) {
  const [subagentsExpanded, setSubagentsExpanded] = createSignal(false);
  const activityReady = createMemo(() =>
    Boolean(hasLoadedDetailsSubagents(props.details) || props.details.subagentSessionsUnavailable),
  );
  const roster = createMemo(() => listSubagents(props.details).filter((row) => row.listed));
  const subagents = createMemo(() =>
    roster().toSorted((a, b) => ORDER[subagentState(a)] - ORDER[subagentState(b)]),
  );
  const liveSummary = createMemo(() =>
    props.desktopSubagents && activityReady()
      ? projectDetailsSubagents(props.details.subagentSessionsUnavailable ? [] : roster())
      : undefined,
  );
  const summary = createMemo(() => {
    const cached = props.desktopSubagents ? props.details.cachedDetails?.subagents : undefined;
    return liveSummary() ?? (cached && detailsSubagentCollection(cached));
  });
  const cachedActivity = createMemo(() =>
    !activityReady() && props.desktopSubagents ? summary()?.rows : undefined,
  );
  const desktopSubagents = createMemo<ChatDetailsSubagentsProps | undefined>(() => {
    const presentation = props.desktopSubagents;
    const snapshot = props.details;
    const openChild = snapshot.onOpenSubagent;
    const openCollection = snapshot.onOpenSubagents;
    if (!presentation || !openChild || !openCollection) {
      return undefined;
    }
    const current = () => props.presented && props.details === snapshot && activityReady();
    return {
      rows: roster(),
      presentation: summary(),
      mobile: false,
      workingLabel: presentation.workingLabel,
      onOpenSubagent: (key) => {
        if (current()) {
          openChild(key);
        }
      },
      onOpenSubagents: () => {
        if (current()) {
          openCollection();
        }
      },
    };
  });
  const subagentTally = createMemo(() => {
    const counts = { running: 0, queued: 0, failed: 0, stopped: 0, done: 0 };
    if (cachedActivity()) {
      for (const entry of summary()?.counts ?? []) {
        counts[entry.status === "waiting" ? "running" : entry.status] += entry.count;
      }
    } else {
      for (const row of subagents()) {
        counts[subagentState(row)] += 1;
      }
    }
    return counts;
  });
  const openSubagents = () => {
    if (props.presented && !cachedActivity()) {
      props.details.onOpenSubagents?.();
    }
  };
  return (
    <>
      <Show when={liveSummary()} keyed>
        {(value) => {
          onSettled(() => props.details.onDetailsSnapshot?.({ subagents: value }));
          return null;
        }}
      </Show>
      <Show when={subagents().length > 0 || (summary()?.total ?? 0) > 0}>
        <Show
          when={desktopSubagents()}
          fallback={
            <BackgroundGroup
              desktop={props.desktopSubagents}
              presented={props.presented}
              kind="subagents"
              title={t("chat.sessionDetails.subagents")}
              tally={subagentTally()}
              total={summary()?.total ?? subagents().length}
              icon="bot"
              openAllLabel={t("chat.sessionDetails.allSubagents")}
              onOpenAll={props.details.onOpenSubagents ? openSubagents : undefined}
              expanded={subagentsExpanded()}
              onExpandedChange={setSubagentsExpanded}
            >
              {props.presented && (
                <ChatSubagentActivity
                  rows={subagents()}
                  presentation={cachedActivity()}
                  limit={subagentsExpanded() ? undefined : PREVIEW_ROWS}
                  onOpenSubagent={props.details.onOpenSubagent}
                  onOpenSession={props.details.onSessionSelect}
                />
              )}
            </BackgroundGroup>
          }
        >
          {(data) => (
            <ChatDetailsDesktopSection
              section="subagents"
              title={t("chat.sessionDetails.subagents")}
              expanded={props.desktopSubagents!.expanded}
              presented={props.presented}
              onExpandedChange={props.desktopSubagents!.onExpandedChange}
              metadata={
                <Show when={!props.desktopSubagents!.expanded}>
                  <ChatDetailsSubagents {...data()} collapsed />
                </Show>
              }
            >
              <ChatDetailsSubagents {...data()} />
            </ChatDetailsDesktopSection>
          )}
        </Show>
      </Show>
      <Show when={props.showProcesses !== false}>
        <DetailsProcesses
          details={props.details}
          presented={props.presented}
          processes={processes}
        />
      </Show>
    </>
  );
}

/** Render the native host's shared process observation. */
function DetailsProcesses(
  props: Pick<Props, "details" | "presented"> & {
    processes: () => ProcessesPanelData | undefined;
  },
) {
  const presentation = createProcessesPresentation(() => props.processes(), true);
  const processRows = createDetailsProcessesPresentation(
    () => props.processes()?.snapshot.rows ?? [],
  );
  const visibleRows = createMemo(() => processRows().slice(0, 2));
  const hidden = () => processRows().length - visibleRows().length;
  const processError = () =>
    props.processes()?.snapshot.errorKind !== "read" ? props.processes()?.snapshot.error : null;
  const openProcesses = (instanceId?: string) => {
    if (props.presented) {
      props.details.onOpenProcesses?.(instanceId);
    }
  };
  const Content = (contentProps: { retry: () => void }) => (
    <Show when={processRows().length > 0 || processError()}>
      <details class="chat-details__group" data-details-group="processes" open>
        <summary class="chat-details__caption">
          <span class="chat-details__caption-title">{t("chat.sessionDetails.processes")}</span>
          <Icon name="chevronDown" />
        </summary>
        <Show when={processError()}>
          <div class="chat-summary__automation-error">
            <span role="alert">{processError()}</span>
            <button
              type="button"
              class="chip chat-summary__automation-retry"
              onClick={() => contentProps.retry()}
            >
              {t("common.retry")}
            </button>
          </div>
        </Show>
        <Show when={processRows().length > 0}>
          <div role="list" aria-label={t("chat.sessionDetails.processes")}>
            <For each={visibleRows()} keyed={(row) => row.instanceId}>
              {(row) => (
                <ChatDetailsProcessRow
                  row={row()}
                  presentation={presentation}
                  disabled={!props.presented}
                  hoverDescription
                  onOpen={props.details.onOpenProcesses ? openProcesses : undefined}
                />
              )}
            </For>
          </div>
          <Show when={props.details.onOpenProcesses}>
            <button
              class="chat-details-processes__view-all"
              type="button"
              disabled={!props.presented}
              onClick={() => openProcesses()}
            >
              {hidden() > 0
                ? t("chat.sessionDetails.showMore", { count: String(hidden()) })
                : t("chat.processesPanel.viewAll")}
            </button>
          </Show>
        </Show>
      </details>
    </Show>
  );
  const retry = () => void props.processes()?.refresh();
  return (
    <Errored
      fallback={(_error, reset) => (
        <Content
          retry={() => {
            retry();
            reset();
          }}
        />
      )}
    >
      <Loading on={presentation.scope()} fallback={<Content retry={retry} />}>
        {(latest(presentation.read), null)}
        <Content retry={retry} />
      </Loading>
    </Errored>
  );
}
