import "../../styles/template-upload.css";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import { MAX_TEMPLATE_UPLOAD_ARCHIVE_BYTES } from "../../../../packages/gateway-protocol/src/template-source-limits.js";
import { DialogHeader } from "../../components/solid/dialog-header.tsx";
import { FloatingHeaderActions } from "../../components/solid/floating-header-actions.tsx";
import { IconButton } from "../../components/solid/icon-button.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { readBlobAsDataUrl } from "../../lib/blob-data-url.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { TemplateImportReview } from "./template-import-review.tsx";
import {
  applyTemplateAdd,
  readTemplateAddReviewPlan,
  type TemplateAddReviewPlan,
  type TemplateUploadSource,
} from "./templates-catalog-client.ts";
import { TemplatePackageConsent } from "./templates-detail-view.tsx";

export function TemplateUpload() {
  const context = useApplication();
  const filenameId = createUniqueId();
  const trustId = createUniqueId();
  const consentId = createUniqueId();
  const acknowledgementId = createUniqueId();
  let fileInput: HTMLInputElement | undefined;
  const [filename, setFilename] = createSignal("");
  const [review, setReview] = createSignal<TemplateAddReviewPlan | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  // Keep archive bytes only for this selection's review/apply, never in persisted UI state.
  let source: TemplateUploadSource | undefined;
  let generation = 0;
  function reset() {
    generation += 1;
    source = undefined;
    setFilename("");
    setReview(null);
    setBusy(false);
    setMessage("");
  }
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: reset,
    invalidateRequests: reset,
    ensureInitialData: () => {},
  });
  const canUpload = () =>
    canCallGatewayMethod(gateway.snapshot, "templates.add.apply", "operator.admin");
  async function select(file: File) {
    reset();
    const current = generation;
    const scope = gateway.capture();
    if (!scope || !canUpload()) {
      return;
    }
    setFilename(file.name);
    setBusy(true);
    try {
      if (
        !file.name.toLowerCase().endsWith(".tgz") ||
        file.size === 0 ||
        file.size > MAX_TEMPLATE_UPLOAD_ARCHIVE_BYTES
      ) {
        throw new Error(t("templatesCatalog.invalidArchive"));
      }
      const dataUrl = await readBlobAsDataUrl(file);
      if (!gateway.isCurrent(scope) || current !== generation) {
        return;
      }
      const upload: TemplateUploadSource = {
        kind: "upload",
        archiveBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
      };
      const plan = await readTemplateAddReviewPlan(scope.client, upload);
      if (gateway.isCurrent(scope) && current === generation) {
        source = upload;
        setReview(plan);
      }
    } catch (error) {
      if (gateway.isCurrent(scope) && current === generation) {
        setMessage(formatUiError(error));
      }
    } finally {
      if (gateway.isCurrent(scope) && current === generation) {
        setBusy(false);
      }
    }
  }
  async function install() {
    const scope = gateway.capture();
    const plan = review();
    const upload = source;
    const current = generation;
    if (!scope || !plan || !upload || busy() || !canUpload() || plan.blockers.length) {
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await applyTemplateAdd(scope.client, upload, { reviewPlan: plan });
      if (gateway.isCurrent(scope) && current === generation) {
        source = undefined;
        setReview(null);
        setMessage(
          result.status === "complete"
            ? t("templatesCatalog.installedAgent", { agentId: result.agentId })
            : (result.error?.message ?? t("templatesCatalog.incompleteImport")),
        );
      }
    } catch (error) {
      if (gateway.isCurrent(scope) && current === generation) {
        // Do not offer a blind retry after an uncertain mutation outcome.
        source = undefined;
        setReview(null);
        setMessage(formatUiError(error));
      }
    } finally {
      if (gateway.isCurrent(scope) && current === generation) {
        setBusy(false);
      }
    }
  }
  return (
    <Show when={canUpload()}>
      <FloatingHeaderActions
        fallback={
          <button type="button" class="btn" disabled={busy()} onClick={() => fileInput?.click()}>
            <Icon name="plus" /> {t("templatesCatalog.importButton")}
          </button>
        }
      >
        <IconButton
          icon="import"
          label={t("templatesCatalog.importButton")}
          disabled={busy()}
          onClick={() => fileInput?.click()}
        />
      </FloatingHeaderActions>
      <input
        ref={(element) => {
          fileInput = element;
        }}
        hidden
        type="file"
        accept=".tgz"
        aria-label={t("templatesCatalog.archiveLabel")}
        disabled={busy()}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) {
            void select(file);
          }
        }}
      />
      <Show when={filename()}>
        <openclaw-modal-dialog
          label={t("templatesCatalog.importTitle")}
          style={{ "--openclaw-modal-width": "540px" }}
          onModal-cancel={(event: Event) => {
            event.preventDefault();
            if (!busy()) {
              reset();
            }
          }}
        >
          <div class="oc-dialog template-import-dialog">
            <DialogHeader
              title={t("templatesCatalog.importTitle")}
              actions={
                <openclaw-tooltip
                  prop:content={t("templatesCatalog.chooseAnotherArchive") + ": " + filename()}
                >
                  <button
                    type="button"
                    class="btn template-import-file"
                    aria-label={t("templatesCatalog.chooseAnotherArchive")}
                    aria-describedby={filenameId}
                    disabled={busy()}
                    onClick={() => fileInput?.click()}
                  >
                    <Icon name="fileText" />
                    <span id={filenameId} title={filename()}>
                      {filename()}
                    </span>
                  </button>
                </openclaw-tooltip>
              }
              closeDisabled={busy()}
              onClose={reset}
            />
            <div class="oc-dialog__body">
              <Show when={busy() && !review()}>
                <p role="status">{t("templatesCatalog.reviewingArchive")}</p>
              </Show>
              <Show when={message()}>
                <p role="status">{message()}</p>
              </Show>
              <Show when={review()}>
                {(plan) => (
                  <>
                    <TemplateImportReview plan={plan()} />
                    <div id={consentId} class="template-import-consent">
                      <TemplatePackageConsent plan={plan()} />
                    </div>
                    <Show when={plan().blockers.length}>
                      <ul role="alert">
                        <For each={plan().blockers}>{(item) => <li>{item.message}</li>}</For>
                      </ul>
                    </Show>
                  </>
                )}
              </Show>
            </div>
            <div class="oc-dialog__footer template-import-footer">
              <Show when={review()}>
                <p id={trustId} class="template-import-trust">
                  <Icon name="alertTriangle" />
                  <span>{t("templatesCatalog.importTrust")}</span>
                </p>
              </Show>
              <Show when={review()?.riskAcknowledgementRequired}>
                <p id={acknowledgementId} class="template-import-acknowledgement">
                  {t("templatesCatalog.importRiskAcknowledgement")}
                </p>
              </Show>
              <openclaw-modal-actions>
                <button type="button" class="btn" disabled={busy()} onClick={reset}>
                  {t(review() ? "common.cancel" : "common.close")}
                </button>
                <Show when={review()}>
                  <button
                    type="button"
                    class="btn primary"
                    aria-describedby={
                      review()?.riskAcknowledgementRequired
                        ? [trustId, acknowledgementId, consentId].join(" ")
                        : trustId
                    }
                    disabled={busy() || Boolean(review()?.blockers.length)}
                    onClick={() => void install()}
                  >
                    <Show when={busy()}>
                      <span class="btn__spinner" aria-hidden="true" />
                    </Show>
                    <span role="status">
                      {t(
                        busy()
                          ? "templatesCatalog.importingArchive"
                          : "templatesCatalog.importTemplate",
                      )}
                    </span>
                  </button>
                </Show>
              </openclaw-modal-actions>
            </div>
          </div>
        </openclaw-modal-dialog>
      </Show>
    </Show>
  );
}
