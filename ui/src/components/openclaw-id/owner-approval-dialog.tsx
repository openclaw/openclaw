// SAS confirmation from the original local browser. The domain owner keeps signatures and ordering.
import "./owner-devices-dialog.css";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { registerOpenClawIdDialogsEnglish } from "../../i18n/locales/en-openclaw-id-dialogs.ts";
import { registerOpenClawIdEnglish } from "../../i18n/locales/en-openclaw-id.ts";
import { openClawIdFeatureSignal } from "../../lib/openclaw-id/feature-lifetime.ts";
import { ownerApprovalFor } from "../../lib/openclaw-id/owner-approval-lifetime.ts";
import type { OwnerApproval, OwnerApprovalRequest } from "../../lib/openclaw-id/owner-approval.ts";
import { openClawIdUiError } from "../../lib/openclaw-id/ui-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { withPromiseModalHost } from "../promise-modal-host.ts";
import { IconButton } from "../solid/icon-button.tsx";
import { OpenClawIdErrorMessage } from "./error-message.tsx";
import { showOwnerDevicesDialog } from "./owner-devices-dialog.tsx";

registerEnglishCatalog(registerOpenClawIdDialogsEnglish);
registerEnglishCatalog(registerOpenClawIdEnglish);

// Each request owns its optional expiry input, not the cryptographic attempt state.
function ApprovalRow(props: {
  request: OwnerApprovalRequest;
  owner: OwnerApproval;
  onDevices: () => void;
}) {
  const [days, setDays] = createSignal("");
  const expiry = () => (days().trim() ? Number(days()) : null);
  const valid = () =>
    expiry() === null || (Number.isSafeInteger(expiry()) && expiry()! > 0 && expiry()! <= 3650);
  const inactive = () => props.request.expired || props.request.uncertain;
  const error = createMemo(() =>
    props.request.error ? openClawIdUiError(props.request.error, "approval") : null,
  );
  return (
    <section class="openclaw-id-approval__request">
      <strong class="openclaw-id-approval__browser">{props.request.label}</strong>
      <Show when={!props.request.error && !props.request.expired}>
        <p class="openclaw-id-devices__description">{t("openclawId.approvalCompare")}</p>
      </Show>
      <Show when={error()}>
        {(message) => (
          <div class="openclaw-id-devices__error" role="alert">
            {message().message}
          </div>
        )}
      </Show>
      <Show when={props.request.code || !inactive()}>
        <div
          class={[
            "openclaw-id-approval__number",
            { "openclaw-id-approval__number--inactive": inactive() },
          ]}
          aria-live="polite"
        >
          <Show
            when={props.request.code}
            fallback={
              <span class="openclaw-id-approval__waiting">
                <span class="btn__spinner" aria-hidden="true" />
                {t("openclawId.approvalWaiting")}
              </span>
            }
          >
            {(code) => <span>{code().replace(/^(\d{3})(\d{3})$/, "$1 $2")}</span>}
          </Show>
        </div>
      </Show>
      <Show when={error()?.detail}>
        {(detail) => (
          <details class="openclaw-id-approval__details">
            <summary>{t("openclawId.technicalDetails")}</summary>
            <div>{detail()}</div>
          </details>
        )}
      </Show>
      <Show when={!inactive()}>
        <label class="openclaw-id-approval__expiry">
          <span>
            {t("openclawId.regenExpiry")}
            <small>{t("openclawId.regenExpiryHint")}</small>
          </span>
          <input
            type="number"
            min="1"
            max="3650"
            inputmode="numeric"
            value={days()}
            onInput={(event) => setDays(event.currentTarget.value)}
            disabled={props.request.busy}
          />
        </label>
        <openclaw-modal-actions class="exec-approval-actions">
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
        </openclaw-modal-actions>
      </Show>
      <Show when={props.request.uncertain}>
        <openclaw-modal-actions class="exec-approval-actions">
          <button type="button" class="btn primary" onClick={() => props.onDevices()}>
            {t("openclawId.yourDevices")}
          </button>
        </openclaw-modal-actions>
      </Show>
    </section>
  );
}

/** Shows pending requests with their six-digit matching numbers; never offers an unsigned approval. */
export function showOwnerApprovalDialog(params: { client: GatewayBrowserClient }): Promise<void> {
  const owner = ownerApprovalFor(params.client);
  // Closes when the feature turns off.
  const lifetime = { signal: openClawIdFeatureSignal(), value: undefined };
  return withPromiseModalHost<void>(lifetime, (modal) => {
    modal.render(() => {
      const projection = owner ? projectOwner(owner, (value) => value.read()) : null;
      return (
        <openclaw-modal-dialog
          class="openclaw-id-owner-dialog openclaw-id-owner-dialog--approval"
          label={t("openclawId.approveNewDevice")}
          onModal-cancel={() => modal.finish(undefined)}
        >
          <div class="exec-approval-card openclaw-id-devices">
            <h2 class="openclaw-id-devices__title">{t("openclawId.approveNewDevice")}</h2>
            <IconButton
              class="openclaw-id-devices__close"
              icon="x"
              label={t("common.close")}
              tooltip={false}
              onClick={() => modal.finish(undefined)}
            />
            <Show when={!owner}>
              <p class="callout info">{t("openclawId.approvalRequiresKey")}</p>
            </Show>
            <Show when={projection?.read().error}>
              {(message) => (
                <div class="openclaw-id-devices__error" role="alert">
                  <OpenClawIdErrorMessage error={openClawIdUiError(message(), "approval")} />
                  <Show when={!projection?.read().requests.some((request) => request.uncertain)}>
                    <openclaw-modal-actions class="exec-approval-actions">
                      <button type="button" class="btn primary" onClick={() => owner?.retry()}>
                        {t("common.retry")}
                      </button>
                    </openclaw-modal-actions>
                  </Show>
                </div>
              )}
            </Show>
            <Show
              when={owner && !projection?.read().error && projection?.read().requests.length === 0}
            >
              <p class="openclaw-id-devices__description openclaw-id-approval__empty">
                {t("openclawId.approvalEmpty")}
              </p>
            </Show>
            <For each={projection?.read().requests ?? []} keyed={(request) => request.id}>
              {(request) => (
                <ApprovalRow
                  request={request()}
                  owner={owner!}
                  onDevices={() => {
                    modal.finish(undefined);
                    void showOwnerDevicesDialog(params);
                  }}
                />
              )}
            </For>
          </div>
        </openclaw-modal-dialog>
      );
    });
  });
}
