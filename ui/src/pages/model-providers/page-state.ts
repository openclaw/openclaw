import type { ModelsProbeResult } from "../../api/types.ts";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import type { DefaultsDraft } from "./data.ts";
import type { ModelProvidersData } from "./load.ts";

export type ModelProvidersState = {
  data: ModelProvidersData | null;
  busy: Record<string, boolean>;
  messages: Record<string, ModelProviderRowMessage>;
  probeResults: Record<string, ModelsProbeResult>;
  keyEditorProvider: string | null;
  keyDraft: string;
  profileOrders: Record<string, string[]>;
  addProviderId: string;
  addProviderKey: string;
  defaultsDraft: DefaultsDraft | null;
  selectedAgentId: string;
};

export function createModelProvidersState(): ModelProvidersState {
  return {
    data: null,
    busy: {},
    messages: {},
    probeResults: {},
    keyEditorProvider: null,
    keyDraft: "",
    profileOrders: {},
    addProviderId: "",
    addProviderKey: "",
    defaultsDraft: null,
    selectedAgentId: "",
  };
}
