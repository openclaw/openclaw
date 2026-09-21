import { html, nothing, type ReactiveControllerHost, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry, ModelCatalogResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { renderModelPicker } from "../../components/model-picker.ts";
import { providerDisplayLabel } from "../../components/provider-icon.ts";
import { t } from "../../i18n/index.ts";
import { chatModelUnavailableMessage } from "../../lib/chat/model-select-state.ts";
import {
  loadModelCatalog,
  modelCatalogRefreshError,
  peekModelCatalog,
  subscribeModelCatalogChanges,
} from "../../lib/model-catalog-store.ts";
import { readSessionDefaults } from "../../lib/sessions/session-key.ts";
import type { captureModelSetupConnection } from "./first-run-setup.ts";
import { formatModelSetupError } from "./model-setup-task-result.ts";

type NativeModelSetupOptions = {
  getContext: () => ApplicationContext;
  getConnection: () => ReturnType<typeof captureModelSetupConnection> | null;
  canUseSetup: (client: GatewayBrowserClient | null) => boolean;
  blocked: () => boolean;
  onSelected: () => void;
};

export class NativeModelSetup {
  private nativeModels: ModelCatalogEntry[] = [];
  private nativeModel = "";
  private nativeModelError: string | null = null;
  private nativeCatalogError: string | null = null;
  saving = false;
  private generation = 0;
  private nativeModelsAbort: AbortController | null = null;
  private nativeModelsUnsubscribe: (() => void) | null = null;
  private nativeModelsStatus: "idle" | "loading" | "ready" = "idle";

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: NativeModelSetupOptions,
  ) {}

  get count() {
    return this.nativeModels.length;
  }

  reset() {
    this.generation += 1;
    this.nativeModels = [];
    this.nativeModel = "";
    this.nativeModelError = null;
    this.nativeCatalogError = null;
    this.saving = false;
    this.nativeModelsAbort?.abort();
    this.nativeModelsAbort = null;
    this.nativeModelsUnsubscribe?.();
    this.nativeModelsUnsubscribe = null;
    this.nativeModelsStatus = "idle";
  }
  private async useNativeModel(): Promise<void> {
    const connection = this.options.getConnection();
    const generation = this.generation;
    const isCurrent = () =>
      this.generation === generation && this.options.getConnection() === connection;
    const context = this.options.getContext();
    const client = context.gateway.snapshot.client;
    const agentId =
      connection?.agentId ?? readSessionDefaults(context.gateway.snapshot)?.defaultAgentId;
    const model = this.nativeModels.find(
      (entry) => `${entry.provider}/${entry.id}` === this.nativeModel,
    );
    if (
      !this.options.canUseSetup(client) ||
      !agentId ||
      model?.available !== true ||
      this.saving ||
      this.options.blocked()
    ) {
      return;
    }
    this.saving = true;
    this.host.requestUpdate();
    this.nativeModelError = null;
    const modelRef = `${model.provider}/${model.id}`;
    try {
      const mutation = await context.runtimeConfig.runExternalMutation(
        (mutationClient) =>
          mutationClient.request("agents.update", {
            agentId,
            model: modelRef,
            agentRuntime: model.agentRuntime?.id,
          }),
        {
          canDispatch: () => isCurrent() && this.options.canUseSetup(client),
        },
      );
      if (!isCurrent()) {
        return;
      }
      if (!mutation.ok) {
        this.nativeModelError = mutation.error;
        return;
      }
      if (!mutation.refresh.ok) {
        this.nativeModelError = mutation.refresh.error;
        return;
      }
      await context.agents.refreshList();
      if (isCurrent()) {
        this.options.onSelected();
      }
    } catch (error) {
      if (isCurrent()) {
        this.nativeModelError = formatModelSetupError(error);
      }
    } finally {
      if (isCurrent()) {
        this.saving = false;
        this.host.requestUpdate();
      }
    }
  }

  private applyNativeCatalog(catalog: ModelCatalogResult): void {
    this.nativeModels = catalog.models.filter(
      (model) => model.agentRuntime && model.agentRuntime.id !== "openclaw",
    );
    this.nativeModelsStatus = catalog.pendingProviders?.length ? "loading" : "ready";
    this.nativeCatalogError = modelCatalogRefreshError(catalog);
    if (!this.nativeModels.some((model) => `${model.provider}/${model.id}` === this.nativeModel)) {
      this.nativeModel = "";
    }
  }

  private async loadNativeModels(refresh = true): Promise<void> {
    const connection = this.options.getConnection();
    const context = this.options.getContext();
    const client = context.gateway.snapshot.client;
    if (!client || !this.options.canUseSetup(client)) {
      return;
    }
    const scope = {
      view: "all" as const,
      agentId: connection?.agentId ?? undefined,
    };
    const cached = peekModelCatalog(client, scope, { allowStale: true });
    if (cached) {
      this.applyNativeCatalog(cached);
    }
    this.nativeModelsUnsubscribe ??= subscribeModelCatalogChanges(
      context.gateway,
      () => void this.loadNativeModels(false),
      scope,
    );
    this.nativeModelsAbort?.abort();
    const controller = new AbortController();
    this.nativeModelsAbort = controller;
    if (refresh) {
      this.nativeCatalogError = null;
    }
    this.nativeModelsStatus = "loading";
    this.host.requestUpdate();
    try {
      const catalog = await loadModelCatalog(client, {
        ...scope,
        refresh,
        signal: controller.signal,
      });
      if (this.options.getConnection() !== connection || controller.signal.aborted) {
        return;
      }
      this.applyNativeCatalog(catalog);
    } catch (error) {
      if (this.options.getConnection() === connection && !controller.signal.aborted) {
        this.nativeModelsStatus = "ready";
        this.nativeCatalogError = formatModelSetupError(error);
      }
    } finally {
      if (this.nativeModelsAbort === controller) {
        this.nativeModelsAbort = null;
        this.host.requestUpdate();
      }
    }
  }

  render() {
    const models = this.nativeModels;
    const selected = models.find((model) => `${model.provider}/${model.id}` === this.nativeModel);
    return renderNativeModelSetupSection(html`
      ${this.nativeModelsStatus === "loading" ? html`<p role="status">${t("modelSetup.nativeModels.loading")}</p>` : nothing}
      ${this.nativeModelsStatus === "ready" && models.length === 0 && !this.nativeCatalogError ? html`<p role="status">${t("modelSetup.nativeModels.empty")}</p>` : nothing}
      ${renderModelPicker({
        label: t("modelSetup.nativeModels.choose"),
        value: this.nativeModel,
        options: models.map((model) => ({
          value: `${model.provider}/${model.id}`,
          label: model.name,
          provider: model.provider,
          detail:
            model.available === true
              ? providerDisplayLabel(model.provider)
              : (chatModelUnavailableMessage(model.unavailableReason) ??
                (this.nativeModelsStatus === "loading" && model.available === undefined
                  ? t("modelSetup.nativeModels.loading")
                  : model.available === false
                    ? t("chat.modelControls.modelsUnavailable")
                    : t("modelSetup.nativeModels.unconfirmed"))),
          disabled: model.available !== true,
        })),
        disabled: this.options.blocked() || this.saving,
        onChange: (value) => {
          this.nativeModel = value;
          this.host.requestUpdate();
        },
        onOpen: () => {
          if (!this.nativeModelsAbort) {
            void this.loadNativeModels(this.nativeModelsStatus === "idle");
          }
        },
      })}
      <button
        class="btn primary"
        ?disabled=${this.options.blocked() || this.saving || selected?.available !== true}
        @click=${() => void this.useNativeModel()}
      >
        ${t(this.saving ? "modelSetup.nativeModels.saving" : "modelSetup.nativeModels.use")}
      </button>
      ${this.nativeModelError ? html`<div class="callout danger" role="alert">${this.nativeModelError}</div>` : nothing}
      ${
        this.nativeCatalogError
          ? html`
              <div class="callout danger" role="alert">
                ${this.nativeCatalogError}
                <button
                  class="btn btn--sm"
                  type="button"
                  ?disabled=${this.options.blocked() || this.saving || this.nativeModelsAbort !== null}
                  @click=${() => void this.loadNativeModels(true)}
                >
                  ${t("common.retry")}
                </button>
              </div>
            `
          : nothing
      }
    `);
  }
}

function renderNativeModelSetupSection(content: TemplateResult) {
  return html`
    <section class="settings-section" data-native-model-setup>
      <div class="settings-section__header"><h2>${t("modelSetup.nativeModels.title")}</h2></div>
      <p class="muted">${t("modelSetup.nativeModels.body")}</p>
      ${content}
    </section>
  `;
}

export function renderNativeModelSetupLoading() {
  return renderNativeModelSetupSection(html`
    <div class="model-picker"><span class="picker-select__trigger skeleton"></span></div>
    <span class="btn skeleton">${"\u00a0"}</span>
  `);
}
