import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import type { createModelProviderMutationPresentation } from "./config-mutation-presentation.ts";
import {
  modelProviderErrorMessage,
  runModelProviderApiKeyMutation,
  runModelProviderDefaultsMutation,
  type ModelDefaultsSaveField,
  type ModelProviderRowMessage,
} from "./config-mutation.ts";
import type { ModelProvidersState } from "./page-state.ts";

export function createModelProviderConfigActions(deps: {
  context: ApplicationContext;
  gateway: GatewayPageBinding;
  state: ModelProvidersState;
  mutations: ReturnType<typeof createModelProviderMutationPresentation>;
  getAgentEpoch: () => number;
  canMutate: () => boolean;
  clearProbe: (provider: string) => void;
  refresh: () => Promise<void>;
  setBusy: (key: string, busy: boolean) => void;
  setMessage: (key: string, message: ModelProviderRowMessage | null) => void;
  setAddProviderOpen: (open: boolean) => void;
}) {
  const {
    context,
    gateway,
    state,
    mutations,
    getAgentEpoch,
    canMutate,
    clearProbe,
    refresh,
    setBusy,
    setMessage,
    setAddProviderOpen,
  } = deps;
  function closeKeyEditor() {
    state.keyEditorProvider = null;
    state.keyDraft = "";
  }

  async function mutateApiKey(
    provider: string,
    configKey: string,
    apiKey: string,
    action: "edit" | "add" = "edit",
  ) {
    const client = gateway.client;
    const key = action === "add" ? "add" : `key:${provider}`;
    if (!client || !canMutate() || state.busy[key] || apiKey === "") {
      return;
    }
    const clientEpoch = gateway.epoch;
    const capturedAgentEpoch = getAgentEpoch();
    const isCurrent = () =>
      gateway.isCurrent({ client, epoch: clientEpoch }) && getAgentEpoch() === capturedAgentEpoch;
    clearProbe(provider);
    const result = await mutations.run(
      "apiKey",
      () =>
        runModelProviderApiKeyMutation(
          {
            runtimeConfig: context.runtimeConfig,
            isCurrentClient: isCurrent,
            isCurrentAgent: isCurrent,
            canMutate: () => canMutate(),
            refreshProviders: async () => {
              const previous = state.data;
              await refresh();
              if (isCurrent() && state.data?.error) {
                const warning = state.data.error;
                state.data = previous;
                return warning;
              }
              return state.data?.error ?? state.data?.catalogError ?? null;
            },
            setBusy: (busy) => setBusy(key, busy),
            setMessage: (message) => {
              setMessage(provider, message);
              if (action === "add") {
                setMessage("add", message);
              }
            },
          },
          {
            client,
            agentId: state.selectedAgentId,
            provider: configKey,
            apiKey,
            success: t(
              action === "add" ? "modelProviders.add.saved" : "modelProviders.apiKey.saved",
              { provider },
            ),
          },
        ),
      (error) =>
        setMessage(action === "add" ? "add" : provider, {
          kind: "error",
          text: modelProviderErrorMessage(error),
        }),
    );
    if (!result?.ok || !isCurrent()) {
      return;
    }
    if (action === "add") {
      if (state.addProviderId === provider && state.addProviderKey.trim() === apiKey) {
        setAddProviderOpen(Boolean(result.warning));
        if (!result.warning) {
          state.addProviderId = "";
        }
        state.addProviderKey = "";
      }
    } else if (state.keyEditorProvider === provider && state.keyDraft.trim() === apiKey) {
      closeKeyEditor();
    }
  }

  async function saveDefaults(field: ModelDefaultsSaveField) {
    const defaults = state.defaultsDraft;
    if (!defaults) {
      return;
    }
    const capturedAgentEpoch = getAgentEpoch();
    const settled = await mutations.run(
      field,
      (onAdmitted) =>
        runModelProviderDefaultsMutation(context, gateway, {
          defaults,
          busy: Boolean(state.busy.defaults),
          isCurrentAgent: () => getAgentEpoch() === capturedAgentEpoch,
          setBusy: (busy) => {
            if (busy) {
              onAdmitted();
            }
            setBusy("defaults", busy);
          },
          setMessage: (message) => setMessage("defaults", message),
        }),
      (error) => setMessage("defaults", { kind: "error", text: modelProviderErrorMessage(error) }),
    );
    // Retry retains rejected writes in the config owner; the picker shows saved defaults.
    if (settled != null && state.defaultsDraft === defaults) {
      state.defaultsDraft = null;
    }
  }

  return { closeKeyEditor, mutateApiKey, saveDefaults };
}
