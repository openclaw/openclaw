import type { SkillWorkshopChange } from "@openclaw/gateway-protocol";
import { createMemo, createSignal, createUniqueId, Errored, For, Loading, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { MarkdownHtml } from "../../components/solid/markdown-html.tsx";
import { SettingsEmpty } from "../../components/solid/settings-ui.tsx";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { undoMutationFor } from "./api.ts";
import { Diff, LoadState, splitFrontmatter } from "./diff.tsx";
import {
  MutationButton,
  WorkshopChangeText,
  type WorkshopReads,
  type WorkshopView,
} from "./view-shared.tsx";

type SavedVersion = { id: string; action: SkillWorkshopChange["action"]; createdAtMs: number };
export function VersionLink(props: {
  name: string;
  versionId: string;
  live: boolean;
  view: WorkshopView;
}) {
  return (
    <button
      type="button"
      class="btn btn--sm oc-action"
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

/** A history row opens the same comparison Compare loads, in place under the row. */
function VersionToggle(props: {
  name: string;
  versionId: string;
  live: boolean;
  open: boolean;
  bodyId: string;
  view: WorkshopView;
  onToggle: (open: boolean) => void;
}) {
  return (
    <button
      type="button"
      class="sw-history__toggle"
      title={props.live ? t("skillWorkshop.changes.compareTitle") : undefined}
      aria-expanded={props.open ? "true" : "false"}
      aria-controls={props.bodyId}
      onClick={() => {
        if (props.open) {
          props.onToggle(false);
          return;
        }
        props.onToggle(true);
        props.view().onOpen({ name: props.name, filePath: "SKILL.md", versionId: props.versionId });
      }}
    >
      {t(props.live ? "skillWorkshop.changes.compare" : "skillWorkshop.changes.view")}
      <Icon name="chevronDown" />
    </button>
  );
}

function VersionPreview(props: { reads: WorkshopReads; versionId: string }) {
  return (
    <Loading on={props.reads.viewerRequest()} fallback={<LoadState />}>
      <Errored fallback={(error) => <LoadState error={error()} />}>
        <Show when={props.reads.viewer()?.target.versionId === props.versionId}>
          <Show when={props.reads.viewer()}>
            {(viewer) =>
              viewer().current !== undefined ? (
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
              )
            }
          </Show>
        </Show>
      </Errored>
    </Loading>
  );
}

export function History(props: { view: WorkshopView; reads: WorkshopReads }) {
  const name = () => props.view().viewer!.target.name;
  const snapshot = () => props.view().snapshot!;
  const history = createMemo(() =>
    snapshot().changes.filter((change) => change.skillName === name()),
  );
  const versions = createMemo(
    () => snapshot().list.archived.find((entry) => entry.name === name())?.versions ?? [],
  );
  const retained = createMemo(() => new Set(versions().map((version) => version.id)));
  const older = createMemo(() => {
    const listed = new Set(
      history()
        .map((change) => change.versionId)
        .filter(Boolean),
    );
    return versions().filter((version) => !listed.has(version.id));
  });
  const live = () => snapshot().list.skills.some((skill) => skill.name === name());
  // One row at a time shows its comparison: the row the viewer holds a version for.
  const [openRow, setOpenRow] = createSignal<string | null>(null);
  const isOpen = (key: string, versionId: string) =>
    openRow() === `${name()}:${key}` && props.view().viewer?.target.versionId === versionId;
  const toggle = (key: string) => (open: boolean) => setOpenRow(open ? `${name()}:${key}` : null);
  return (
    <Show
      when={history().length > 0 || older().length > 0}
      fallback={<SettingsEmpty message={t("skillWorkshop.changes.empty")} />}
    >
      <ol class="sw-timeline">
        <For each={history()} keyed={(change) => change.id}>
          {(change, index) => {
            const undo = () => undoMutationFor(change(), snapshot().list);
            const versionId = () =>
              change().versionId && retained().has(change().versionId!)
                ? change().versionId!
                : undefined;
            const bodyId = `sw-history-${createUniqueId()}`;
            const open = () => Boolean(versionId()) && isOpen(change().id, versionId()!);
            return (
              <li
                class={[
                  "sw-timeline__item",
                  { "sw-timeline__item--latest": index() === 0, "sw-timeline__item--open": open() },
                ]}
              >
                <div class="sw-timeline__row">
                  <div class="sw-timeline__text">
                    <WorkshopChangeText change={change()} prefix="sw-timeline__" />
                  </div>
                  <div class="sw-timeline__actions">
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
                            />
                          )}
                        </>
                      )}
                    </Show>
                    <Show when={versionId()}>
                      {(id) => (
                        <VersionToggle
                          name={name()}
                          versionId={id()}
                          live={live()}
                          open={open()}
                          bodyId={bodyId}
                          view={props.view}
                          onToggle={toggle(change().id)}
                        />
                      )}
                    </Show>
                  </div>
                </div>
                <Show when={open()}>
                  <div class="sw-timeline__body" id={bodyId}>
                    <VersionPreview reads={props.reads} versionId={versionId()!} />
                  </div>
                </Show>
              </li>
            );
          }}
        </For>
        <For each={older()} keyed={(version: SavedVersion) => version.id}>
          {(version) => {
            const bodyId = `sw-history-${createUniqueId()}`;
            const open = () => isOpen(version().id, version().id);
            return (
              <li class={["sw-timeline__item", { "sw-timeline__item--open": open() }]}>
                <div class="sw-timeline__row">
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
                    <MutationButton
                      view={props.view}
                      label={t("skillWorkshop.viewer.restore")}
                      mutation={{
                        method: "skills.workshop.restore",
                        name: name(),
                        versionId: version().id,
                      }}
                      actionKey={`restore:${name()}:${version().id}`}
                    />
                    <VersionToggle
                      name={name()}
                      versionId={version().id}
                      live={live()}
                      open={open()}
                      bodyId={bodyId}
                      view={props.view}
                      onToggle={toggle(version().id)}
                    />
                  </div>
                </div>
                <Show when={open()}>
                  <div class="sw-timeline__body" id={bodyId}>
                    <VersionPreview reads={props.reads} versionId={version().id} />
                  </div>
                </Show>
              </li>
            );
          }}
        </For>
      </ol>
    </Show>
  );
}
