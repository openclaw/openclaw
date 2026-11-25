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

export function createSessionsListResult(
  options: {
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
  } = {},
): SessionsListResult {
  const {
    model = null,
    modelProvider = model ? "openai" : null,
    defaultsModel = "gpt-5",
    defaultsProvider = defaultsModel ? "openai" : null,
    ...fields
  } = options;
  const session = {
    key: "main",
    kind: "direct" as const,
    updatedAt: null,
    ...(modelProvider ? { modelProvider } : {}),
    ...(model ? { model } : {}),
    ...(fields.modelOverrideSource === undefined
      ? {}
      : { modelOverrideSource: fields.modelOverrideSource }),
    ...(fields.thinkingDefault ? { thinkingDefault: fields.thinkingDefault } : {}),
    ...(fields.thinkingLevels === undefined ? {} : { thinkingLevels: fields.thinkingLevels }),
  };
  return sessionListResult(0, fields.omitSessionFromList ? [] : [session], {
    modelProvider: defaultsProvider,
    model: defaultsModel,
    contextTokens: null,
    ...(fields.defaultsThinkingLevels ? { thinkingLevels: fields.defaultsThinkingLevels } : {}),
    ...(fields.defaultsThinkingOptions ? { thinkingOptions: fields.defaultsThinkingOptions } : {}),
    ...(fields.defaultsThinkingDefault ? { thinkingDefault: fields.defaultsThinkingDefault } : {}),
  });
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

export function sessionListResult(
  ts: number,
  sessions: SessionsListResult["sessions"],
  defaults: SessionsListResult["defaults"] = {
    modelProvider: null,
    model: null,
    contextTokens: null,
  },
): SessionsListResult {
  return { ts, path: "", count: sessions.length, defaults, sessions };
}

export const nativeRuntime = (
  id = "openclaw",
  mode: "worker-turn" | "remote-exec" = "worker-turn",
) => ({
  id,
  source: "model" as const,
  cloudPlacementSupported: true,
  cloudPlacementExecutionMode: mode,
  devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
});
