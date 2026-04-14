// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/yandex-provider/api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "yandex",
    artifactBasename: "api.js",
  });
}
export const applyYandexConfig: FacadeModule["applyYandexConfig"] = ((...args) =>
  loadFacadeModule()["applyYandexConfig"](...args)) as FacadeModule["applyYandexConfig"];
export const applyYandexProviderConfig: FacadeModule["applyYandexProviderConfig"] = ((...args) =>
  loadFacadeModule()["applyYandexProviderConfig"](
    ...args,
  )) as FacadeModule["applyYandexProviderConfig"];
export const buildYandexModelDefinition: FacadeModule["buildYandexModelDefinition"] = ((...args) =>
  loadFacadeModule()["buildYandexModelDefinition"](
    ...args,
  )) as FacadeModule["buildYandexModelDefinition"];
export const buildYandexProvider: FacadeModule["buildYandexProvider"] = ((...args) =>
  loadFacadeModule()["buildYandexProvider"](...args)) as FacadeModule["buildYandexProvider"];
export const YANDEX_BASE_URL: FacadeModule["YANDEX_BASE_URL"] =
  loadFacadeModule()["YANDEX_BASE_URL"];
export const YANDEX_DEFAULT_MODEL_REF: FacadeModule["YANDEX_DEFAULT_MODEL_REF"] =
  loadFacadeModule()["YANDEX_DEFAULT_MODEL_REF"];
export const YANDEX_MODEL_CATALOG: FacadeModule["YANDEX_MODEL_CATALOG"] =
  loadFacadeModule()["YANDEX_MODEL_CATALOG"];
