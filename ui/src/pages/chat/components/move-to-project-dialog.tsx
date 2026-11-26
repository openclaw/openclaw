import { createMemo, createSignal, createUniqueId, Errored, Loading, Show } from "solid-js";
import type {
  ProjectsMoveSessionOptionsResult,
  ProjectsMoveSessionResult,
} from "../../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { withPromiseModalHost } from "../../../components/promise-modal-host.ts";
import { Picker } from "../../../components/select-picker.ts";
import { DialogHeader } from "../../../components/solid/dialog-header.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { InlineAlert } from "../../../components/solid/inline-alert.tsx";
import { registerChatMoveToProjectEnglish } from "../../../i18n/locales/en-chat-move-to-project.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { showToast } from "../../../lib/toast.ts";

registerEnglishCatalog(registerChatMoveToProjectEnglish);

export type MoveToProjectRequest = {
  client: GatewayBrowserClient;
  key: string;
  agentId?: string;
  signal?: AbortSignal;
};

let active = false;

/** One dialog at a time; its options request lives and dies with the dialog. A move ends with a toast. */
export function showMoveToProjectDialog(request: MoveToProjectRequest): Promise<boolean> {
  if (active) {
    return Promise.resolve(false);
  }
  active = true;
  return withPromiseModalHost<boolean>({ signal: request.signal, value: false }, (modal) =>
    modal.render(() => renderMoveToProjectDialog(request, modal.finish)),
  ).finally(() => {
    active = false;
  });
}

function renderMoveToProjectDialog(
  request: MoveToProjectRequest,
  finish: (moved: boolean) => void,
) {
  const { client, key, agentId } = request;
  const scope = agentId ? { sessionKey: key, agentId } : { sessionKey: key };
  const options = createMemo(() =>
    client.request<ProjectsMoveSessionOptionsResult>("projects.moveSessionOptions", scope),
  );
  const [projectChoice, setProjectChoice] = createSignal<string>();
  const [moving, setMoving] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const project = createMemo(() => {
    const projects = options().projects;
    return projects.find((entry) => entry.id === projectChoice()) ?? projects[0];
  });
  // When several clones match, preview and carry the same first checkout.
  const checkout = () => project()?.checkouts[0];
  const pickerId = createUniqueId();
  const copySummaryId = createUniqueId();
  const copySummary = () => {
    const count = checkout()?.unsavedFiles;
    if (count === undefined) {
      return undefined;
    }
    if (count === 0) {
      return t("chat.sessionHeader.moveToProject.copySavedWork");
    }
    return count === 1
      ? t("chat.sessionHeader.moveToProject.copyOneFile")
      : t("chat.sessionHeader.moveToProject.copyFiles", { count: String(count) });
  };
  const close = () => {
    if (!moving()) {
      finish(false);
    }
  };
  async function move(event: SubmitEvent) {
    event.preventDefault();
    const target = project();
    if (moving() || !target) {
      return;
    }
    const folder = checkout()?.path;
    setMoving(true);
    setError(undefined);
    try {
      await client.request<ProjectsMoveSessionResult>("projects.moveSession", {
        ...scope,
        projectId: target.id,
        ...(folder ? { checkout: folder } : {}),
      });
      finish(true);
      showToast({
        severity: "success",
        message: folder
          ? t("chat.sessionHeader.moveToProject.movedWithWork", { project: target.name })
          : t("chat.sessionHeader.moveToProject.moved", { project: target.name }),
      });
    } catch (failure) {
      setError(formatUiError(failure, t("chat.sessionHeader.moveToProject.failed")));
      setMoving(false);
    }
  }
  const title = t("chat.sessionHeader.moveToProject.title");
  return (
    <openclaw-modal-dialog
      class="move-to-project-dialog"
      label={title}
      onModal-cancel={(event: Event) => {
        if (moving()) {
          event.preventDefault();
        } else {
          finish(false);
        }
      }}
    >
      <form class="oc-dialog" onSubmit={(event) => void move(event)}>
        <DialogHeader title={title} closeDisabled={moving()} onClose={close} />
        <Errored
          fallback={(failure) => (
            <>
              <div class="oc-dialog__body">
                <InlineAlert tone="danger" role="alert">
                  {formatUiError(failure(), t("chat.sessionHeader.moveToProject.failed"))}
                </InlineAlert>
              </div>
              <openclaw-modal-actions class="oc-dialog__footer">
                <button type="button" class="btn primary" onClick={close}>
                  {t("common.close")}
                </button>
              </openclaw-modal-actions>
            </>
          )}
        >
          <Loading
            fallback={
              <div class="oc-dialog__body" role="status">
                {t("common.loading")}
              </div>
            }
          >
            <Show
              when={options().available && project()}
              fallback={
                <>
                  <div class="oc-dialog__body">
                    <p>{options().reason ?? t("chat.sessionHeader.moveToProject.noProjects")}</p>
                  </div>
                  <openclaw-modal-actions class="oc-dialog__footer">
                    <button type="button" class="btn primary" onClick={close}>
                      {t("common.close")}
                    </button>
                  </openclaw-modal-actions>
                </>
              }
            >
              <div class="oc-dialog__body">
                <div class="field">
                  <label for={pickerId} class="muted">
                    {t("chat.sessionHeader.moveToProject.project")}
                  </label>
                  <Picker
                    params={{
                      id: pickerId,
                      label: t("chat.sessionHeader.moveToProject.project"),
                      describedBy: checkout() ? copySummaryId : undefined,
                      disabled: moving(),
                      value: project()?.id ?? null,
                      options: options().projects.map(({ id, name, originUrl }) => ({
                        value: id,
                        label: name,
                        description: originUrl,
                      })),
                      renderLeading: () => <Icon name="folder" style="width:16px;height:16px" />,
                      onChange: setProjectChoice,
                    }}
                  />
                </div>
                <Show when={copySummary()}>
                  {(summary) => (
                    <p
                      id={copySummaryId}
                      class="muted"
                      style="display:flex;align-items:center;gap:8px;margin:0"
                    >
                      <Icon name="fileText" style="width:16px;height:16px;flex:none" />
                      <span>{summary()}</span>
                    </p>
                  )}
                </Show>
                <Show when={moving()}>
                  <p role="status">{t("chat.sessionHeader.moveToProject.moving")}</p>
                </Show>
                <Show when={!moving() && error()}>
                  <InlineAlert tone="danger" role="alert">
                    {error()}
                  </InlineAlert>
                </Show>
              </div>
              <openclaw-modal-actions class="oc-dialog__footer">
                <button type="submit" class="btn primary" disabled={moving()}>
                  {t("chat.sessionHeader.moveToProject.move")}
                </button>
              </openclaw-modal-actions>
            </Show>
          </Loading>
        </Errored>
      </form>
    </openclaw-modal-dialog>
  );
}
