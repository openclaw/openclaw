import type { SkillWorkshopChange } from "@openclaw/gateway-protocol";
import { createMemo, For, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { MarkdownHtml } from "../../components/solid/markdown-html.tsx";
import { SettingsEmpty, SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { undoMutationFor } from "./api.ts";
import {
  latestChanges,
  MutationButton,
  renderUses,
  WorkshopChangeText,
  UNUSED_ARCHIVE_DAYS,
  unusedDays,
  type WorkshopView,
  type WorkshopViewer,
} from "./view-shared.tsx";

export function Detail(props: { view: WorkshopView }) {
  const viewer = () => props.view().viewer!;
  const target = () => viewer().target;
  const snapshot = () => props.view().snapshot!;
  const skill = () => snapshot().list.skills.find((entry) => entry.name === target().name);
  const versions = () =>
    snapshot().list.archived.find((entry) => entry.name === target().name)?.versions ?? [];
  const history = () => snapshot().changes.filter((change) => change.skillName === target().name);
  const files = () => {
    const current = viewer();
    return target().versionId && current.status === "ready"
      ? current.result.files
      : (skill()?.files ??
          (current.status === "ready" ? current.result.files : [target().filePath]));
  };
  const supportFiles = createMemo(() => files().filter((file) => file !== "SKILL.md"));
  const description = () => {
    const current = viewer();
    const own =
      current.status === "ready" && current.target.filePath === "SKILL.md"
        ? splitFrontmatter(current.result.content).description
        : undefined;
    return target().versionId ? own : skill()?.description || own;
  };
  const meta = () => {
    const current = skill();
    const created = history().findLast((entry) => entry.action === "create");
    return [
      current ? renderUses(current.useCount) : null,
      current?.lastUsedAtMs
        ? t("skillWorkshop.viewer.lastUsed", {
            time: formatRelativeTimestamp(current.lastUsedAtMs),
          })
        : null,
      created
        ? t("skillWorkshop.viewer.createdBy", {
            actor: t(`skillWorkshop.changes.actors.${created.actor}`).toLowerCase(),
          })
        : null,
      versions().length > 0
        ? versions().length === 1
          ? t("skillWorkshop.viewer.versionsOne")
          : t("skillWorkshop.viewer.versions", { count: String(versions().length) })
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };
  const unused = () => {
    const current = skill();
    return current
      ? unusedDays(current, latestChanges(snapshot().changes).get(target().name), props.view().mode)
      : null;
  };
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
    <>
      <header class="sw-detail__head">
        <div class="sw-detail__identity">
          <h2 class="sw-detail__title">{target().name}</h2>
          {description() && <p class="sw-detail__desc">{description()}</p>}
          {meta() && <p class="sw-detail__meta">{meta()}</p>}
        </div>
        <div class="sw-detail__actions">
          <MutationButton
            view={props.view}
            label={t(skill() ? "skillWorkshop.viewer.archive" : "skillWorkshop.viewer.restore")}
            title={skill() ? t("skillWorkshop.viewer.archiveTitle") : undefined}
            mutation={{
              method: skill() ? "skills.workshop.archive" : "skills.workshop.restore",
              name: target().name,
            }}
            actionKey={`${skill() ? "archive" : "restore"}:${target().name}`}
            variant={skill() ? "danger" : "default"}
          />
        </div>
      </header>
      {!skill() ? (
        <div class="sw-notice">{t("skillWorkshop.viewer.archivedNotice")}</div>
      ) : unused() !== null ? (
        <div class="sw-notice sw-notice--warning">
          {t("skillWorkshop.unused.notice", {
            days: String(unused()),
            limit: String(UNUSED_ARCHIVE_DAYS),
          })}
        </div>
      ) : null}
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
        {props.view().tab === "history" ? (
          <History view={props.view} />
        ) : props.view().tab === "files" ? (
          <Files view={props.view} files={supportFiles()} />
        ) : (
          <Instructions view={props.view} />
        )}
      </div>
    </>
  );
}

function LoadState(props: { viewer: WorkshopViewer }) {
  return (
    <>
      {props.viewer.status === "loading" ? (
        <SettingsEmpty message={t("skillWorkshop.viewer.loading")} />
      ) : props.viewer.status === "error" ? (
        <div role="alert">
          <SettingsStatus kind="danger" label={props.viewer.error} carapace />
        </div>
      ) : null}
    </>
  );
}

function Instructions(props: { view: WorkshopView }) {
  const ready = () => {
    const viewer = props.view().viewer;
    return viewer?.status === "ready" ? viewer : null;
  };
  return (
    <Show when={ready()} fallback={<LoadState viewer={props.view().viewer!} />}>
      {(viewer) => {
        const versions = () =>
          props.view().snapshot?.list.archived.find((entry) => entry.name === viewer().target.name)
            ?.versions ?? [];
        const version = () => versions().find((entry) => entry.id === viewer().target.versionId);
        const showVersionBar = () =>
          viewer().target.versionId !== undefined &&
          (viewer().current !== undefined || versions()[0]?.id !== viewer().target.versionId);
        return (
          <>
            {showVersionBar() && (
              <div class="sw-version-bar">
                <span>
                  {t("skillWorkshop.viewer.viewingVersion", {
                    time: version()
                      ? formatRelativeTimestamp(version()!.createdAtMs)
                      : (viewer().target.versionId ?? ""),
                  })}
                  {viewer().current !== undefined && <> · {t("skillWorkshop.viewer.diffHint")}</>}
                </span>
                <span class="sw-version-bar__actions">
                  {viewer().current !== undefined && (
                    <button
                      type="button"
                      class="sw-link-button"
                      onClick={() =>
                        props.view().onOpen({ name: viewer().target.name, filePath: "SKILL.md" })
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
              <Diff current={viewer().current!} version={viewer().result.content} />
            ) : (
              <MarkdownHtml
                class="sw-markdown chat-text"
                markdown={splitFrontmatter(viewer().result.content).body}
                options={{ mode: "document" }}
              />
            )}
          </>
        );
      }}
    </Show>
  );
}

function Files(props: { view: WorkshopView; files: string[] }) {
  const viewer = () => props.view().viewer!;
  const active = () =>
    props.files.includes(viewer().target.filePath) ? viewer().target.filePath : null;
  return (
    <Show
      when={props.files.length > 0}
      fallback={<SettingsEmpty message={t("skillWorkshop.viewer.noFiles")} />}
    >
      <div class="sw-files">
        <ul class="sw-files__list">
          <For each={props.files} keyed>
            {(file) => (
              <li>
                <button
                  type="button"
                  class={["sw-files__item", { "sw-files__item--active": file === active() }]}
                  aria-current={file === active() ? "true" : undefined}
                  onClick={() => props.view().onOpen({ ...viewer().target, filePath: file })}
                >
                  <span aria-hidden="true">
                    <Icon name="fileText" />
                  </span>
                  <span>{file}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
        <div class="sw-files__content">
          {active() === null ? (
            <SettingsEmpty message={t("skillWorkshop.viewer.pickFile")} />
          ) : (
            <FileContent viewer={viewer()} />
          )}
        </div>
      </div>
    </Show>
  );
}
function FileContent(props: { viewer: WorkshopViewer }) {
  return (
    <>
      {props.viewer.status === "ready" ? (
        props.viewer.target.filePath.endsWith(".md") ? (
          <MarkdownHtml
            class="sw-markdown chat-text"
            markdown={props.viewer.result.content}
            options={{ mode: "document" }}
          />
        ) : (
          <pre class="sw-file">{props.viewer.result.content}</pre>
        )
      ) : (
        <LoadState viewer={props.viewer} />
      )}
    </>
  );
}

type SavedVersion = { id: string; action: SkillWorkshopChange["action"]; createdAtMs: number };
function VersionLink(props: {
  name: string;
  versionId: string;
  live: boolean;
  view: WorkshopView;
}) {
  return (
    <button
      type="button"
      class="sw-link-button"
      title={props.live ? t("skillWorkshop.changes.compareTitle") : undefined}
      onClick={() => {
        props.view().onTab("instructions");
        props.view().onOpen({ name: props.name, filePath: "SKILL.md", versionId: props.versionId });
      }}
    >
      {t(props.live ? "skillWorkshop.changes.compare" : "skillWorkshop.changes.view")}
    </button>
  );
}
function History(props: { view: WorkshopView }) {
  const name = () => props.view().viewer!.target.name;
  const snapshot = () => props.view().snapshot!;
  const history = createMemo(() =>
    snapshot().changes.filter((change) => change.skillName === name()),
  );
  const versions = () =>
    snapshot().list.archived.find((entry) => entry.name === name())?.versions ?? [];
  const retained = () => new Set(versions().map((version) => version.id));
  const older = createMemo(() => {
    const listed = new Set(
      history()
        .map((change) => change.versionId)
        .filter(Boolean),
    );
    return versions().filter((version) => !listed.has(version.id));
  });
  const live = () => snapshot().list.skills.some((skill) => skill.name === name());
  return (
    <Show
      when={history().length > 0 || older().length > 0}
      fallback={<SettingsEmpty message={t("skillWorkshop.changes.empty")} />}
    >
      <ol class="sw-timeline">
        <For each={history()} keyed={(change) => change.id}>
          {(change, index) => {
            const undo = () => undoMutationFor(change(), snapshot().list);
            return (
              <li class={["sw-timeline__item", { "sw-timeline__item--latest": index() === 0 }]}>
                <span class="sw-timeline__dot" aria-hidden="true" />
                <div class="sw-timeline__text">
                  <WorkshopChangeText change={change()} prefix="sw-timeline__" />
                </div>
                <div class="sw-timeline__actions">
                  {change().versionId && retained().has(change().versionId!) && (
                    <VersionLink
                      name={name()}
                      versionId={change().versionId!}
                      live={live()}
                      view={props.view}
                    />
                  )}
                  <Show when={undo()}>
                    {(mutation) => (
                      <>
                        {(index() === 0 || mutation().method === "skills.workshop.restore") && (
                          <MutationButton
                            view={props.view}
                            label={t(
                              index() === 0
                                ? "skillWorkshop.changes.undo"
                                : "skillWorkshop.changes.restoreBefore",
                            )}
                            title={t("skillWorkshop.changes.undoTitle", { name: name() })}
                            mutation={mutation()}
                            actionKey={`undo:${change().id}`}
                            variant="link"
                          />
                        )}
                      </>
                    )}
                  </Show>
                </div>
              </li>
            );
          }}
        </For>
        <For each={older()} keyed={(version: SavedVersion) => version.id}>
          {(version) => (
            <li class="sw-timeline__item">
              <span class="sw-timeline__dot" aria-hidden="true" />
              <div class="sw-timeline__text">
                <span class="sw-timeline__who">
                  {t("skillWorkshop.changes.savedBefore", {
                    action: t(`skillWorkshop.changes.actions.${version().action}`),
                  })}
                </span>
                <span class="sw-timeline__when">
                  {formatRelativeTimestamp(version().createdAtMs)}
                </span>
              </div>
              <div class="sw-timeline__actions">
                <VersionLink
                  name={name()}
                  versionId={version().id}
                  live={live()}
                  view={props.view}
                />
                <MutationButton
                  view={props.view}
                  label={t("skillWorkshop.viewer.restore")}
                  mutation={{
                    method: "skills.workshop.restore",
                    name: name(),
                    versionId: version().id,
                  }}
                  actionKey={`restore:${name()}:${version().id}`}
                  variant="link"
                />
              </div>
            </li>
          )}
        </For>
      </ol>
    </Show>
  );
}

function Diff(props: { current: string; version: string }) {
  const lines = createMemo(() => diffLines(props.version, props.current));
  return (
    <Show
      when={lines() && !lines()!.every((line) => line.kind === "same")}
      fallback={
        <>
          <p class="sw-diff__same">
            {t(
              lines() === null
                ? "skillWorkshop.viewer.diffTooLarge"
                : "skillWorkshop.viewer.noDiff",
            )}
          </p>
          <MarkdownHtml
            class="sw-markdown chat-text"
            markdown={splitFrontmatter(props.version).body}
            options={{ mode: "document" }}
          />
        </>
      }
    >
      <div class="sw-diff">
        <div class="sw-diff__legend">
          <span class="sw-diff__key sw-diff__key--remove">
            {t("skillWorkshop.viewer.diffVersion")}
          </span>
          <span class="sw-diff__key sw-diff__key--add">
            {t("skillWorkshop.viewer.diffCurrent")}
          </span>
        </div>
        <div class="sw-diff__lines" role="table">
          <For each={lines() ?? []}>
            {(line) => (
              <div class={`sw-diff__line sw-diff__line--${line.kind}`} role="row">
                <span class="sw-diff__sign" aria-hidden="true">
                  {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : ""}
                </span>
                <span class="sw-diff__text">{line.text}</span>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
/** SKILL.md frontmatter is shown as the header; the body renders as markdown. */
function splitFrontmatter(content: string): { description?: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) {
    return { body: content };
  }
  const description = /^description:\s*(.*)$/m.exec(match[1] ?? "")?.[1]?.trim();
  return { description, body: content.slice(match[0].length).replace(/^\s*\n/, "") };
}

type DiffLine = { kind: "same" | "add" | "remove"; text: string };

// Skills cap at 200 KB, which can mean tens of thousands of lines; the LCS table is quadratic.
const MAX_DIFF_CELLS = 2_000_000;

/** Line diff (LCS over the lines between the common prefix and suffix); null when too large. */
function diffLines(before: string, after: string): DiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if ((midA.length + 1) * (midB.length + 1) > MAX_DIFF_CELLS) {
    return null;
  }
  const table = Array.from({ length: midA.length + 1 }, () =>
    Array.from({ length: midB.length + 1 }, () => 0),
  );
  for (let i = midA.length - 1; i >= 0; i -= 1) {
    for (let j = midB.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        midA[i] === midB[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const lines: DiffLine[] = a.slice(0, start).map((text) => ({ kind: "same", text }));
  let i = 0;
  let j = 0;
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      lines.push({ kind: "same", text: midA[i]! });
      i += 1;
      j += 1;
    } else if (i < midA.length && (j >= midB.length || table[i + 1]![j]! >= table[i]![j + 1]!)) {
      lines.push({ kind: "remove", text: midA[i]! });
      i += 1;
    } else {
      lines.push({ kind: "add", text: midB[j]! });
      j += 1;
    }
  }
  for (const text of a.slice(endA)) {
    lines.push({ kind: "same", text });
  }
  return lines;
}
