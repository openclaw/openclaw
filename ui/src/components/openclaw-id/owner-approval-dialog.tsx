// SAS confirmation from the original local browser. The domain owner keeps signatures and ordering.
import "./owner-devices-dialog.css";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { resolveControlUiPaths } from "../../app/browser.ts";
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
import { clawNameFromHostname } from "./claw-name.ts";
import { OpenClawIdErrorMessage } from "./error-message.tsx";
import { createOwnerDialogMotion } from "./owner-dialog-motion.ts";

registerEnglishCatalog(registerOpenClawIdDialogsEnglish);
registerEnglishCatalog(registerOpenClawIdEnglish);

// Each request owns its optional expiry input, not the cryptographic attempt state.
function ApprovalRow(props: {
  request: OwnerApprovalRequest;
  claw: string;
  owner: OwnerApproval;
  onDevices: () => void;
  onClose: () => void;
}) {
  const [days, setDays] = createSignal("");
  const [comparedCode, setComparedCode] = createSignal("");
  const expiry = () => (days().trim() ? Number(days()) : null);
  const valid = () =>
    expiry() === null || (Number.isSafeInteger(expiry()) && expiry()! > 0 && expiry()! <= 3650);
  const inactive = () => props.request.expired || props.request.uncertain;
  const error = createMemo(() =>
    props.request.error ? openClawIdUiError(props.request.error, "approval") : null,
  );
  return (
    <section class="openclaw-id-approval__request">
      <strong class="openclaw-id-approval__browser openclaw-id-owner-enter">
        {props.request.label}
      </strong>
      <Show when={props.request.member}>
        {(member) => (
          <p class="openclaw-id-devices__description">
            {t("openclawId.approvalMemberClaim", { member: member().name })}
            <br />
            {t("openclawId.approvalMemberRequest")}
            <Show when={member().email && member().email !== member().name}>
              <br />
              {member().email}
            </Show>
            <Show when={member().location}>
              <br />
              {t("openclawId.approvalReportedLocation", { location: member().location! })}
            </Show>
          </p>
        )}
      </Show>
      <Show when={!props.request.error && !props.request.expired}>
        <p class="openclaw-id-devices__description openclaw-id-owner-enter">
          {props.request.member
            ? t("openclawId.approvalMemberCompare", { member: props.request.member.name })
            : t("openclawId.approvalCompare")}
        </p>
      </Show>
      <Show when={!props.request.error && !props.request.expired && props.request.tools}>
        {(tools) => (
          <p class="openclaw-id-devices__description openclaw-id-owner-enter">
            {t("openclawId.approvalRunsTools", {
              device: props.request.label,
              claw: props.claw,
              surface:
                [...new Set([...tools().caps, ...tools().commands])].join(", ") ||
                t("openclawId.approvalNoTools"),
            })}
          </p>
        )}
      </Show>
      <Show when={error()}>
        {(message) => (
          <div class="openclaw-id-devices__error openclaw-id-owner-enter" role="alert">
            {props.request.uncertain && props.request.member
              ? t("openclawId.approvalMemberUncertain", { member: props.request.member.name })
              : message().message}
          </div>
        )}
      </Show>
      <Show when={!props.request.member && (props.request.code || !inactive())}>
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
              <span class="openclaw-id-approval__waiting openclaw-id-owner-enter">
                <span class="btn__spinner" aria-hidden="true" />
                {t("openclawId.approvalWaiting")}
              </span>
            }
          >
            {(code) => (
              <span class="openclaw-id-owner-enter">
                {code().replace(/^(\d{3})(\d{3})$/, "$1 $2")}
              </span>
            )}
          </Show>
        </div>
      </Show>
      <Show when={error()?.detail}>
        {(detail) => (
          <details class="openclaw-id-approval__details openclaw-id-owner-enter">
            <summary>{t("openclawId.technicalDetails")}</summary>
            <div>{detail()}</div>
          </details>
        )}
      </Show>
      <Show when={!inactive()}>
        <Show when={props.request.member}>
          <label class="field">
            <span>{t("openclawId.approvalMemberCode")}</span>
            <input
              type="text"
              inputmode="numeric"
              maxlength="6"
              autocomplete="off"
              value={comparedCode()}
              onInput={(event) => setComparedCode(event.currentTarget.value)}
              disabled={props.request.busy}
            />
          </label>
        </Show>
        <Show when={!props.request.member}>
          <label class="openclaw-id-approval__expiry openclaw-id-owner-enter">
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
        </Show>
        <openclaw-modal-actions class="exec-approval-actions openclaw-id-owner-enter">
          <button
            type="button"
            class="btn"
            disabled={props.request.busy}
            onClick={() => void props.owner.decide(props.request.id, false)}
          >
            {t(props.request.member ? "openclawId.approvalMemberDeny" : "openclawId.approvalDeny")}
          </button>
          <button
            type="button"
            class="btn primary"
            disabled={
              props.request.busy ||
              !props.request.code ||
              !valid() ||
              (Boolean(props.request.member) && comparedCode() !== props.request.code)
            }
            onClick={() => {
              const duration = expiry();
              void props.owner.decide(
                props.request.id,
                true,
                duration === null ? null : Math.floor(Date.now() / 1000) + duration * 86400,
                comparedCode(),
              );
            }}
          >
            {t(
              props.request.member
                ? "openclawId.approvalMemberApprove"
                : "openclawId.approvalApprove",
            )}
          </button>
        </openclaw-modal-actions>
      </Show>
      <Show when={props.request.uncertain}>
        <openclaw-modal-actions class="exec-approval-actions openclaw-id-owner-enter">
          <Show
            when={props.request.member}
            fallback={
              <button type="button" class="btn primary" onClick={() => props.onDevices()}>
                {t("openclawId.yourDevices")}
              </button>
            }
          >
            <a
              class="btn primary"
              href={`${pathForRoute("plugin", resolveControlUiPaths(window.location.pathname)[0])}?plugin=openclaw-id-access&id=access`}
              onClick={() => props.onClose()}
            >
              {t("openclawId.approvalMemberDevices")}
            </a>
          </Show>
        </openclaw-modal-actions>
      </Show>
    </section>
  );
}

/** Shows owner-device codes or a member-read code input; never offers an unsigned approval. */
export function showOwnerApprovalDialog(params: {
  client: GatewayBrowserClient;
  onDevices: () => void;
}): Promise<void> {
  const owner = ownerApprovalFor(params.client);
  // Closes when the feature turns off.
  const lifetime = { signal: openClawIdFeatureSignal(), value: undefined };
  return withPromiseModalHost<void>(lifetime, (modal) => {
    modal.render(() => {
      const motion = createOwnerDialogMotion();
      const projection = owner ? projectOwner(owner, (value) => value.read()) : null;
      return (
        <openclaw-modal-dialog
          class="openclaw-id-owner-dialog openclaw-id-owner-dialog--approval"
          label={t("openclawId.approveNewDevice")}
          onModal-cancel={() => modal.finish(undefined)}
        >
          <div ref={motion.card} class="exec-approval-card openclaw-id-devices">
            <h2 class="openclaw-id-devices__title">
              <Show when={projection?.read().hostname} fallback={t("openclawId.approveNewDevice")}>
                {(hostname) =>
                  t("openclawId.approveNewDeviceFor", { claw: clawNameFromHostname(hostname()) })
                }
              </Show>
            </h2>
            <IconButton
              class="openclaw-id-devices__close"
              icon="x"
              label={t("common.close")}
              tooltip={false}
              onClick={() => modal.finish(undefined)}
            />
            <Show when={!owner}>
              <p class="callout info openclaw-id-owner-enter">
                {t("openclawId.approvalRequiresKey")}
              </p>
            </Show>
            <Show when={projection?.read().error}>
              {(message) => (
                <div class="openclaw-id-devices__error openclaw-id-owner-enter" role="alert">
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
              <p class="openclaw-id-devices__description openclaw-id-approval__empty openclaw-id-owner-enter">
                {t("openclawId.approvalEmpty")}
              </p>
            </Show>
            <For each={projection?.read().requests ?? []} keyed={(request) => request.id}>
              {(request) => (
                <ApprovalRow
                  request={request()}
                  claw={
                    clawNameFromHostname(projection?.read().hostname ?? "") ||
                    t("openclawId.yourClaw")
                  }
                  owner={owner!}
                  onClose={() => modal.finish(undefined)}
                  onDevices={() => {
                    modal.finish(undefined);
                    params.onDevices();
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
