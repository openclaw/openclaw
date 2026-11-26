import type { JSX } from "@solidjs/web";
import { createMemo, createUniqueId, Errored, For, Loading, Show } from "solid-js";
import { parseFrontmatterBlock } from "../../../../packages/markdown-core/src/frontmatter.js";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { MarkdownHtml } from "../../components/solid/markdown-html.tsx";
import { SettingsEmpty } from "../../components/solid/settings-ui.tsx";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { renderPluginDetailShell as PluginDetailShell } from "../plugins/detail-shell.tsx";
import { undoMutationFor } from "./api.ts";
import { Diff, LoadState, splitFrontmatter } from "./diff.tsx";
import { History, VersionLink } from "./history.tsx";
import {
  MutationButton,
  UNUSED_ARCHIVE_DAYS,
  unusedDays,
  type WorkshopPage,
  type WorkshopView,
  type WorkshopReads,
} from "./view-shared.tsx";

/** The skill and draft pages share the detail model: breadcrumb, header, content and facts. */
export function WorkshopDetailShell(props: {
  /** A skill page has one header action; a draft page has Discard and Apply. */
  kind: "skill" | "draft";
  view: WorkshopView;
  page: WorkshopPage;
  name: string;
  summary?: string;
  byline?: JSX.Element;
  actions: JSX.Element;
  panel: JSX.Element;
  facts: JSX.Element;
}) {
  const id = `sw-detail-${createUniqueId()}`;
  return (
    <div class={["sw-detail", `sw-detail--${props.kind}`]}>
      <PluginDetailShell
        id={id}
        rail
        name={props.name}
        summary={props.summary}
        backHref={props.view().context.router.getState().location.pathname}
        backLabel={t("tabs.skillWorkshop")}
        onBack={() => props.page.close()}
        icon={
          <span class="sw-tile sw-tile--page">
            <Icon name="wandSparkles" />
          </span>
        }
        identity={
          props.byline ? (
            <div class="plugin-catalog-detail__publisher">
              <span class="sw-byline">{props.byline}</span>
            </div>
          ) : undefined
        }
        titleAction={props.actions}
        panel={props.panel}
        sidebar={<dl class="plugin-metadata__facts--rail sw-facts">{props.facts}</dl>}
      />
    </div>
  );
}

export function Detail(props: {
  view: WorkshopView;
  reads: WorkshopReads;
  page: WorkshopPage;
  errors: JSX.Element;
}) {
  const viewer = () => props.view().viewer!;
  const target = () => viewer().target;
  const snapshot = () => props.view().snapshot!;
  const skill = createMemo(() =>
    snapshot().list.skills.find((entry) => entry.name === target().name),
  );
  const versions = createMemo(
    () => snapshot().list.archived.find((entry) => entry.name === target().name)?.versions ?? [],
  );
  // An older list can omit the open live skill. Restore belongs to a selected archived copy.
  const canRestore = () => {
    const { target: selected, result, current } = viewer();
    return (
      selected.versionId !== undefined &&
      result !== undefined &&
      current === undefined &&
      versions().some((version) => version.id === selected.versionId)
    );
  };
  const history = createMemo(() =>
    snapshot().changes.filter((change) => change.skillName === target().name),
  );
  const files = () => {
    const current = viewer();
    return target().versionId && current.result
      ? current.result.files
      : (skill()?.files ?? (current.result ? current.result.files : [target().filePath]));
  };
  const supportFiles = createMemo(() => files().filter((file) => file !== "SKILL.md"));
  const description = createMemo(() => {
    const catalogDescription = target().versionId ? undefined : skill()?.description;
    if (catalogDescription) {
      return catalogDescription;
    }
    const current = viewer();
    return current.result && current.target.filePath === "SKILL.md"
      ? parseFrontmatterBlock(current.result.content).description
      : undefined;
  });
  const byline = () => {
    const created = history().findLast((entry) => entry.action === "create");
    if (created) {
      return t("skillWorkshop.viewer.createdBy", {
        actor: t(`skillWorkshop.changes.actors.${created.actor}`),
      });
    }
    const archivedAt = skill() ? undefined : versions()[0]?.createdAtMs;
    return archivedAt
      ? t("skillWorkshop.skills.archivedAgo", { time: formatRelativeTimestamp(archivedAt) })
      : undefined;
  };
  const unused = () => {
    const current = skill();
    return current ? unusedDays(current, history()[0], props.view().mode) : null;
  };
  const latest = () => history()[0];
  const tabs = () => {
    const listed = new Set(
      history()
        .map((change) => change.versionId)
        .filter(Boolean),
    );
    return [
      { value: "instructions", label: t("skillWorkshop.tabs.instructions"), count: 0 },
      { value: "files", label: t("skillWorkshop.tabs.files"), count: supportFiles().length },
      {
        value: "history",
        label: t("skillWorkshop.tabs.history"),
        count: history().length + versions().filter((version) => !listed.has(version.id)).length,
      },
    ] as const;
  };
  return (
    <WorkshopDetailShell
      kind="skill"
      view={props.view}
      page={props.page}
      name={target().name}
      summary={description()}
      byline={byline()}
      actions={
        <Show when={skill() || canRestore()}>
          <MutationButton
            view={props.view}
            label={t(skill() ? "skillWorkshop.viewer.archive" : "skillWorkshop.viewer.restore")}
            title={skill() ? t("skillWorkshop.viewer.archiveTitle") : undefined}
            mutation={{
              method: skill() ? "skills.workshop.archive" : "skills.workshop.restore",
              name: target().name,
            }}
            actionKey={`${skill() ? "archive" : "restore"}:${target().name}`}
            icon={skill() ? "archive" : "archiveRestore"}
          />
        </Show>
      }
      panel={
        <>
          {props.errors}
          {!skill() ? (
            <div class="sw-notice">{t("skillWorkshop.viewer.archivedNotice")}</div>
          ) : unused() !== null ? (
            <InlineAlert tone="warning" class="sw-detail-alert">
              {t("skillWorkshop.unused.notice", {
                days: String(unused()),
                limit: String(UNUSED_ARCHIVE_DAYS),
              })}
            </InlineAlert>
          ) : null}
          <div class="sw-section">
            <nav class="sw-tabs" aria-label={t("skillWorkshop.tabs.aria")}>
              <For each={tabs()} keyed={(tab) => tab.value}>
                {(tab) => (
                  <button
                    type="button"
                    class={["sw-tab", { "sw-tab--active": props.view().tab === tab().value }]}
                    aria-pressed={props.view().tab === tab().value ? "true" : "false"}
                    onClick={() => props.view().onTab(tab().value)}
                  >
                    {tab().label}
                    {tab().count > 0 && (
                      <>
                        {" "}
                        <span class="settings-count">{tab().count}</span>
                      </>
                    )}
                  </button>
                )}
              </For>
            </nav>
            <div class="sw-detail__body">
              {/* Boolean conditions keep each tab mounted across owner updates. */}
              <Show
                when={props.view().tab === "history"}
                fallback={
                  <Show
                    when={props.view().tab === "files"}
                    fallback={<Instructions view={props.view} reads={props.reads} />}
                  >
                    <Files view={props.view} reads={props.reads} files={supportFiles()} />
                  </Show>
                }
              >
                <History view={props.view} reads={props.reads} />
              </Show>
            </div>
          </div>
        </>
      }
      facts={
        <>
          <Show when={latest()}>
            {(change) => {
              const undo = () => undoMutationFor(change(), snapshot().list);
              const retained = () =>
                change().versionId !== undefined &&
                versions().some((version) => version.id === change().versionId);
              return (
                <div class="sw-facts__change">
                  <dt>
                    {t(`skillWorkshop.changes.actors.${change().actor}`)}{" "}
                    {t(`skillWorkshop.changes.actions.${change().action}`)}
                  </dt>
                  <dd>
                    <span>{formatRelativeTimestamp(change().createdAtMs)}</span>
                  </dd>
                  <Show when={retained() || undo()}>
                    <dd class="sw-facts__actions">
                      <Show when={retained()}>
                        <VersionLink
                          name={target().name}
                          versionId={change().versionId!}
                          live={Boolean(skill())}
                          view={props.view}
                        />
                      </Show>
                      <Show when={undo()}>
                        {(mutation) => (
                          <MutationButton
                            view={props.view}
                            label={t("skillWorkshop.changes.undo")}
                            title={t("skillWorkshop.changes.undoTitle", { name: target().name })}
                            mutation={mutation()}
                            actionKey={`undo:${change().id}`}
                          />
                        )}
                      </Show>
                    </dd>
                  </Show>
                </div>
              );
            }}
          </Show>
          <Show when={skill()}>
            {(current) => (
              <>
                <div>
                  <dt>{t("skillWorkshop.viewer.usesLabel")}</dt>
                  <dd>
                    {current().useCount
                      ? String(current().useCount)
                      : t("skillWorkshop.skills.noUses")}
                  </dd>
                </div>
                <Show when={current().lastUsedAtMs}>
                  {(time) => (
                    <div>
                      <dt>{t("skillWorkshop.viewer.lastUsedLabel")}</dt>
                      <dd>{formatRelativeTimestamp(time())}</dd>
                    </div>
                  )}
                </Show>
              </>
            )}
          </Show>
          <Show when={versions().length > 0}>
            <div>
              <dt>{t("skillWorkshop.viewer.versionsLabel")}</dt>
              <dd>{String(versions().length)}</dd>
            </div>
          </Show>
        </>
      }
    />
  );
}

function Instructions(props: { view: WorkshopView; reads: WorkshopReads }) {
  return (
    <Loading on={props.reads.viewerRequest()} fallback={<LoadState />}>
      <Errored fallback={(error) => <LoadState error={error()} />}>
        <Show when={props.reads.viewer()}>
          {(viewer) => {
            const versions = () =>
              props
                .view()
                .snapshot?.list.archived.find((entry) => entry.name === viewer().target.name)
                ?.versions ?? [];
            const version = () =>
              versions().find((entry) => entry.id === viewer().target.versionId);
            const showVersionBar = () =>
              viewer().target.versionId !== undefined &&
              (viewer().current !== undefined || versions()[0]?.id !== viewer().target.versionId);
            return (
              <>
                {showVersionBar() && (
                  <div class="sw-version-bar">
                    <span>
                      <strong>
                        {t("skillWorkshop.viewer.viewingVersion", {
                          time: version()
                            ? formatRelativeTimestamp(version()!.createdAtMs)
                            : (viewer().target.versionId ?? ""),
                        })}
                      </strong>
                      {viewer().current !== undefined && (
                        <> · {t("skillWorkshop.viewer.diffHint")}</>
                      )}
                    </span>
                    <span class="sw-version-bar__actions">
                      {viewer().current !== undefined && (
                        <button
                          type="button"
                          class="btn btn--sm oc-action"
                          onClick={() =>
                            props
                              .view()
                              .onOpen({ name: viewer().target.name, filePath: "SKILL.md" })
                          }
                        >
                          {t("skillWorkshop.viewer.backToCurrent")}
                        </button>
                      )}
                      <MutationButton
                        view={props.view}
                        label={t(
                          viewer().current !== undefined
                            ? "skillWorkshop.viewer.restoreVersion"
                            : "skillWorkshop.viewer.restore",
                        )}
                        mutation={{
                          method: "skills.workshop.restore",
                          name: viewer().target.name,
                          versionId: viewer().target.versionId,
                        }}
                        actionKey={`restore:${viewer().target.name}:${viewer().target.versionId}`}
                      />
                    </span>
                  </div>
                )}
                {viewer().current !== undefined ? (
                  <Diff
                    before={viewer().result.content}
                    after={viewer().current!}
                    beforeLabel={t("skillWorkshop.viewer.diffVersion")}
                    afterLabel={t("skillWorkshop.viewer.diffCurrent")}
                  />
                ) : (
                  <div class="sw-well">
                    <MarkdownHtml
                      class="sw-markdown chat-text"
                      markdown={splitFrontmatter(viewer().result.content).body}
                      options={{ mode: "document" }}
                    />
                  </div>
                )}
              </>
            );
          }}
        </Show>
      </Errored>
    </Loading>
  );
}

/** Support files grouped by their folder; root files come first without a label. */
function fileGroups(files: readonly string[]) {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const slash = file.lastIndexOf("/");
    const folder = slash === -1 ? "" : file.slice(0, slash);
    groups.set(folder, [...(groups.get(folder) ?? []), file]);
  }
  return [...groups].map(([folder, entries]) => ({ folder, entries }));
}

function Files(props: { view: WorkshopView; reads: WorkshopReads; files: string[] }) {
  const viewer = () => props.view().viewer!;
  const active = () =>
    props.files.includes(viewer().target.filePath) ? viewer().target.filePath : null;
  return (
    <Show
      when={props.files.length > 0}
      fallback={<SettingsEmpty message={t("skillWorkshop.viewer.noFiles")} />}
    >
      <div class="sw-files">
        <div class="sw-files__list">
          <For each={fileGroups(props.files)} keyed={(group) => group.folder}>
            {(group) => (
              <>
                {group().folder && <span class="sw-files__folder">{group().folder}</span>}
                <ul>
                  <For each={group().entries} keyed>
                    {(file) => (
                      <li>
                        <button
                          type="button"
                          class={[
                            "sw-files__item",
                            { "sw-files__item--active": file === active() },
                          ]}
                          aria-current={file === active() ? "true" : undefined}
                          title={file}
                          onClick={() =>
                            props.view().onOpen({ ...viewer().target, filePath: file })
                          }
                        >
                          {group().folder ? file.slice(group().folder.length + 1) : file}
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </>
            )}
          </For>
        </div>
        <div class="sw-files__content">
          {active() === null ? (
            <SettingsEmpty message={t("skillWorkshop.viewer.pickFile")} />
          ) : (
            <FileContent reads={props.reads} />
          )}
        </div>
      </div>
    </Show>
  );
}
function FileContent(props: { reads: WorkshopReads }) {
  return (
    <Loading on={props.reads.viewerRequest()} fallback={<LoadState />}>
      <Errored fallback={(error) => <LoadState error={error()} />}>
        <Show when={props.reads.viewer()}>
          {(viewer) => (
            <>
              {viewer().target.filePath.endsWith(".md") ? (
                <MarkdownHtml
                  class="sw-markdown chat-text"
                  markdown={viewer().result.content}
                  options={{ mode: "document" }}
                />
              ) : (
                <pre class="sw-file">{viewer().result.content}</pre>
              )}
            </>
          )}
        </Show>
      </Errored>
    </Loading>
  );
}
