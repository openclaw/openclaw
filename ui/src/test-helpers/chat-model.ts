import type {
  GatewaySessionRow,
  ModelCatalogEntry,
  SessionsListResult,
  SessionsPatchResult,
} from "../api/types.ts";

const catalogModel = (id: string, name: string, provider = "openai"): ModelCatalogEntry => ({
  id,
  name,
  provider,
});

export const OPENAI_GPT5_MINI_MODEL = catalogModel("gpt-5-mini", "GPT-5 Mini");

export const DEFAULT_CHAT_MODEL_CATALOG = [
  catalogModel("gpt-5", "GPT-5"),
  OPENAI_GPT5_MINI_MODEL,
] satisfies ModelCatalogEntry[];

export const createModelCatalog = (...entries: ModelCatalogEntry[]) => entries;
export const createAmbiguousModelCatalog = (id: string, ...providers: string[]) =>
  providers.map((provider) => catalogModel(id, id, provider));

export function createSessionsListResult({
  model = null,
  modelProvider = model ? "openai" : null,
  modelOverrideSource,
  defaultsModel = "gpt-5",
  defaultsProvider = defaultsModel ? "openai" : null,
  defaultsThinkingLevels,
  defaultsThinkingOptions,
  defaultsThinkingDefault,
  thinkingDefault,
  thinkingLevels,
  omitSessionFromList = false,
}: {
  model?: string | null;
  modelProvider?: string | null;
  modelOverrideSource?: GatewaySessionRow["modelOverrideSource"];
  defaultsModel?: string | null;
  defaultsProvider?: string | null;
  defaultsThinkingLevels?: SessionsListResult["defaults"]["thinkingLevels"];
  defaultsThinkingOptions?: string[];
  defaultsThinkingDefault?: string;
  thinkingDefault?: string;
  thinkingLevels?: GatewaySessionRow["thinkingLevels"];
  omitSessionFromList?: boolean;
} = {}): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: omitSessionFromList ? 0 : 1,
    defaults: {
      modelProvider: defaultsProvider,
      model: defaultsModel,
      contextTokens: null,
      ...(defaultsThinkingLevels ? { thinkingLevels: defaultsThinkingLevels } : {}),
      ...(defaultsThinkingOptions ? { thinkingOptions: defaultsThinkingOptions } : {}),
      ...(defaultsThinkingDefault ? { thinkingDefault: defaultsThinkingDefault } : {}),
    },
    sessions: omitSessionFromList
      ? []
      : [
          {
            key: "main",
            kind: "direct",
            updatedAt: null,
            ...(modelProvider ? { modelProvider } : {}),
            ...(model ? { model } : {}),
            ...(modelOverrideSource === undefined ? {} : { modelOverrideSource }),
            ...(thinkingDefault ? { thinkingDefault } : {}),
            ...(thinkingLevels === undefined ? {} : { thinkingLevels }),
          },
        ],
  };
}

export function createResolvedModelPatch(
  model: string,
  modelProvider?: string | null,
): SessionsPatchResult {
  return {
    ok: true,
    path: "",
    key: "main",
    entry: { sessionId: "main" },
    resolved: { model, modelProvider: modelProvider ?? undefined },
  };
}
