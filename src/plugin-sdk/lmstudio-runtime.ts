type FacadeModule = typeof import("../../extensions/lmstudio/runtime-api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "lmstudio",
    artifactBasename: "runtime-api.js",
  });
}

export type {
  LmstudioModelBase,
  LmstudioModelWire,
} from "../../extensions/lmstudio/runtime-api.js";

export const LMSTUDIO_DEFAULT_BASE_URL: FacadeModule["LMSTUDIO_DEFAULT_BASE_URL"] =
  loadFacadeModule().LMSTUDIO_DEFAULT_BASE_URL;
export const LMSTUDIO_DEFAULT_INFERENCE_BASE_URL: FacadeModule["LMSTUDIO_DEFAULT_INFERENCE_BASE_URL"] =
  loadFacadeModule().LMSTUDIO_DEFAULT_INFERENCE_BASE_URL;
export const LMSTUDIO_DEFAULT_EMBEDDING_MODEL: FacadeModule["LMSTUDIO_DEFAULT_EMBEDDING_MODEL"] =
  loadFacadeModule().LMSTUDIO_DEFAULT_EMBEDDING_MODEL;
export const LMSTUDIO_PROVIDER_LABEL: FacadeModule["LMSTUDIO_PROVIDER_LABEL"] =
  loadFacadeModule().LMSTUDIO_PROVIDER_LABEL;
export const LMSTUDIO_DEFAULT_API_KEY_ENV_VAR: FacadeModule["LMSTUDIO_DEFAULT_API_KEY_ENV_VAR"] =
  loadFacadeModule().LMSTUDIO_DEFAULT_API_KEY_ENV_VAR;
export const LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER: FacadeModule["LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER"] =
  loadFacadeModule().LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER;
export const LMSTUDIO_MODEL_PLACEHOLDER: FacadeModule["LMSTUDIO_MODEL_PLACEHOLDER"] =
  loadFacadeModule().LMSTUDIO_MODEL_PLACEHOLDER;
export const LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH: FacadeModule["LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH"] =
  loadFacadeModule().LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH;
export const LMSTUDIO_DEFAULT_MODEL_ID: FacadeModule["LMSTUDIO_DEFAULT_MODEL_ID"] =
  loadFacadeModule().LMSTUDIO_DEFAULT_MODEL_ID;
export const LMSTUDIO_PROVIDER_ID: FacadeModule["LMSTUDIO_PROVIDER_ID"] =
  loadFacadeModule().LMSTUDIO_PROVIDER_ID;

export const resolveLmstudioReasoningCapability: FacadeModule["resolveLmstudioReasoningCapability"] =
  ((...args) =>
    loadFacadeModule().resolveLmstudioReasoningCapability(
      ...args,
    )) as FacadeModule["resolveLmstudioReasoningCapability"];
export const resolveLoadedContextWindow: FacadeModule["resolveLoadedContextWindow"] = ((...args) =>
  loadFacadeModule().resolveLoadedContextWindow(
    ...args,
  )) as FacadeModule["resolveLoadedContextWindow"];
export const resolveLmstudioServerBase: FacadeModule["resolveLmstudioServerBase"] = ((...args) =>
  loadFacadeModule().resolveLmstudioServerBase(
    ...args,
  )) as FacadeModule["resolveLmstudioServerBase"];
export const resolveLmstudioInferenceBase: FacadeModule["resolveLmstudioInferenceBase"] = ((
  ...args
) =>
  loadFacadeModule().resolveLmstudioInferenceBase(
    ...args,
  )) as FacadeModule["resolveLmstudioInferenceBase"];
export const normalizeLmstudioProviderConfig: FacadeModule["normalizeLmstudioProviderConfig"] = ((
  ...args
) =>
  loadFacadeModule().normalizeLmstudioProviderConfig(
    ...args,
  )) as FacadeModule["normalizeLmstudioProviderConfig"];
export const fetchLmstudioModels: FacadeModule["fetchLmstudioModels"] = ((...args) =>
  loadFacadeModule().fetchLmstudioModels(...args)) as FacadeModule["fetchLmstudioModels"];
export const mapLmstudioWireEntry: FacadeModule["mapLmstudioWireEntry"] = ((...args) =>
  loadFacadeModule().mapLmstudioWireEntry(...args)) as FacadeModule["mapLmstudioWireEntry"];
export const discoverLmstudioModels: FacadeModule["discoverLmstudioModels"] = ((...args) =>
  loadFacadeModule().discoverLmstudioModels(...args)) as FacadeModule["discoverLmstudioModels"];
export const ensureLmstudioModelLoaded: FacadeModule["ensureLmstudioModelLoaded"] = ((...args) =>
  loadFacadeModule().ensureLmstudioModelLoaded(
    ...args,
  )) as FacadeModule["ensureLmstudioModelLoaded"];

export const buildLmstudioAuthHeaders: FacadeModule["buildLmstudioAuthHeaders"] = ((...args) =>
  loadFacadeModule().buildLmstudioAuthHeaders(...args)) as FacadeModule["buildLmstudioAuthHeaders"];
export const resolveLmstudioConfiguredApiKey: FacadeModule["resolveLmstudioConfiguredApiKey"] = ((
  ...args
) =>
  loadFacadeModule().resolveLmstudioConfiguredApiKey(
    ...args,
  )) as FacadeModule["resolveLmstudioConfiguredApiKey"];
export const resolveLmstudioProviderHeaders: FacadeModule["resolveLmstudioProviderHeaders"] = ((
  ...args
) =>
  loadFacadeModule().resolveLmstudioProviderHeaders(
    ...args,
  )) as FacadeModule["resolveLmstudioProviderHeaders"];
export const resolveLmstudioRuntimeApiKey: FacadeModule["resolveLmstudioRuntimeApiKey"] = ((
  ...args
) =>
  loadFacadeModule().resolveLmstudioRuntimeApiKey(
    ...args,
  )) as FacadeModule["resolveLmstudioRuntimeApiKey"];
