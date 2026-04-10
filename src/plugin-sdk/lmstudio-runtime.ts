type FacadeModule = typeof import("@openclaw/lmstudio/runtime-api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

const facade = loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
  dirName: "lmstudio",
  artifactBasename: "runtime-api.js",
});

export type LmstudioModelWire = Parameters<FacadeModule["mapLmstudioWireEntry"]>[0];
export type LmstudioModelBase = Exclude<ReturnType<FacadeModule["mapLmstudioWireEntry"]>, null>;

export const LMSTUDIO_DEFAULT_BASE_URL = facade.LMSTUDIO_DEFAULT_BASE_URL;
export const LMSTUDIO_DEFAULT_INFERENCE_BASE_URL = facade.LMSTUDIO_DEFAULT_INFERENCE_BASE_URL;
export const LMSTUDIO_DEFAULT_EMBEDDING_MODEL = facade.LMSTUDIO_DEFAULT_EMBEDDING_MODEL;
export const LMSTUDIO_PROVIDER_LABEL = facade.LMSTUDIO_PROVIDER_LABEL;
export const LMSTUDIO_DEFAULT_API_KEY_ENV_VAR = facade.LMSTUDIO_DEFAULT_API_KEY_ENV_VAR;
export const LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER = facade.LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER;
export const LMSTUDIO_MODEL_PLACEHOLDER = facade.LMSTUDIO_MODEL_PLACEHOLDER;
export const LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH = facade.LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH;
export const LMSTUDIO_DEFAULT_MODEL_ID = facade.LMSTUDIO_DEFAULT_MODEL_ID;
export const LMSTUDIO_PROVIDER_ID = facade.LMSTUDIO_PROVIDER_ID;

export const resolveLmstudioReasoningCapability = facade.resolveLmstudioReasoningCapability;
export const resolveLoadedContextWindow = facade.resolveLoadedContextWindow;
export const resolveLmstudioServerBase = facade.resolveLmstudioServerBase;
export const resolveLmstudioInferenceBase = facade.resolveLmstudioInferenceBase;
export const normalizeLmstudioProviderConfig = facade.normalizeLmstudioProviderConfig;
export const fetchLmstudioModels = facade.fetchLmstudioModels;
export const mapLmstudioWireEntry = facade.mapLmstudioWireEntry;
export const discoverLmstudioModels = facade.discoverLmstudioModels;
export const ensureLmstudioModelLoaded = facade.ensureLmstudioModelLoaded;
export const buildLmstudioAuthHeaders = facade.buildLmstudioAuthHeaders;
export const resolveLmstudioConfiguredApiKey = facade.resolveLmstudioConfiguredApiKey;
export const resolveLmstudioProviderHeaders = facade.resolveLmstudioProviderHeaders;
export const resolveLmstudioRuntimeApiKey = facade.resolveLmstudioRuntimeApiKey;
