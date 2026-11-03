// SAS confirmation from the original local browser. The domain owner keeps signatures and ordering.
import { createSignal, For, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { registerOpenClawIdDialogsEnglish } from "../../i18n/locales/en-openclaw-id-dialogs.ts";
import { registerOpenClawIdEnglish } from "../../i18n/locales/en-openclaw-id.ts";
import { ownerApprovalFor } from "../../lib/openclaw-id/owner-approval-lifetime.ts";
import type { OwnerApproval, OwnerApprovalRequest } from "../../lib/openclaw-id/owner-approval.ts";
import { openClawIdUiError } from "../../lib/openclaw-id/ui-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { withPromiseModalHost } from "../promise-modal-host.ts";
import { OpenClawIdErrorMessage } from "./error-message.tsx";

registerEnglishCatalog(registerOpenClawIdDialogsEnglish);
registerEnglishCatalog(registerOpenClawIdEnglish);

// Each request owns its optional expiry input, not the cryptographic attempt state.
function ApprovalRow(props: { request: OwnerApprovalRequest; owner: OwnerApproval }) {
  const [days, setDays] = createSignal("");
  const expiry = () => (days().trim() ? Number(days()) : null);
  const valid = () =>
    expiry() === null || (Number.isSafeInteger(expiry()) && expiry()! > 0 && expiry()! <= 3650);
  return (
    <div class="stack">
      <strong>{props.request.label}</strong>
      <Show when={props.request.code} fallback={<p>{t("openclawId.approvalWaiting")}</p>}>
        {(code) => (
          <>
            <p>{t("openclawId.approvalCompare")}</p>
            <strong class="mono" style={{ "font-size": "2rem", "letter-spacing": "0.25em" }}>
              {code()}
            </strong>
          </>
        )}
      </Show>
      <label class="field">
        <span>{t("openclawId.regenExpiry")}</span>
        <input
          type="number"
          min="1"
          max="3650"
          value={days()}
          onInput={(event) => setDays(event.currentTarget.value)}
          disabled={props.request.busy}
        />
        <small>{t("openclawId.regenExpiryHint")}</small>
      </label>
      <Show when={props.request.error}>
        {(message) => (
          <div class="callout danger" role="alert">
            <OpenClawIdErrorMessage error={openClawIdUiError(message(), "approval")} />
          </div>
        )}
      </Show>
      <div class="row">
        <button
          type="button"
          class="btn"
          disabled={props.request.busy}
          onClick={() => void props.owner.decide(props.request.id, false)}
        >
          {t("openclawId.approvalDeny")}
        </button>
        <button
          type="button"
          class="btn primary"
          disabled={props.request.busy || !props.request.code || !valid()}
          onClick={() => {
            const duration = expiry();
            void props.owner.decide(
              props.request.id,
              true,
              duration === null ? null : Math.floor(Date.now() / 1000) + duration * 86400,
            );
          }}
        >
          {t("openclawId.approvalApprove")}
        </button>
      </div>
    </div>
  );
}

/** Shows pending requests with their six-digit matching numbers; never offers an unsigned approval. */
export function showOwnerApprovalDialog(params: { client: GatewayBrowserClient }): Promise<void> {
  const owner = ownerApprovalFor(params.client);
  return withPromiseModalHost<void>(undefined, (modal) => {
    modal.render(() => {
      const projection = owner ? projectOwner(owner, (value) => value.read()) : null;
      return (
        <openclaw-modal-dialog
          label={t("openclawId.approveNewDevice")}
          onModal-cancel={() => modal.finish(undefined)}
        >
          <div class="exec-approval-card openclaw-id-devices">
            <h2>{t("openclawId.approveNewDevice")}</h2>
            <Show when={!owner}>
              <p class="callout info">{t("openclawId.approvalRequiresKey")}</p>
            </Show>
            <Show when={projection?.read().error}>
              {(message) => (
                <div class="callout danger" role="alert">
                  <OpenClawIdErrorMessage error={openClawIdUiError(message(), "approval")} />
                  <button type="button" class="btn" onClick={() => owner?.retry()}>
                    {t("common.retry")}
                  </button>
                </div>
              )}
            </Show>
            <Show when={owner && projection?.read().requests.length === 0}>
              <p>{t("openclawId.approvalEmpty")}</p>
            </Show>
            <For each={projection?.read().requests ?? []} keyed={(request) => request.id}>
              {(request) => <ApprovalRow request={request()} owner={owner!} />}
            </For>
            <openclaw-modal-actions class="exec-approval-actions">
              <button type="button" class="btn" onClick={() => modal.finish(undefined)}>
                {t("common.close")}
              </button>
            </openclaw-modal-actions>
          </div>
        </openclaw-modal-dialog>
      );
    });
  });
}
