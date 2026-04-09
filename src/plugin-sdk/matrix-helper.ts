// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/matrix/api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "matrix",
    artifactBasename: "api.js",
  });
}
export const findMatrixAccountEntry: FacadeModule["findMatrixAccountEntry"] = ((...args) =>
  loadFacadeModule()["findMatrixAccountEntry"](...args)) as FacadeModule["findMatrixAccountEntry"];
export const getMatrixScopedEnvVarNames: FacadeModule["getMatrixScopedEnvVarNames"] = ((...args) =>
  loadFacadeModule()["getMatrixScopedEnvVarNames"](
    ...args,
  )) as FacadeModule["getMatrixScopedEnvVarNames"];
export const requiresExplicitMatrixDefaultAccount: FacadeModule["requiresExplicitMatrixDefaultAccount"] =
  ((...args) =>
    loadFacadeModule()["requiresExplicitMatrixDefaultAccount"](
      ...args,
    )) as FacadeModule["requiresExplicitMatrixDefaultAccount"];
export const resolveConfiguredMatrixAccountIds: FacadeModule["resolveConfiguredMatrixAccountIds"] =
  ((...args) =>
    loadFacadeModule()["resolveConfiguredMatrixAccountIds"](
      ...args,
    )) as FacadeModule["resolveConfiguredMatrixAccountIds"];
export const resolveMatrixAccountStorageRoot: FacadeModule["resolveMatrixAccountStorageRoot"] = ((
  ...args
) =>
  loadFacadeModule()["resolveMatrixAccountStorageRoot"](
    ...args,
  )) as FacadeModule["resolveMatrixAccountStorageRoot"];
export const resolveMatrixChannelConfig: FacadeModule["resolveMatrixChannelConfig"] = ((...args) =>
  loadFacadeModule()["resolveMatrixChannelConfig"](
    ...args,
  )) as FacadeModule["resolveMatrixChannelConfig"];
export const resolveMatrixCredentialsDir: FacadeModule["resolveMatrixCredentialsDir"] = ((
  ...args
) =>
  loadFacadeModule()["resolveMatrixCredentialsDir"](
    ...args,
  )) as FacadeModule["resolveMatrixCredentialsDir"];
export const resolveMatrixCredentialsPath: FacadeModule["resolveMatrixCredentialsPath"] = ((
  ...args
) =>
  loadFacadeModule()["resolveMatrixCredentialsPath"](
    ...args,
  )) as FacadeModule["resolveMatrixCredentialsPath"];
export const resolveMatrixDefaultOrOnlyAccountId: FacadeModule["resolveMatrixDefaultOrOnlyAccountId"] =
  ((...args) =>
    loadFacadeModule()["resolveMatrixDefaultOrOnlyAccountId"](
      ...args,
    )) as FacadeModule["resolveMatrixDefaultOrOnlyAccountId"];
export const resolveMatrixLegacyFlatStoragePaths: FacadeModule["resolveMatrixLegacyFlatStoragePaths"] =
  ((...args) =>
    loadFacadeModule()["resolveMatrixLegacyFlatStoragePaths"](
      ...args,
    )) as FacadeModule["resolveMatrixLegacyFlatStoragePaths"];
