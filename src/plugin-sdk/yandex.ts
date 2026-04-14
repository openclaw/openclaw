// Manual facade. Keep loader boundary explicit.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelProviderConfig, ModelDefinitionConfig } from "./provider-model-shared.js";
type FacadeModule = {
  applyYandexConfig: (cfg: OpenClawConfig) => OpenClawConfig;
  applyYandexProviderConfig: (cfg: OpenClawConfig) => OpenClawConfig;
  buildYandexModelDefinition: (model: ModelDefinitionConfig) => ModelDefinitionConfig;
  buildYandexProvider: (folderId?: string) => ModelProviderConfig;
  YANDEX_BASE_URL: string;
  YANDEX_DEFAULT_MODEL_REF: string;
  YANDEX_MODEL_CATALOG: readonly ModelDefinitionConfig[];
};
import {
  createLazyFacadeArrayValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "yandex",
    artifactBasename: "api.js",
  });
}

export const applyYandexConfig: FacadeModule["applyYandexConfig"] = (cfg) =>
  loadFacadeModule()["applyYandexConfig"](cfg);
export const applyYandexProviderConfig: FacadeModule["applyYandexProviderConfig"] = (cfg) =>
  loadFacadeModule()["applyYandexProviderConfig"](cfg);
export const buildYandexModelDefinition: FacadeModule["buildYandexModelDefinition"] = (model) =>
  loadFacadeModule()["buildYandexModelDefinition"](model);
export const buildYandexProvider: FacadeModule["buildYandexProvider"] = (folderId) =>
  loadFacadeModule()["buildYandexProvider"](folderId);
export const YANDEX_BASE_URL: FacadeModule["YANDEX_BASE_URL"] =
  loadFacadeModule()["YANDEX_BASE_URL"];
export const YANDEX_DEFAULT_MODEL_REF: FacadeModule["YANDEX_DEFAULT_MODEL_REF"] =
  loadFacadeModule()["YANDEX_DEFAULT_MODEL_REF"];
export const YANDEX_MODEL_CATALOG: FacadeModule["YANDEX_MODEL_CATALOG"] =
  createLazyFacadeArrayValue(
    () => loadFacadeModule()["YANDEX_MODEL_CATALOG"] as unknown as readonly unknown[],
  ) as FacadeModule["YANDEX_MODEL_CATALOG"];
