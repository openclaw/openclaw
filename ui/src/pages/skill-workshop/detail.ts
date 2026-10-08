import type { SkillWorkshopChange } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { renderSettingsEmpty, renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { undoMutationFor, type WorkshopSnapshot } from "./api.ts";
import {
  latestChanges,
  renderMutationButton,
  renderUses,
  UNUSED_ARCHIVE_DAYS,
  unusedDays,
  type SkillWorkshopViewProps,
  type WorkshopViewer,
} from "./view-shared.ts";

/** SKILL.md frontmatter is shown as the header; the body renders as markdown. */
function splitFrontmatter(content: string): { description?: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) {
    return { body: content };
  }
  const description = /^description:\s*(.*)$/m.exec(match[1] ?? "")?.[1]?.trim();
  return { description, body: content.slice(match[0].length).replace(/^\s*\n/, "") };
}

export function renderDetail(
  viewer: WorkshopViewer,
  snapshot: WorkshopSnapshot,
  props: SkillWorkshopViewProps,
) {
  const { target } = viewer;
  const { list } = snapshot;
  const skill = list.skills.find((entry) => entry.name === target.name);
  const versions = list.archived.find((entry) => entry.name === target.name)?.versions ?? [];
  const history = snapshot.changes.filter((change) => change.skillName === target.name);
  const listedVersions = new Set(history.map((entry) => entry.versionId).filter(Boolean));
  const olderVersions = versions.filter((version) => !listedVersions.has(version.id)).length;
  // A saved version keeps its own file set; the live inventory describes today's copy.
  const files =
    target.versionId && viewer.status === "ready"
      ? viewer.result.files
      : (skill?.files ?? (viewer.status === "ready" ? viewer.result.files : [target.filePath]));
  const supportFiles = files.filter((file) => file !== "SKILL.md");
  const created = history.findLast((entry) => entry.action === "create");
  const change = latestChanges(snapshot.changes).get(target.name);
  const unused = skill ? unusedDays(skill, change, props.mode) : null;
  const description =
    skill?.description ||
    (viewer.status === "ready" && target.filePath === "SKILL.md"
      ? splitFrontmatter(viewer.result.content).description
      : undefined);
  const meta = [
    skill ? renderUses(skill.useCount) : null,
    skill?.lastUsedAtMs
      ? t("skillWorkshop.viewer.lastUsed", { time: formatRelativeTimestamp(skill.lastUsedAtMs) })
      : null,
    created
      ? t("skillWorkshop.viewer.createdBy", {
          actor: t(`skillWorkshop.changes.actors.${created.actor}`).toLowerCase(),
        })
      : null,
    versions.length > 0
      ? versions.length === 1
        ? t("skillWorkshop.viewer.versionsOne")
        : t("skillWorkshop.viewer.versions", { count: String(versions.length) })
      : null,
  ].filter(Boolean);
  return html`
    <header class="sw-detail__head">
      <div class="sw-detail__identity">
        <h2 class="sw-detail__title">${target.name}</h2>
        ${description ? html`<p class="sw-detail__desc">${description}</p>` : nothing}
        ${meta.length > 0 ? html`<p class="sw-detail__meta">${meta.join(" · ")}</p>` : nothing}
      </div>
      <div class="sw-detail__actions">
        ${
          skill
            ? renderMutationButton(props, {
                label: t("skillWorkshop.viewer.archive"),
                title: t("skillWorkshop.viewer.archiveTitle"),
                mutation: { method: "skills.workshop.archive", name: target.name },
                key: `archive:${target.name}`,
                variant: "danger",
              })
            : renderMutationButton(props, {
                label: t("skillWorkshop.viewer.restore"),
                mutation: { method: "skills.workshop.restore", name: target.name },
                key: `restore:${target.name}`,
              })
        }
      </div>
    </header>
    ${
      !skill
        ? html`<div class="sw-notice">${t("skillWorkshop.viewer.archivedNotice")}</div>`
        : unused !== null
          ? html`<div class="sw-notice sw-notice--warning">
              ${t("skillWorkshop.unused.notice", {
                days: String(unused),
                limit: String(UNUSED_ARCHIVE_DAYS),
              })}
            </div>`
          : nothing
    }
    <nav class="sw-tabs" aria-label=${t("skillWorkshop.tabs.aria")}>
      ${(
        [
          ["instructions", t("skillWorkshop.tabs.instructions"), null],
          ["files", t("skillWorkshop.tabs.files"), supportFiles.length],
          ["history", t("skillWorkshop.tabs.history"), history.length + olderVersions],
        ] as const
      ).map(
        ([tab, label, count]) => html`<button
          type="button"
          class="sw-tab ${props.tab === tab ? "sw-tab--active" : ""}"
          aria-pressed=${String(props.tab === tab)}
          @click=${() => props.onTab(tab)}
        >
          ${label}${count ? html` <span class="settings-count">${count}</span>` : nothing}
        </button>`,
      )}
    </nav>
    <div class="sw-detail__body">
      ${
        props.tab === "history"
          ? renderHistory(target.name, history, versions, snapshot, props)
          : props.tab === "files"
            ? renderFiles(viewer, supportFiles, props)
            : renderInstructions(viewer, props)
      }
    </div>
  `;
}

function renderLoadState(viewer: WorkshopViewer) {
  if (viewer.status === "loading") {
    return renderSettingsEmpty(t("skillWorkshop.viewer.loading"));
  }
  if (viewer.status === "error") {
    return html`<div role="alert">
      ${renderSettingsStatus({ kind: "danger", label: viewer.error, carapace: true })}
    </div>`;
  }
  return null;
}

function renderMarkdown(source: string) {
  return html`<div class="sw-markdown chat-text">
    ${unsafeHTML(toSanitizedMarkdownHtml(source, { mode: "document" }))}
  </div>`;
}

function renderInstructions(viewer: WorkshopViewer, props: SkillWorkshopViewProps) {
  const pending = renderLoadState(viewer);
  if (pending) {
    return pending;
  }
  if (viewer.status !== "ready") {
    return nothing;
  }
  const { target } = viewer;
  const { body } = splitFrontmatter(viewer.result.content);
  const versions =
    props.snapshot?.list.archived.find((entry) => entry.name === target.name)?.versions ?? [];
  const version = target.versionId
    ? versions.find((entry) => entry.id === target.versionId)
    : undefined;
  // An archived skill opens at its newest copy; the header's Restore already covers that one.
  const showVersionBar =
    target.versionId !== undefined &&
    (viewer.current !== undefined || versions[0]?.id !== target.versionId);
  return html`
    ${
      showVersionBar
        ? html`<div class="sw-version-bar">
            <span>
              ${t("skillWorkshop.viewer.viewingVersion", {
                time: version
                  ? formatRelativeTimestamp(version.createdAtMs)
                  : (target.versionId ?? ""),
              })}
              ${viewer.current !== undefined ? html`· ${t("skillWorkshop.viewer.diffHint")}` : nothing}
            </span>
            <span class="sw-version-bar__actions">
              ${
                viewer.current !== undefined
                  ? html`<button
                      type="button"
                      class="sw-link-button"
                      @click=${() => props.onOpen({ name: target.name, filePath: "SKILL.md" })}
                    >
                      ${t("skillWorkshop.viewer.backToCurrent")}
                    </button>`
                  : nothing
              }
              ${renderMutationButton(props, {
                label: t(
                  viewer.current !== undefined
                    ? "skillWorkshop.viewer.restoreVersion"
                    : "skillWorkshop.viewer.restore",
                ),
                mutation: {
                  method: "skills.workshop.restore",
                  name: target.name,
                  versionId: target.versionId,
                },
                key: `restore:${target.name}:${target.versionId}`,
              })}
            </span>
          </div>`
        : nothing
    }
    ${
      viewer.current !== undefined
        ? renderDiff(splitFrontmatter(viewer.current).body, body)
        : renderMarkdown(body)
    }
  `;
}

function renderFiles(
  viewer: WorkshopViewer,
  supportFiles: string[],
  props: SkillWorkshopViewProps,
) {
  if (supportFiles.length === 0) {
    return renderSettingsEmpty(t("skillWorkshop.viewer.noFiles"));
  }
  const { target } = viewer;
  const active = supportFiles.includes(target.filePath) ? target.filePath : null;
  return html`<div class="sw-files">
    <ul class="sw-files__list">
      ${supportFiles.map(
        (file) => html`<li>
          <button
            type="button"
            class="sw-files__item ${file === active ? "sw-files__item--active" : ""}"
            aria-current=${file === active ? "true" : nothing}
            @click=${() => props.onOpen({ ...target, filePath: file })}
          >
            <span aria-hidden="true">${icons.fileText}</span>
            <span>${file}</span>
          </button>
        </li>`,
      )}
    </ul>
    <div class="sw-files__content">
      ${
        active === null
          ? renderSettingsEmpty(t("skillWorkshop.viewer.pickFile"))
          : (renderLoadState(viewer) ??
            (viewer.status === "ready"
              ? active.endsWith(".md")
                ? renderMarkdown(viewer.result.content)
                : html`<pre class="sw-file">${viewer.result.content}</pre>`
              : nothing))
      }
    </div>
  </div>`;
}

type SavedVersion = { id: string; action: SkillWorkshopChange["action"]; createdAtMs: number };

/** Compare (live skill) or View (archived) for a retained saved version. */
function renderVersionLink(
  name: string,
  versionId: string,
  live: boolean,
  props: SkillWorkshopViewProps,
) {
  return html`<button
    type="button"
    class="sw-link-button"
    title=${live ? t("skillWorkshop.changes.compareTitle") : nothing}
    @click=${() => {
      props.onTab("instructions");
      props.onOpen({ name, filePath: "SKILL.md", versionId });
    }}
  >
    ${t(live ? "skillWorkshop.changes.compare" : "skillWorkshop.changes.view")}
  </button>`;
}

function renderHistory(
  name: string,
  history: SkillWorkshopChange[],
  versions: readonly SavedVersion[],
  snapshot: WorkshopSnapshot,
  props: SkillWorkshopViewProps,
) {
  // The change feed is recent and agent-wide; versions are what the Gateway still retains.
  const retained = new Set(versions.map((version) => version.id));
  const listed = new Set(history.map((change) => change.versionId).filter(Boolean));
  const older = versions.filter((version) => !listed.has(version.id));
  if (history.length === 0 && older.length === 0) {
    return renderSettingsEmpty(t("skillWorkshop.changes.empty"));
  }
  const live = snapshot.list.skills.some((skill) => skill.name === name);
  return html`<ol class="sw-timeline">
    ${history.map((change, index) => {
      const undo = undoMutationFor(change, snapshot.list);
      return html`<li class="sw-timeline__item ${index === 0 ? "sw-timeline__item--latest" : ""}">
        <span class="sw-timeline__dot" aria-hidden="true"></span>
        <div class="sw-timeline__text">
          <span class="sw-timeline__who"
            >${t(`skillWorkshop.changes.actors.${change.actor}`)}
            ${t(`skillWorkshop.changes.actions.${change.action}`)}</span
          >
          ${change.summary ? html`<span class="sw-timeline__why">${change.summary}</span>` : nothing}
          <span class="sw-timeline__when">${formatRelativeTimestamp(change.createdAtMs)}</span>
        </div>
        <div class="sw-timeline__actions">
          ${
            change.versionId && retained.has(change.versionId)
              ? renderVersionLink(name, change.versionId, live, props)
              : nothing
          }
          ${
            // An older creation's "undo" would archive the skill; that belongs to Archive.
            undo && (index === 0 || undo.method === "skills.workshop.restore")
              ? renderMutationButton(props, {
                  label: t(
                    index === 0
                      ? "skillWorkshop.changes.undo"
                      : "skillWorkshop.changes.restoreBefore",
                  ),
                  title: t("skillWorkshop.changes.undoTitle", { name }),
                  mutation: undo,
                  key: `undo:${change.id}`,
                  variant: "link",
                })
              : nothing
          }
        </div>
      </li>`;
    })}
    ${older.map(
      (version) => html`<li class="sw-timeline__item">
        <span class="sw-timeline__dot" aria-hidden="true"></span>
        <div class="sw-timeline__text">
          <span class="sw-timeline__who"
            >${t("skillWorkshop.changes.savedBefore", {
              action: t(`skillWorkshop.changes.actions.${version.action}`),
            })}</span
          >
          <span class="sw-timeline__when">${formatRelativeTimestamp(version.createdAtMs)}</span>
        </div>
        <div class="sw-timeline__actions">
          ${renderVersionLink(name, version.id, live, props)}
          ${renderMutationButton(props, {
            label: t("skillWorkshop.viewer.restore"),
            mutation: { method: "skills.workshop.restore", name, versionId: version.id },
            key: `restore:${name}:${version.id}`,
            variant: "link",
          })}
        </div>
      </li>`,
    )}
  </ol>`;
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

/** Reads like the change itself: the saved version's lines in red, today's in green. */
function renderDiff(current: string, version: string) {
  const lines = diffLines(version, current);
  if (lines === null) {
    return html`<p class="sw-diff__same">${t("skillWorkshop.viewer.diffTooLarge")}</p>
      ${renderMarkdown(version)}`;
  }
  if (lines.every((line) => line.kind === "same")) {
    return html`<p class="sw-diff__same">${t("skillWorkshop.viewer.noDiff")}</p>
      ${renderMarkdown(version)}`;
  }
  const sign = (kind: DiffLine["kind"]) => (kind === "add" ? "+" : kind === "remove" ? "−" : "");
  return html`<div class="sw-diff">
    <div class="sw-diff__legend">
      <span class="sw-diff__key sw-diff__key--remove"
        >${t("skillWorkshop.viewer.diffVersion")}</span
      >
      <span class="sw-diff__key sw-diff__key--add">${t("skillWorkshop.viewer.diffCurrent")}</span>
    </div>
    <div class="sw-diff__lines" role="table">
      ${lines.map(
        (line) =>
          html`<div class="sw-diff__line sw-diff__line--${line.kind}" role="row">
            <span class="sw-diff__sign" aria-hidden="true">${sign(line.kind)}</span
            ><span class="sw-diff__text">${line.text}</span>
          </div>`,
      )}
    </div>
  </div>`;
}
