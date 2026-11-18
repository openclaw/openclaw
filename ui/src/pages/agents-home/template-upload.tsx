import { createSignal, For, Show } from "solid-js";
import { MAX_TEMPLATE_UPLOAD_ARCHIVE_BYTES } from "../../../../packages/gateway-protocol/src/template-source-limits.js";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import "../../components/modal-dialog.tsx";
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
import { readTemplatePackagePreview } from "../templates/template-package-preview.ts";
import { openTemplateAgentChat } from "./template-agent-chat.ts";
import { TemplateArtwork } from "./template-artwork.tsx";
import { templateImportFacts } from "./template-import-facts.ts";
import { TemplateImportReview } from "./template-import-review.tsx";
import { templatePackageConsents } from "./template-package-consent.tsx";
import {
  applyTemplateUpload,
  readTemplateAddReviewPlan,
  type TemplateAddReviewPlan,
  type TemplateUploadSource,
} from "./templates-catalog-client.ts";

export function TemplateUpload() {
  const context = useApplication();
  let fileInput: HTMLInputElement | undefined;
  const [filename, setFilename] = createSignal("");
  const [review, setReview] = createSignal<TemplateAddReviewPlan | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [installed, setInstalled] = createSignal<{ agentId: string; name: string } | null>(null);
  // Only a failed review may pick again; an uncertain apply must not invite a blind retry.
  const [canChooseAgain, setCanChooseAgain] = createSignal(false);
  const [opening, setOpening] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  let confirmation: AbortController | undefined;
  const reviewing = () => busy() && !review();
  const applying = () => (busy() && Boolean(review())) || opening() || confirming();
  // Keep archive bytes only for this selection's review/apply, never in persisted UI state.
  let source: TemplateUploadSource | undefined;
  let generation = 0;
  function reset() {
    generation += 1;
    confirmation?.abort();
    confirmation = undefined;
    setConfirming(false);
    source = undefined;
    setFilename("");
    setReview(null);
    setBusy(false);
    setMessage("");
    setInstalled(null);
    setCanChooseAgain(false);
    setOpening(false);
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
        if (plan.blockers.length) {
          setMessage(plan.blockers.map((blocker) => blocker.message).join("\n"));
          setCanChooseAgain(true);
        } else {
          source = upload;
          setReview(plan);
        }
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
    if (
      !scope ||
      !plan ||
      !upload ||
      busy() ||
      confirmation ||
      !canUpload() ||
      plan.blockers.length
    ) {
      return;
    }
    setMessage("");
    let submitted = false;
    try {
      const consents = templatePackageConsents(plan);
      if (consents.length || plan.riskAcknowledgementRequired) {
        const controller = new AbortController();
        confirmation = controller;
        setConfirming(true);
        try {
          const accepted = await showConfirmDialog({
            title: t("templatesCatalog.importConfirmTitle", {
              name: templateImportFacts(plan).name,
            }),
            message:
              plan.riskAcknowledgementRequired && plan.trustWarning
                ? plan.trustWarning
                : t("templatesCatalog.importConfirmMessage"),
            details: consents
              .map((item) => [item.label, ...item.grants, item.warning].filter(Boolean).join("\n"))
              .join("\n\n"),
            confirmLabel: t("templatesCatalog.importButton"),
            requiredAcknowledgement: t("templatesCatalog.importConfirmAcknowledgement"),
            signal: controller.signal,
            canConfirm: () =>
              gateway.isCurrent(scope) &&
              current === generation &&
              review() === plan &&
              canUpload(),
          });
          if (!accepted) {
            return;
          }
        } finally {
          if (confirmation === controller) {
            confirmation = undefined;
            setConfirming(false);
          }
        }
      }
      if (
        !gateway.isCurrent(scope) ||
        current !== generation ||
        review() !== plan ||
        !canUpload()
      ) {
        return;
      }
      setBusy(true);
      submitted = true;
      const result = await applyTemplateUpload(scope.client, upload, plan);
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
        // Only a failed confirmation may reselect; a submitted apply can be uncertain.
        source = undefined;
        setReview(null);
        setCanChooseAgain(!submitted);
        setMessage(formatUiError(error));
      }
    } finally {
      if (gateway.isCurrent(scope) && current === generation) {
        setBusy(false);
      }
    }
  }
  async function readPackagePreview(
    item: import("@openclaw/gateway-protocol").TemplateDraftReviewItem,
  ) {
    const scope = gateway.capture();
    const plan = review();
    const current = generation;
    if (!scope || !plan) {
      return null;
    }
    const preview = await readTemplatePackagePreview(scope.client, plan.reviewFiles, item);
    return gateway.isCurrent(scope) && current === generation ? preview : null;
  }
  function ImportActions() {
    return (
      <>
        <Show when={reviewing()}>
          <p role="status" class="text-shimmer">
            {t("templatesCatalog.reviewingArchive")}
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
              aria-label={t(
                busy() ? "templatesCatalog.importingArchive" : "templatesCatalog.importButton",
              )}
              aria-busy={busy() ? "true" : undefined}
              disabled={applying() || Boolean(review()?.blockers.length)}
              onClick={() => void install()}
            >
              <Show when={busy()}>
                <span class="btn__spinner" aria-hidden="true" />
              </Show>
              <span role="status">
                {t(busy() ? "templatesCatalog.importingArchive" : "templatesCatalog.importButton")}
              </span>
            </button>
          </Show>
        </openclaw-modal-actions>
      </>
    );
  }
  return (
    <Show when={canUpload()}>
      <FloatingHeaderActions
        fallback={
          <button
            type="button"
            class="btn btn--sm btn--ghost"
            disabled={applying()}
            onClick={() => fileInput?.click()}
          >
            <Icon name="plus" /> {t("templatesCatalog.importButton")}
          </button>
        }
      >
        <IconButton
          icon="plus"
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
          style={{ "--openclaw-modal-width": "620px" }}
          onModal-cancel={(event: Event) => {
            event.preventDefault();
            if (!applying()) {
              reset();
            }
          }}
        >
          <div class="template-import-dialog">
            <Show
              when={review()}
              fallback={
                <section class="template-package-preview template-creator">
                  <header class="template-creator__header">
                    <span class="template-package-art">
                      <TemplateArtwork />
                    </span>
                    <h2>{installed()?.name ?? t("templatesCatalog.importTitle")}</h2>
                  </header>
                  <div class="template-creator__body">
                    <Show when={reviewing()}>
                      <div
                        class="template-import-skeleton templates-content-skeleton"
                        aria-hidden="true"
                      >
                        <For each={[1, 2, 3]}>
                          {() => <span class="skeleton templates-content-skeleton__row" />}
                        </For>
                      </div>
                    </Show>
                    <Show when={installed()}>
                      {(done) => (
                        <p role="status">
                          {t("templatesCatalog.installedAgent", { agentId: done().agentId })}
                        </p>
                      )}
                    </Show>
                    <Show when={message()}>
                      <InlineAlert tone="danger" role="alert">
                        {message()}
                      </InlineAlert>
                    </Show>
                  </div>
                  <footer class="template-creator__footer">
                    <ImportActions />
                  </footer>
                </section>
              }
            >
              {(plan) => (
                <TemplateImportReview
                  plan={plan()}
                  readPackagePreview={readPackagePreview}
                  footer={<ImportActions />}
                />
              )}
            </Show>
          </div>
        </openclaw-modal-dialog>
      </Show>
    </Show>
  );
}
