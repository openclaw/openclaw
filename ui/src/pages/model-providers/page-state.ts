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
  /** Advances on a forced refresh so each account row re-reads its plan limits. */
  accountUsageRevision: number;
};
