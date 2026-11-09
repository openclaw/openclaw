import { createSignal, For, Show } from "solid-js";
import { MAX_TEMPLATE_UPLOAD_ARCHIVE_BYTES } from "../../../../packages/gateway-protocol/src/template-source-limits.js";
import { readBlobAsDataUrl } from "../../lib/blob-data-url.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  applyTemplateAdd,
  readTemplateAddReviewPlan,
  type TemplateAddReviewPlan,
  type TemplateUploadSource,
} from "./templates-catalog-client.ts";
import { ReviewWarning, TemplatePlanDisclosures } from "./templates-detail-view.tsx";

export function TemplateUpload() {
  const context = useApplication();
  const [review, setReview] = createSignal<TemplateAddReviewPlan | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  // Keep archive bytes only for this selection's review/apply, never in persisted UI state.
  let source: TemplateUploadSource | undefined;
  let generation = 0;
  function reset() {
    generation += 1;
    source = undefined;
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
      <section class="oc-card" aria-label={t("templatesCatalog.importTitle")}>
        <h3>{t("templatesCatalog.importTitle")}</h3>
        <p>{t("templatesCatalog.importDescription")}</p>
        <input
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
        <Show when={busy()}>
          <p role="status">{t("templatesCatalog.processingArchive")}</p>
        </Show>
        <Show when={message()}>
          <p role="status">{message()}</p>
        </Show>
        <Show when={review()}>
          {(plan) => (
            <div>
              <p>{plan().trustWarning}</p>
              <p>{t("templatesCatalog.importAgent", { agentId: plan().target.agentId ?? "—" })}</p>
              <code>{plan().planIntegrity}</code>
              <Show
                when={plan().blockers.length}
                fallback={
                  <ReviewWarning
                    view={{
                      reviewPlan: plan(),
                      applying: busy(),
                      onConfirmReview: install,
                      onCancelReview: reset,
                    }}
                  />
                }
              >
                <TemplatePlanDisclosures plan={plan()} />
                <ul>
                  <For each={plan().blockers}>{(item) => <li>{item.message}</li>}</For>
                </ul>
                <button type="button" class="btn" disabled={busy()} onClick={reset}>
                  {t("common.cancel")}
                </button>
              </Show>
            </div>
          )}
        </Show>
      </section>
    </Show>
  );
}
