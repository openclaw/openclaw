import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, createStore, onCleanup, reconcile } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry, ModelCatalogResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { providerDisplayLabel } from "../../components/provider-icon-data.ts";
import { ModelPicker } from "../../components/solid/model-picker.tsx";
import { chatModelUnavailableMessage } from "../../lib/chat/model-select-state.ts";
import {
  loadModelCatalog,
  modelCatalogRefreshError,
  peekModelCatalog,
  subscribeModelCatalogChanges,
} from "../../lib/model-catalog-store.ts";
import { t } from "../../lib/reactive/i18n.ts";
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

export type NativeModelSetup = ReturnType<typeof createNativeModelSetup>;

export function createNativeModelSetup(options: NativeModelSetupOptions) {
  const [nativeModels, setNativeModels] = createStore<ModelCatalogEntry[]>([]);
  const [nativeModel, setNativeModel] = createSignal("");
  const [nativeModelError, setNativeModelError] = createSignal<string | null>(null);
  const [nativeCatalogError, setNativeCatalogError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [requestPending, setRequestPending] = createSignal(false);
  let generation = 0;
  let nativeModelsAbort: AbortController | null = null;
  let nativeModelsUnsubscribe: (() => void) | null = null;
  const [nativeModelsStatus, setNativeModelsStatus] = createSignal<"idle" | "loading" | "ready">(
    "idle",
  );

  function reset() {
    generation += 1;
    setNativeModels((models) => {
      models.length = 0;
    });
    setNativeModel("");
    setNativeModelError(null);
    setNativeCatalogError(null);
    setSaving(false);
    setRequestPending(false);
    nativeModelsAbort?.abort();
    nativeModelsAbort = null;
    nativeModelsUnsubscribe?.();
    nativeModelsUnsubscribe = null;
    setNativeModelsStatus("idle");
  }
  async function useNativeModel(): Promise<void> {
    const connection = options.getConnection();
    const requestGeneration = generation;
    const isCurrent = () =>
      generation === requestGeneration && options.getConnection() === connection;
    const context = options.getContext();
    const client = context.gateway.snapshot.client;
    const agentId =
      connection?.agentId ?? readSessionDefaults(context.gateway.snapshot)?.defaultAgentId;
    const model = nativeModels.find((entry) => `${entry.provider}/${entry.id}` === nativeModel());
    if (
      !options.canUseSetup(client) ||
      !agentId ||
      model?.available !== true ||
      saving() ||
      options.blocked()
    ) {
      return;
    }
    setSaving(true);
    setNativeModelError(null);
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
          canDispatch: () => isCurrent() && options.canUseSetup(client),
        },
      );
      if (!isCurrent()) {
        return;
      }
      const result = mutation.ok ? mutation.refresh : mutation;
      if (!result.ok) {
        setNativeModelError(result.error);
        return;
      }
      await context.agents.refreshList();
      if (isCurrent()) {
        options.onSelected();
      }
    } catch (error) {
      if (isCurrent()) {
        setNativeModelError(formatModelSetupError(error));
      }
    } finally {
      if (isCurrent()) {
        setSaving(false);
      }
    }
  }

  function applyNativeCatalog(catalog: ModelCatalogResult): void {
    const models = catalog.models.filter(
      (model) => model.agentRuntime && model.agentRuntime.id !== "openclaw",
    );
    setNativeModels(
      reconcile(models, (model: ModelCatalogEntry) => `${model.provider}/${model.id}`),
    );
    setNativeModelsStatus(catalog.pendingProviders?.length ? "loading" : "ready");
    setNativeCatalogError(modelCatalogRefreshError(catalog));
    if (!models.some((model) => `${model.provider}/${model.id}` === nativeModel())) {
      setNativeModel("");
    }
  }

  async function loadNativeModels(refresh: boolean): Promise<void> {
    const connection = options.getConnection();
    const context = options.getContext();
    const client = context.gateway.snapshot.client;
    if (!client || !options.canUseSetup(client)) {
      return;
    }
    const scope = {
      view: "all" as const,
      agentId: connection?.agentId ?? undefined,
    };
    const cached = peekModelCatalog(client, scope, { allowStale: true });
    if (cached) {
      applyNativeCatalog(cached);
    }
    nativeModelsUnsubscribe ??= subscribeModelCatalogChanges(
      context.gateway,
      () => void loadNativeModels(false),
      scope,
    );
    nativeModelsAbort?.abort();
    const controller = new AbortController();
    nativeModelsAbort = controller;
    setRequestPending(true);
    if (refresh) {
      setNativeCatalogError(null);
    }
    setNativeModelsStatus("loading");
    try {
      const catalog = await loadModelCatalog(client, {
        ...scope,
        refresh,
        signal: controller.signal,
      });
      if (options.getConnection() !== connection || controller.signal.aborted) {
        return;
      }
      applyNativeCatalog(catalog);
    } catch (error) {
      if (options.getConnection() === connection && !controller.signal.aborted) {
        setNativeModelsStatus("ready");
        setNativeCatalogError(formatModelSetupError(error));
      }
    } finally {
      if (nativeModelsAbort === controller) {
        nativeModelsAbort = null;
        setRequestPending(false);
      }
    }
  }

  onCleanup(() => {
    generation += 1;
    nativeModelsAbort?.abort();
    nativeModelsUnsubscribe?.();
  });
  return {
    reset,
    models: () => nativeModels,
    selected: nativeModel,
    modelError: nativeModelError,
    catalogError: nativeCatalogError,
    catalogStatus: nativeModelsStatus,
    setSelected: setNativeModel,
    blocked: options.blocked,
    useModel: () => void useNativeModel(),
    retry: () => void loadNativeModels(true),
    open: () => {
      if (!nativeModelsAbort) {
        void loadNativeModels(nativeModelsStatus() === "idle");
      }
    },
    loading: requestPending,
    get count() {
      return nativeModels.length;
    },
    get saving() {
      return saving();
    },
  };
}

export function NativeModelSetupView(props: { owner: NativeModelSetup }) {
  const selected = () =>
    props.owner
      .models()
      .find((model) => `${model.provider}/${model.id}` === props.owner.selected());
  const pickerOptions = createMemo(() =>
    props.owner.models().map((model) => ({
      value: `${model.provider}/${model.id}`,
      label: model.name,
      provider: model.provider,
      detail:
        model.available === true
          ? providerDisplayLabel(model.provider)
          : (chatModelUnavailableMessage(model.unavailableReason) ??
            (props.owner.catalogStatus() === "loading" && model.available === undefined
              ? t("modelSetup.nativeModels.loading")
              : model.available === false
                ? t("chat.modelControls.modelsUnavailable")
                : t("modelSetup.nativeModels.unconfirmed"))),
      disabled: model.available !== true,
    })),
  );
  return renderNativeModelSetupSection(
    <>
      {props.owner.catalogStatus() === "loading" ? (
        <p role="status">{t("modelSetup.nativeModels.loading")}</p>
      ) : undefined}
      {props.owner.catalogStatus() === "ready" &&
      props.owner.models().length === 0 &&
      !props.owner.catalogError() ? (
        <p role="status">{t("modelSetup.nativeModels.empty")}</p>
      ) : undefined}
      <ModelPicker
        label={t("modelSetup.nativeModels.choose")}
        value={props.owner.selected()}
        options={pickerOptions()}
        disabled={props.owner.blocked() || props.owner.saving}
        onChange={(value) => props.owner.setSelected(value)}
        onOpen={() => props.owner.open()}
      />
      <button
        class="btn primary"
        disabled={props.owner.blocked() || props.owner.saving || selected()?.available !== true}
        onClick={() => props.owner.useModel()}
      >
        {t(props.owner.saving ? "modelSetup.nativeModels.saving" : "modelSetup.nativeModels.use")}
      </button>
      {props.owner.modelError() ? (
        <div class="callout danger" role="alert">
          {props.owner.modelError()}
        </div>
      ) : undefined}
      {props.owner.catalogError() ? (
        <div class="callout danger" role="alert">
          {props.owner.catalogError()}
          <button
            class="btn btn--sm"
            type="button"
            disabled={props.owner.blocked() || props.owner.saving || props.owner.loading()}
            onClick={() => props.owner.retry()}
          >
            {t("common.retry")}
          </button>
        </div>
      ) : undefined}
    </>,
  );
}

function renderNativeModelSetupSection(content: JSX.Element) {
  return (
    <>
      <section class="settings-section" data-native-model-setup>
        <div class="settings-section__header">
          <h2>{t("modelSetup.nativeModels.title")}</h2>
        </div>
        <p class="muted">{t("modelSetup.nativeModels.body")}</p>
        {content}
      </section>
    </>
  );
}

export function renderNativeModelSetupLoading() {
  return renderNativeModelSetupSection(
    <>
      <div class="model-picker">
        <span class="picker-select__trigger skeleton" />
      </div>
      <span class="btn skeleton">{"\u00a0"}</span>
    </>,
  );
}
