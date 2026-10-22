import type { JSX } from "@solidjs/web";
import {
  createMemo,
  createProjection,
  createSignal,
  Errored,
  isPending,
  latest,
  Loading,
  onCleanup,
  Show,
} from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry, ModelCatalogResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { providerDisplayLabel } from "../../components/provider-icon-data.ts";
import { ModelPicker } from "../../components/solid/model-picker.tsx";
import { chatModelUnavailableMessage } from "../../lib/chat/model-select-state.ts";
import {
  loadModelCatalog,
  modelCatalogRefreshError,
  readModelCatalog,
  subscribeModelCatalogCache,
  subscribeModelCatalogChanges,
} from "../../lib/model-catalog-store.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { readSessionDefaults } from "../../lib/sessions/session-key.ts";
import type { captureModelSetupConnection } from "./first-run-setup.ts";
import { createModelSetupSaving } from "./model-setup-saving.ts";
import { formatModelSetupError } from "./model-setup-task-result.ts";

type NativeModelSetupOptions = {
  getContext: () => ApplicationContext;
  getConnection: () => ReturnType<typeof captureModelSetupConnection> | null;
  canUseSetup: (client: GatewayBrowserClient | null) => boolean;
  blocked: () => boolean;
  onSelected: () => void;
  onChange: () => void;
};

export type NativeModelSetup = ReturnType<typeof createNativeModelSetup>;

type NativeCatalogRequest = {
  client: GatewayBrowserClient;
  scope: { view: "all"; agentId?: string };
  result: Promise<ModelCatalogResult>;
};

export function createNativeModelSetup(options: NativeModelSetupOptions) {
  const catalog = projectSource<NativeCatalogRequest | null, ReturnType<typeof readModelCatalog>>(
    null,
    {
      read: (source) => readModelCatalog(source?.client, source?.scope),
      subscribe: (source, notify) =>
        source ? subscribeModelCatalogCache(source.client, notify, () => source.scope) : () => {},
      equality: "revision",
    },
  );
  const readNativeModels = () =>
    catalog
      .read()
      .models.filter((model) => model.agentRuntime && model.agentRuntime.id !== "openclaw");
  const nativeModels = createProjection(readNativeModels, [], {
    key: (model: ModelCatalogEntry) => `${model.provider}/${model.id}`,
  });
  // A removed choice stays cleared if a later catalog reintroduces the model.
  const [nativeModel, setNativeModel] = createSignal<string>((previous = "") =>
    nativeModels.some((model) => `${model.provider}/${model.id}` === previous) ? previous : "",
  );
  const [nativeMutation, setNativeMutation] = createSignal<{ completion: Promise<null> }>();
  const saving = createModelSetupSaving(options.getConnection);
  const [request, setRequest] = createSignal<NativeCatalogRequest | null>(null);
  let generation = 0;
  let mutationActive = false;
  let nativeModelsAbort: AbortController | null = null;
  let nativeModelsUnsubscribe: (() => void) | null = null;
  const result = createMemo<ModelCatalogResult>(
    () => request()?.result ?? Promise.resolve({ models: [] }),
  );

  function reset() {
    saving.retire();
    generation += 1;
    mutationActive = false;
    catalog.replaceSource(null);
    setRequest(null);
    setNativeModel("");
    setNativeMutation(undefined);
    nativeModelsAbort?.abort();
    nativeModelsAbort = null;
    nativeModelsUnsubscribe?.();
    nativeModelsUnsubscribe = null;
  }
  function useNativeModel(): void {
    const connection = options.getConnection();
    const requestGeneration = generation;
    const isCurrent = () =>
      generation === requestGeneration && options.getConnection() === connection;
    const context = options.getContext();
    const client = context.gateway.snapshot.client;
    const agentId =
      connection?.agentId ?? readSessionDefaults(context.gateway.snapshot)?.defaultAgentId;
    const model = readNativeModels().find(
      (entry) => `${entry.provider}/${entry.id}` === nativeModel(),
    );
    if (
      !options.canUseSetup(client) ||
      !agentId ||
      model?.available !== true ||
      mutationActive ||
      options.blocked()
    ) {
      return;
    }
    mutationActive = true;
    options.onChange();
    const modelRef = `${model.provider}/${model.id}`;
    const pending = (async () => {
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
        const outcome = mutation.ok ? mutation.refresh : mutation;
        if (!outcome.ok) {
          throw new Error(outcome.error);
        }
        await context.agents.refreshList();
        if (isCurrent()) {
          options.onSelected();
        }
      } catch (error) {
        if (isCurrent()) {
          throw error;
        }
      } finally {
        if (isCurrent()) {
          mutationActive = false;
          options.onChange();
        }
      }
    })();
    const completion = saving.present(pending, isCurrent).then(() => null);
    // The error boundary observes this completion; a retired view may no longer read it.
    void completion.catch(() => {});
    setNativeMutation({ completion });
  }

  function loadNativeModels(refresh: boolean): void {
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
    nativeModelsUnsubscribe ??= subscribeModelCatalogChanges(
      context.gateway,
      () => loadNativeModels(false),
      scope,
    );
    nativeModelsAbort?.abort();
    const controller = new AbortController();
    nativeModelsAbort = controller;
    const completion = loadModelCatalog(client, {
      ...scope,
      refresh,
      signal: controller.signal,
    }).finally(() => {
      if (nativeModelsAbort === controller) {
        nativeModelsAbort = null;
      }
    });
    // Scope retirement may discard the receipt before its async reader observes it.
    void completion.catch(() => {});
    const read = { client, scope, result: completion };
    catalog.replaceSource(read);
    setRequest(read);
  }

  // open() admits resources synchronously, including before the first settle.
  onCleanup(() => {
    saving.retire();
    generation += 1;
    nativeModelsAbort?.abort();
    nativeModelsUnsubscribe?.();
  });
  return {
    reset,
    models: () => nativeModels,
    selected: nativeModel,
    mutation: nativeMutation,
    catalogPending: () => Boolean(catalog.read().pendingProviders?.length),
    result,
    request,
    setSelected: setNativeModel,
    blocked: options.blocked,
    useModel: () => useNativeModel(),
    retry: () => loadNativeModels(true),
    open: () => {
      if (!nativeModelsAbort) {
        loadNativeModels(request() === null);
      }
    },
    get count() {
      return nativeModels.length;
    },
    get saving() {
      return saving.saving() || mutationActive;
    },
    get active() {
      return mutationActive;
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
            (props.owner.catalogPending() && model.available === undefined
              ? t("modelSetup.nativeModels.loading")
              : model.available === false
                ? t("chat.modelControls.modelsUnavailable")
                : t("modelSetup.nativeModels.unconfirmed"))),
      disabled: model.available !== true,
    })),
  );
  // Only status regions wait; cached picker controls stay interactive during refresh.
  return renderNativeModelSetupSection(
    <>
      <Errored
        fallback={() => (
          <>
            {isPending(() => props.owner.result()) ? (
              <p role="status">{t("modelSetup.nativeModels.loading")}</p>
            ) : undefined}
          </>
        )}
      >
        <Loading
          on={props.owner.request()}
          fallback={<p role="status">{t("modelSetup.nativeModels.loading")}</p>}
        >
          <NativeCatalogStatus owner={props.owner} />
        </Loading>
      </Errored>
      <ModelPicker
        label={t("modelSetup.nativeModels.choose")}
        value={props.owner.selected()}
        options={pickerOptions()}
        disabled={props.owner.saving || props.owner.blocked()}
        onChange={(value) => props.owner.setSelected(value)}
        onOpen={() => props.owner.open()}
      />
      <button
        class="btn primary"
        disabled={props.owner.saving || props.owner.blocked() || selected()?.available !== true}
        onClick={() => props.owner.useModel()}
      >
        {t(props.owner.saving ? "modelSetup.nativeModels.saving" : "modelSetup.nativeModels.use")}
      </button>
      <Show when={props.owner.mutation()} keyed>
        {(mutation) => <NativeModelMutationStatus completion={mutation.completion} />}
      </Show>
      <Errored
        fallback={(error) => (
          <NativeCatalogError
            owner={props.owner}
            message={isPending(() => props.owner.result()) ? null : formatModelSetupError(error())}
          />
        )}
      >
        <Loading on={props.owner.request()}>
          <NativeCatalogError
            owner={props.owner}
            message={modelCatalogRefreshError(latest(() => props.owner.result()))}
          />
        </Loading>
      </Errored>
    </>,
  );
}

function NativeCatalogStatus(props: { owner: NativeModelSetup }) {
  return (
    <>
      {isPending(() => props.owner.result()) || props.owner.result().pendingProviders?.length ? (
        <p role="status">{t("modelSetup.nativeModels.loading")}</p>
      ) : props.owner.request() &&
        props.owner.models().length === 0 &&
        !modelCatalogRefreshError(props.owner.result()) ? (
        <p role="status">{t("modelSetup.nativeModels.empty")}</p>
      ) : undefined}
    </>
  );
}

function NativeCatalogError(props: { owner: NativeModelSetup; message: string | null }) {
  return (
    <>
      {props.message ? (
        <div class="callout danger" role="alert">
          {props.message}
          <button
            class="btn btn--sm"
            type="button"
            disabled={props.owner.saving || props.owner.blocked()}
            onClick={() => props.owner.retry()}
          >
            {t("common.retry")}
          </button>
        </div>
      ) : undefined}
    </>
  );
}

function NativeModelMutationStatus(props: { completion: Promise<null> }) {
  const completion = createMemo(() => props.completion);
  return (
    <Errored
      fallback={(error) => (
        <div class="callout danger" role="alert">
          {formatModelSetupError(error())}
        </div>
      )}
    >
      <Loading>{completion()}</Loading>
    </Errored>
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
