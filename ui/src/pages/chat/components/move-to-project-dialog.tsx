import { createMemo, createSignal, Errored, For, Loading, Show } from "solid-js";
import type {
  MoveSessionCheckout,
  ProjectsMoveSessionOptionsResult,
  ProjectsMoveSessionResult,
} from "../../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { withPromiseModalHost } from "../../../components/promise-modal-host.ts";
import { DialogHeader } from "../../../components/solid/dialog-header.tsx";
import { InlineAlert } from "../../../components/solid/inline-alert.tsx";
import { Radio } from "../../../components/solid/radio.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { showToast } from "../../../lib/toast.ts";

registerEnglishCatalog(registerChatSessionEnglish);

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

function carryText(checkout: MoveSessionCheckout): string {
  const params = {
    folder: checkout.path,
    subject: checkout.head.subject,
    count: String(checkout.unsavedFiles),
  };
  const key =
    checkout.unsavedFiles === 0
      ? "carryCommitted"
      : checkout.unsavedFiles === 1
        ? "carryOne"
        : "carryMany";
  return t(`chat.sessionHeader.moveToProject.${key}`, params);
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
  const [checkoutChoice, setCheckoutChoice] = createSignal<string>();
  const [moving, setMoving] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const project = createMemo(() => {
    const projects = options().projects;
    return projects.find((entry) => entry.id === projectChoice()) ?? projects[0];
  });
  const checkout = createMemo(() => {
    const checkouts = project()?.checkouts ?? [];
    return checkouts.find((entry) => entry.path === checkoutChoice()) ?? checkouts[0];
  });
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
      const result = await client.request<ProjectsMoveSessionResult>("projects.moveSession", {
        ...scope,
        projectId: target.id,
        ...(folder ? { checkout: folder } : {}),
      });
      finish(true);
      showToast({
        severity: "success",
        message: result.branch
          ? t("chat.sessionHeader.moveToProject.moved", {
              project: target.name,
              branch: result.branch,
            })
          : t("chat.sessionHeader.moveToProject.movedNoBranch", { project: target.name }),
      });
    } catch (failure) {
      setError(formatUiError(failure, t("chat.sessionHeader.moveToProject.failed")));
      setMoving(false);
    }
  }
  const title = t("chat.sessionHeader.moveToProject.title");
  const description = t("chat.sessionHeader.moveToProject.description");
  return (
    <openclaw-modal-dialog
      class="move-to-project-dialog"
      label={title}
      description={description}
      onModal-cancel={(event: Event) => {
        if (moving()) {
          event.preventDefault();
        } else {
          finish(false);
        }
      }}
    >
      <form class="oc-dialog" onSubmit={(event) => void move(event)}>
        <DialogHeader
          title={title}
          description={description}
          closeDisabled={moving()}
          onClose={close}
        />
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
                    <p>{options().reason}</p>
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
                <fieldset disabled={moving()}>
                  <legend>{t("chat.sessionHeader.moveToProject.projects")}</legend>
                  <For each={options().projects} keyed={(entry) => entry.id}>
                    {(entry) => (
                      <Radio
                        name="project"
                        value={entry().id}
                        checked={project()?.id === entry().id}
                        onChange={() => {
                          setProjectChoice(entry().id);
                          setCheckoutChoice(undefined);
                        }}
                      >
                        <span>
                          {entry().name}
                          <Show when={entry().originUrl}>
                            {(origin) => <span class="muted"> · {origin()}</span>}
                          </Show>
                        </span>
                      </Radio>
                    )}
                  </For>
                </fieldset>
                <Show when={(project()?.checkouts.length ?? 0) > 1}>
                  <fieldset disabled={moving()}>
                    <legend>{t("chat.sessionHeader.moveToProject.checkouts")}</legend>
                    <For each={project()?.checkouts ?? []} keyed={(entry) => entry.path}>
                      {(entry) => (
                        <Radio
                          name="checkout"
                          value={entry().path}
                          checked={checkout()?.path === entry().path}
                          onChange={() => setCheckoutChoice(entry().path)}
                        >
                          <span>{entry().path}</span>
                        </Radio>
                      )}
                    </For>
                  </fieldset>
                </Show>
                <Show
                  when={checkout()}
                  fallback={<p>{t("chat.sessionHeader.moveToProject.fresh")}</p>}
                >
                  {(detected) => <p>{carryText(detected())}</p>}
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
                <button type="button" class="btn" disabled={moving()} onClick={close}>
                  {t("common.cancel")}
                </button>
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
