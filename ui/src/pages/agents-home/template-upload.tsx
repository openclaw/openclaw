import "../../styles/template-upload.css";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import { MAX_TEMPLATE_UPLOAD_ARCHIVE_BYTES } from "../../../../packages/gateway-protocol/src/template-source-limits.js";
import { DialogHeader } from "../../components/solid/dialog-header.tsx";
import { FloatingHeaderActions } from "../../components/solid/floating-header-actions.tsx";
import { IconButton } from "../../components/solid/icon-button.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { readBlobAsDataUrl } from "../../lib/blob-data-url.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../../lib/reactive/layout-measurement.ts";
import { openTemplateAgentChat } from "./template-agent-chat.ts";
import { templateImportFacts } from "./template-import-facts.ts";
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
  const [installed, setInstalled] = createSignal<{ agentId: string; name: string } | null>(null);
  // Only a failed review may pick again; an uncertain apply must not invite a blind retry.
  const [canChooseAgain, setCanChooseAgain] = createSignal(false);
  const [opening, setOpening] = createSignal(false);
  const reviewing = () => busy() && !review();
  const applying = () => (busy() && Boolean(review())) || opening();
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
    setInstalled(null);
    setCanChooseAgain(false);
    setOpening(false);
  }
  let scrollBody!: HTMLDivElement;
  let scrollContent!: HTMLDivElement;
  // The shared measurement owner retires observers when the dialog closes.
  const updateScrollFades = createLayoutMeasurement(
    () => filename(),
    () => {
      const top = scrollBody.scrollTop > 1;
      const bottom = scrollBody.scrollTop + scrollBody.clientHeight < scrollBody.scrollHeight - 1;
      return () => {
        scrollBody.toggleAttribute("data-scroll-fade-top", top);
        scrollBody.toggleAttribute("data-scroll-fade-bottom", bottom);
      };
    },
    { targets: () => [scrollBody, scrollContent] },
  );
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
        setCanChooseAgain(true);
      }
    } finally {
      if (gateway.isCurrent(scope) && current === generation) {
        setBusy(false);
      }
    }
  }
  async function openChat() {
    const done = installed();
    const current = generation;
    if (!done || opening()) {
      return;
    }
    setOpening(true);
    setMessage("");
    try {
      const roster = await context.agents.refreshList();
      if (current !== generation) {
        return;
      }
      if (!roster?.agents.some((agent) => agent.id === done.agentId)) {
        throw new Error(t("templatesCatalog.openChatFailed"));
      }
      reset();
      openTemplateAgentChat(context, done.agentId);
    } catch {
      if (current === generation) {
        setMessage(t("templatesCatalog.openChatFailed"));
        setOpening(false);
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
        if (result.status === "complete" && result.agentId) {
          setInstalled({ agentId: result.agentId, name: templateImportFacts(plan).name });
        } else {
          setMessage(result.error?.message ?? t("templatesCatalog.incompleteImport"));
        }
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
          <button
            type="button"
            class="btn"
            disabled={applying()}
            onClick={() => fileInput?.click()}
          >
            <Icon name="import" /> {t("templatesCatalog.importButton")}
          </button>
        }
      >
        <IconButton
          icon="import"
          label={t("templatesCatalog.importButton")}
          disabled={applying()}
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
        disabled={applying()}
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
            if (!applying()) {
              reset();
            }
          }}
        >
          <div class="oc-dialog template-import-dialog">
            <DialogHeader
              title={t("templatesCatalog.importTitle")}
              actions={
                <Show when={!installed() && (reviewing() || review() || canChooseAgain())}>
                  <openclaw-tooltip
                    prop:content={t("templatesCatalog.chooseAnotherArchive") + ": " + filename()}
                  >
                    <button
                      type="button"
                      class="btn template-import-file"
                      aria-label={t("templatesCatalog.chooseAnotherArchive")}
                      aria-describedby={filenameId}
                      disabled={applying()}
                      onClick={() => fileInput?.click()}
                    >
                      <Icon name="fileText" />
                      <span id={filenameId} title={filename()}>
                        {filename()}
                      </span>
                    </button>
                  </openclaw-tooltip>
                </Show>
              }
              closeDisabled={applying()}
              onClose={reset}
            />
            <div
              class="oc-dialog__body"
              ref={(element) => (scrollBody = element)}
              onScroll={updateScrollFades}
            >
              <div class="template-import-content" ref={(element) => (scrollContent = element)}>
                <Show when={reviewing()}>
                  <div class="template-import-review" aria-hidden="true">
                    <div class="template-import-identity">
                      <span class="agents-home__template-art skeleton" />
                      <div class="template-import-identity__text template-import-skeleton">
                        <span class="skeleton skeleton-line" style={{ width: "148px" }} />
                        <span class="skeleton skeleton-line" style={{ width: "220px" }} />
                      </div>
                    </div>
                    <div class="template-import-surface template-import-skeleton-rows">
                      <For each={[132, 64, 118]}>
                        {(width) => (
                          <div class="template-import-skeleton">
                            <span class="skeleton skeleton-line" style={{ width: width + "px" }} />
                            <span
                              class="skeleton skeleton-line"
                              style={{ width: width + 48 + "px" }}
                            />
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
                <Show when={installed()}>
                  {(done) => (
                    <div class="template-import-identity template-import-result">
                      <span class="agents-home__template-art" aria-hidden="true">
                        <Icon name="check" />
                      </span>
                      <div class="template-import-identity__text">
                        <h3>{done().name}</h3>
                        <span role="status">
                          {t("templatesCatalog.installedAgent", { agentId: done().agentId })}
                        </span>
                      </div>
                    </div>
                  )}
                </Show>
                <Show when={message()}>
                  <InlineAlert tone="danger" role="alert">
                    {message()}
                  </InlineAlert>
                </Show>
                <Show when={review()}>
                  {(plan) => (
                    <>
                      <TemplateImportReview plan={plan()} />
                      <div id={consentId} class="template-import-consent">
                        <TemplatePackageConsent plan={plan()} />
                      </div>
                      <Show when={plan().blockers.length}>
                        <InlineAlert tone="danger" role="alert">
                          <ul>
                            <For each={plan().blockers}>{(item) => <li>{item.message}</li>}</For>
                          </ul>
                        </InlineAlert>
                      </Show>
                    </>
                  )}
                </Show>
              </div>
            </div>
            <div class="oc-dialog__footer template-import-footer">
              <Show when={reviewing()}>
                <p class="template-import-trust">
                  <span role="status" class="text-shimmer">
                    {t("templatesCatalog.reviewingArchive")}
                  </span>
                </p>
              </Show>
              <Show when={review()}>
                <p class="template-import-trust">
                  <Icon name="alertTriangle" />
                  <span>
                    <span id={trustId}>{t("templatesCatalog.importTrust")}</span>
                    <Show when={review()?.riskAcknowledgementRequired}>
                      {" "}
                      <span id={acknowledgementId}>
                        {t("templatesCatalog.importRiskAcknowledgement")}
                      </span>
                    </Show>
                  </span>
                </p>
              </Show>
              <openclaw-modal-actions>
                <button type="button" class="btn" disabled={applying()} onClick={reset}>
                  {t(review() || reviewing() ? "common.cancel" : "common.close")}
                </button>
                <Show when={canChooseAgain()}>
                  <button type="button" class="btn primary" onClick={() => fileInput?.click()}>
                    {t("templatesCatalog.chooseAnotherArchive")}
                  </button>
                </Show>
                <Show when={installed()}>
                  <button
                    type="button"
                    class="btn primary"
                    disabled={opening()}
                    onClick={() => void openChat()}
                  >
                    {t("templatesCatalog.openChat")}
                  </button>
                </Show>
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
