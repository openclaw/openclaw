import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, createSignal, For, Show } from "solid-js";
import { isBuiltInModelProviderOverlayId } from "../../../../src/config/model-provider-overlay-ids.js";
import {
  CUSTOM_ENDPOINT_APIS,
  customEndpointModelInputs,
  type CustomEndpointModelEdits,
  type CustomEndpointModelUpdate,
  type CustomEndpointApi,
  type CustomEndpointDraft,
  type CustomEndpointModel,
} from "../../../../src/shared/custom-endpoint.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { ModalDialog } from "../../components/modal-dialog.tsx";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from "../../components/solid/settings-ui.tsx";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { invalidateModelAuthStatusRequests } from "../../lib/model-auth-request-state.ts";
import { projectGateway, projectAgentSelection } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { observeState } from "../../lib/reactive/observe-state.ts";
import {
  customEndpointApi as api,
  newEndpointModel as newModel,
  readEndpointDraft as readDraft,
} from "./custom-endpoint-draft.ts";
import { EndpointModel } from "./custom-endpoint-model.tsx";

const apiLabels: Record<CustomEndpointApi, string> = {
  "openai-completions": "Chat Completions",
  "openai-responses": "Responses",
  "anthropic-messages": "Anthropic Messages",
};

type Scope = {
  client: GatewayBrowserClient;
  hello: ApplicationGatewaySnapshot["hello"];
  agentId: string;
};
export function CustomEndpoints(props: {
  onRefresh: () => Promise<void>;
  onInvalidate: (provider: string) => void;
}) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const selection = projectAgentSelection(context.settingsAgentSelection);
  const scope = createMemo(
    () => {
      const snapshot = gateway.read().snapshot;
      const agentId = selection.read().state.selectedId;
      return snapshot.phase === "connected" && snapshot.client && agentId
        ? { client: snapshot.client, hello: snapshot.hello, agentId }
        : null;
    },
    {
      equals: (a, b) =>
        a?.client === b?.client && a?.hello === b?.hello && a?.agentId === b?.agentId,
    },
  );
  return (
    <Show when={scope()} keyed>
      {(owner) => (
        <EndpointEditor
          scope={owner}
          onRefresh={() => props.onRefresh()}
          onInvalidate={(provider) => props.onInvalidate(provider)}
        />
      )}
    </Show>
  );
}

function EndpointEditor(props: {
  scope: Scope;
  onRefresh: () => Promise<void>;
  onInvalidate: (provider: string) => void;
}) {
  const context = useApplication();
  const config = projectRuntimeConfig(context.runtimeConfig);
  const providers = createMemo(
    () =>
      asNullableRecord(
        asNullableRecord(currentConfigObject(config.read().state)?.models)?.providers,
      ) ?? {},
  );
  const entries = createMemo(() =>
    Object.entries(providers()).flatMap(([provider, value]) => {
      const entry = asNullableRecord(value);
      return entry && !isBuiltInModelProviderOverlayId(provider)
        ? [{ provider, entry, baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : "" }]
        : [];
    }),
  );
  const [draft, setDraft] = createSignal<CustomEndpointDraft | null>(null);
  const [editing, setEditing] = createSignal(false);
  const [baseHash, setBaseHash] = createSignal("");
  const [key, setKey] = createSignal("");
  const [discovered, setDiscovered] = createSignal<string[]>([]);
  const [selected, setSelected] = createSignal<string[]>([]);
  // Admission is synchronous; config/credential settlement stays with the shared writer.
  const operation = observeState({ busy: false, message: "", failed: false });
  const status = operation.read;
  const isCurrent = (scope: Scope) => {
    const now = context.gateway.snapshot;
    return (
      now.phase === "connected" &&
      now.client === scope.client &&
      now.hello === scope.hello &&
      context.settingsAgentSelection.state.selectedId === scope.agentId
    );
  };
  const canManage = () =>
    hasOperatorAdminAccess(props.scope.hello?.auth ?? null) && config.read().canPatch === true;
  const disabled = () =>
    status().busy ||
    !canManage() ||
    config.read().state.configSaving ||
    config.read().state.configApplying;
  const update = (patch: Partial<CustomEndpointDraft>) =>
    setDraft((value) => (value ? { ...value, ...patch } : value));
  const editModel = (index: number, edits: CustomEndpointModelEdits) =>
    setDraft((value) =>
      value
        ? {
            ...value,
            models: value.models.map((row, i) =>
              i === index
                ? {
                    ...row,
                    ...(edits.name !== undefined ? { name: edits.name } : {}),
                    ...(edits.reasoning !== undefined ? { reasoning: edits.reasoning } : {}),
                    ...(edits.contextWindow !== undefined
                      ? { contextWindow: edits.contextWindow ?? undefined }
                      : {}),
                    ...(edits.maxTokens !== undefined
                      ? { maxTokens: edits.maxTokens ?? undefined }
                      : {}),
                    input: customEndpointModelInputs(row.input, edits),
                    edits: { ...row.edits, ...edits },
                  }
                : row,
            ),
          }
        : value,
    );
  const renameModel = (index: number, id: string) =>
    setDraft((value) =>
      value
        ? { ...value, models: value.models.map((row, i) => (i === index ? { ...row, id } : row)) }
        : value,
    );
  const begin = (provider?: string, entry?: Record<string, unknown>) => {
    setEditing(Boolean(provider));
    setBaseHash(context.runtimeConfig.state.configSnapshot?.hash ?? "");
    setDraft(
      provider && entry
        ? readDraft(provider, entry)
        : {
            provider: "",
            baseUrl: "",
            api: "openai-completions",
            noAuth: false,
            models: [newModel()],
          },
    );
    setKey("");
    setDiscovered([]);
    setSelected([]);
    operation.state.message = "";
  };
  async function run(task: (scope: Scope) => Promise<void>) {
    if (disabled()) {
      return;
    }
    const scope = props.scope;
    operation.state.busy = true;
    operation.state.message = "";
    operation.state.failed = false;
    try {
      await task(scope);
    } catch (error) {
      if (isCurrent(scope)) {
        operation.state.message = formatUiError(error);
        operation.state.failed = true;
      }
    } finally {
      if (isCurrent(scope)) {
        operation.state.busy = false;
      }
    }
  }
  async function save(scope: Scope, remove = false) {
    const value = draft();
    if (!value) {
      return;
    }
    const apiKey = key().trim();
    const revision = baseHash();
    const action = remove ? "delete" : editing() ? "edit" : "create";
    if (
      remove &&
      !(await showConfirmDialog({
        title: t("modelProviders.endpoints.delete"),
        message: t("modelProviders.endpoints.deleteConfirm", { provider: value.provider }),
        confirmLabel: t("modelProviders.endpoints.delete"),
        danger: true,
      }))
    ) {
      return;
    }
    if (!isCurrent(scope)) {
      return;
    }
    props.onInvalidate(value.provider);
    const result = await context.runtimeConfig.runExternalMutation<{
      warning?: string;
      keyFailed?: boolean;
    }>(
      async (client) => {
        if (client !== scope.client || !isCurrent(scope)) {
          throw new Error(t("modelProviders.requestFailed"));
        }
        if (!revision) {
          throw new Error(t("modelProviders.configUnavailable"));
        }
        const receipt = await client.request<{ warning?: string }>(
          "config.customEndpoint",
          remove
            ? { action, provider: value.provider, baseHash: revision }
            : {
                action,
                ...value,
                models: value.models.map((row): CustomEndpointModelUpdate => ({
                  id: row.id,
                  ...(row.existingId ? { existingId: row.existingId } : {}),
                  edits: row.edits,
                })),
                baseHash: revision,
              },
        );
        if (isCurrent(scope)) {
          setEditing(!remove);
          if (!remove) {
            setDraft((current) =>
              current === value
                ? {
                    ...current,
                    models: current.models.map((row) => ({
                      ...row,
                      existingId: row.id,
                      edits: {},
                    })),
                  }
                : current,
            );
          }
          operation.state.message = t("modelProviders.endpoints.saved");
        }
        if (!remove && apiKey && !value.noAuth) {
          try {
            if (!isCurrent(scope)) {
              throw new Error(t("modelProviders.requestFailed"));
            }
            const credential = await client.request<{ warning?: string }>("models.authSetApiKey", {
              provider: value.provider,
              agentId: scope.agentId,
              apiKey,
            });
            if (isCurrent(scope)) {
              setKey("");
            }
            return { warning: [receipt.warning, credential.warning].filter(Boolean).join(" ") };
          } catch (error) {
            return {
              warning: t("modelProviders.endpoints.keyFailed") + " " + formatUiError(error),
              keyFailed: true,
            };
          }
        }
        return receipt;
      },
      { canDispatch: () => isCurrent(scope) && canManage() },
    );
    if (!isCurrent(scope)) {
      return;
    }
    if (!result.ok) {
      operation.state.message = result.error;
      operation.state.failed = true;
      return;
    }
    if (result.refresh.ok) {
      setBaseHash(context.runtimeConfig.state.configSnapshot?.hash ?? "");
    }
    operation.state.failed = result.value.keyFailed === true;
    invalidateModelAuthStatusRequests(scope.client);
    operation.state.message =
      t(remove ? "modelProviders.endpoints.deleted" : "modelProviders.endpoints.saved") +
      (result.value.warning ? " " + result.value.warning : "") +
      (!result.refresh.ok ? " " + result.refresh.error : "");
    if (remove) {
      setDraft(null);
      setKey("");
    }
    await props.onRefresh();
  }
  async function discover(scope: Scope) {
    const value = draft();
    if (!value) {
      return;
    }
    const result = await scope.client.request<{ models: string[] }>("config.customEndpoint", {
      action: "discover",
      provider: value.provider,
      baseUrl: value.baseUrl,
      api: value.api,
      noAuth: value.noAuth,
      ...(key().trim() && !value.noAuth ? { apiKey: key().trim() } : {}),
    });
    if (!isCurrent(scope)) {
      return;
    }
    setDiscovered(result.models);
    setSelected([]);
    operation.state.message = t(
      result.models.length
        ? "modelProviders.endpoints.discoveryResult"
        : "modelProviders.endpoints.discoveryEmpty",
    );
  }
  function modelRoute(value: CustomEndpointDraft, row: CustomEndpointModel) {
    const source = asNullableRecord(providers()[value.provider]);
    const previous = (Array.isArray(source?.models) ? source.models : [])
      .map(asNullableRecord)
      .find((entry) => entry?.id === (row.existingId ?? row.id));
    return t("modelProviders.endpoints.route", {
      api: typeof previous?.api === "string" ? previous.api : value.api,
      url: typeof previous?.baseUrl === "string" ? previous.baseUrl : value.baseUrl,
    });
  }
  async function removeKey(scope: Scope, provider: string) {
    const confirmed = await showConfirmDialog({
      title: t("modelProviders.endpoints.removeKey"),
      message: t("modelProviders.endpoints.removeKeyConfirm", { provider }),
      confirmLabel: t("modelProviders.endpoints.removeKey"),
      danger: true,
    });
    if (!confirmed || !isCurrent(scope)) {
      return;
    }
    props.onInvalidate(provider);
    const result = await context.runtimeConfig.runExternalMutation(
      (client) =>
        client.request<{ warning?: string }>("models.authLogout", {
          provider,
          agentId: scope.agentId,
          credentialType: "api_key",
        }),
      { canDispatch: () => isCurrent(scope) && canManage() },
    );
    if (!isCurrent(scope)) {
      return;
    }
    if (!result.ok) {
      throw new Error(result.error);
    }
    invalidateModelAuthStatusRequests(scope.client);
    operation.state.message =
      t("modelProviders.endpoints.keyRemoved") +
      (result.value.warning ? " " + result.value.warning : "") +
      (!result.refresh.ok ? " " + result.refresh.error : "");
    await props.onRefresh();
  }
  async function test(scope: Scope, provider: string) {
    const result = await scope.client.request<{ status: string; error?: string }>("models.probe", {
      provider,
      agentId: scope.agentId,
    });
    if (isCurrent(scope)) {
      operation.state.message =
        t("modelProviders.endpoints.testResult", { status: result.status }) +
        (result.error ? " " + result.error : "");
    }
  }
  return (
    <SettingsSection
      title={t("modelProviders.endpoints.title")}
      description={t("modelProviders.endpoints.description")}
    >
      <div data-custom-endpoints>
        <SettingsGroup>
          <For each={entries()} keyed={(item) => item.provider}>
            {(item) => (
              <SettingsRow
                title={item().provider}
                description={item().baseUrl}
                control={
                  <>
                    <button
                      class="btn btn--sm"
                      disabled={disabled() || !api(item().entry.api)}
                      onClick={() => begin(item().provider, item().entry)}
                    >
                      {t("modelProviders.endpoints.editConnection")}
                    </button>
                    <button
                      class="btn btn--sm"
                      disabled={disabled()}
                      onClick={() => void run((scope) => test(scope, item().provider))}
                    >
                      {t("modelProviders.endpoints.test")}
                    </button>
                    <button
                      class="btn btn--sm"
                      disabled={disabled()}
                      onClick={() => void run((scope) => removeKey(scope, item().provider))}
                    >
                      {t("modelProviders.endpoints.removeKey")}
                    </button>
                  </>
                }
              />
            )}
          </For>
          <SettingsRow
            title={t("modelProviders.endpoints.add")}
            description={t("modelProviders.endpoints.localOnly")}
            control={
              <button class="btn btn--sm" disabled={disabled()} onClick={() => begin()}>
                {t("modelProviders.endpoints.add")}
              </button>
            }
          />
        </SettingsGroup>
        <Show when={status().message && !draft()}>
          <p role="status">{status().message}</p>
        </Show>
        <Show when={draft()}>
          {(value) => (
            <ModalDialog
              class="custom-endpoint-dialog"
              label={t(
                editing() ? "modelProviders.endpoints.edit" : "modelProviders.endpoints.add",
              )}
              onModal-cancel={(event: Event) => {
                if (event.target !== event.currentTarget) {
                  return;
                }
                event.preventDefault();
                if (!status().busy) {
                  setDraft(null);
                  setKey("");
                }
              }}
            >
              <form
                class="custom-endpoint-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run((scope) => save(scope));
                }}
              >
                <header class="custom-endpoint-editor__header">
                  <h2>
                    {t(
                      editing() ? "modelProviders.endpoints.edit" : "modelProviders.endpoints.add",
                    )}
                  </h2>
                </header>
                <div class="custom-endpoint-editor__body">
                  <p class="muted">{t("modelProviders.endpoints.gatewayConnects")}</p>
                  <div class="custom-endpoint-editor__connection">
                    <label class="field">
                      <span>{t("modelProviders.endpoints.providerId")}</span>
                      <input
                        required
                        pattern="[a-z0-9]+(-[a-z0-9]+)*"
                        value={value().provider}
                        disabled={editing() || status().busy}
                        placeholder="lab-inference"
                        onInput={(event) => update({ provider: event.currentTarget.value })}
                      />
                    </label>
                    <label class="field">
                      <span>{t("modelProviders.endpoints.baseUrl")}</span>
                      <input
                        type="url"
                        required
                        value={value().baseUrl}
                        disabled={status().busy}
                        placeholder="http://inference.lan:8000/v1"
                        onInput={(event) => {
                          update({ baseUrl: event.currentTarget.value });
                          setDiscovered([]);
                        }}
                      />
                    </label>
                    <label class="field">
                      <span>{t("modelProviders.endpoints.adapter")}</span>
                      <select
                        aria-label={t("modelProviders.endpoints.adapter")}
                        value={value().api}
                        disabled={status().busy}
                        onChange={(event) => {
                          const next = api(event.currentTarget.value);
                          if (next) {
                            update({
                              api: next,
                              noAuth: next === "openai-completions" && value().noAuth,
                            });
                          }
                          setDiscovered([]);
                        }}
                      >
                        <For each={CUSTOM_ENDPOINT_APIS}>
                          {(entry) => <option value={entry}>{apiLabels[entry]}</option>}
                        </For>
                      </select>
                    </label>
                    <label class="field">
                      <span>{t("modelProviders.endpoints.key")}</span>
                      <input
                        type="password"
                        aria-label={t("modelProviders.endpoints.key")}
                        autocomplete="new-password"
                        value={key()}
                        disabled={status().busy || value().noAuth}
                        onInput={(event) => setKey(event.currentTarget.value)}
                      />
                      <small>
                        {t("modelProviders.endpoints.keyHint", { agent: props.scope.agentId })}
                      </small>
                    </label>
                  </div>
                  <label>
                    <input
                      type="checkbox"
                      checked={value().noAuth}
                      disabled={status().busy || value().api !== "openai-completions"}
                      onChange={(event) => {
                        update({ noAuth: event.currentTarget.checked });
                        setKey("");
                      }}
                    />{" "}
                    {t("modelProviders.endpoints.noAuth")}
                  </label>
                  <p class="muted">{t("modelProviders.endpoints.preserve")}</p>
                  <div class="custom-endpoint-editor__heading">
                    <h3>{t("modelProviders.endpoints.models")}</h3>
                    <button
                      type="button"
                      class="btn btn--sm"
                      disabled={
                        status().busy ||
                        value().api === "anthropic-messages" ||
                        !value().baseUrl ||
                        !value().provider
                      }
                      onClick={() => void run(discover)}
                    >
                      {t("modelProviders.endpoints.discover")}
                    </button>
                  </div>
                  <For each={value().models} keyed={false}>
                    {(row, index) => (
                      <EndpointModel
                        model={row()}
                        number={index + 1}
                        provider={value().provider}
                        route={modelRoute(value(), row())}
                        disabled={status().busy}
                        canRemove={value().models.length > 1}
                        onEdit={(edits) => editModel(index, edits)}
                        onIdChange={(id) => renameModel(index, id)}
                        onRemove={() =>
                          update({ models: value().models.filter((_, i) => i !== index) })
                        }
                      />
                    )}
                  </For>
                  <button
                    type="button"
                    class="btn btn--sm"
                    disabled={status().busy}
                    onClick={() => update({ models: [...value().models, newModel()] })}
                  >
                    {t("modelProviders.endpoints.addModel")}
                  </button>
                  <Show when={discovered().length}>
                    <fieldset>
                      <legend>{t("modelProviders.endpoints.discovered")}</legend>
                      <For each={discovered()}>
                        {(id) => (
                          <label class="custom-endpoint-editor__discovered">
                            <input
                              type="checkbox"
                              checked={selected().includes(id)}
                              onChange={(event) =>
                                setSelected((ids) =>
                                  event.currentTarget.checked
                                    ? [...ids, id]
                                    : ids.filter((entry) => entry !== id),
                                )
                              }
                            />{" "}
                            {id}
                          </label>
                        )}
                      </For>
                      <button
                        type="button"
                        class="btn btn--sm"
                        disabled={!selected().length || status().busy}
                        onClick={() => {
                          update({
                            models: [
                              ...value().models.filter((row) => row.id),
                              ...selected()
                                .filter((id) => !value().models.some((row) => row.id === id))
                                .map(newModel),
                            ],
                          });
                          setSelected([]);
                        }}
                      >
                        {t("modelProviders.endpoints.addSelected")}
                      </button>
                    </fieldset>
                  </Show>
                </div>
                <div class="custom-endpoint-editor__footer">
                  <p>{t("modelProviders.endpoints.defaultUnchanged")}</p>
                  <Show when={status().message}>
                    <p role={status().failed ? "alert" : "status"}>{status().message}</p>
                  </Show>
                  <openclaw-modal-actions>
                    <Show when={editing()}>
                      <button
                        type="button"
                        class="btn danger"
                        disabled={status().busy}
                        onClick={() => void run((scope) => save(scope, true))}
                      >
                        {t("modelProviders.endpoints.delete")}
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="btn"
                      disabled={status().busy}
                      onClick={() => {
                        setDraft(null);
                        setKey("");
                      }}
                    >
                      {t("common.close")}
                    </button>
                    <button class="btn primary" disabled={disabled()}>
                      {status().busy ? t("modelProviders.saving") : t("common.save")}
                    </button>
                  </openclaw-modal-actions>
                </div>
              </form>
            </ModalDialog>
          )}
        </Show>
      </div>
    </SettingsSection>
  );
}
