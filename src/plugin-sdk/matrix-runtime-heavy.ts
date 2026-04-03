import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

type MatrixRuntimeHeavyModule = {
  autoPrepareLegacyMatrixCrypto: (typeof import("../../extensions/matrix/src/runtime-heavy-api.js"))["autoPrepareLegacyMatrixCrypto"];
  detectLegacyMatrixCrypto: (typeof import("../../extensions/matrix/src/runtime-heavy-api.js"))["detectLegacyMatrixCrypto"];
  autoMigrateLegacyMatrixState: (typeof import("../../extensions/matrix/src/runtime-heavy-api.js"))["autoMigrateLegacyMatrixState"];
  detectLegacyMatrixState: (typeof import("../../extensions/matrix/src/runtime-heavy-api.js"))["detectLegacyMatrixState"];
  hasActionableMatrixMigration: (typeof import("../../extensions/matrix/src/runtime-heavy-api.js"))["hasActionableMatrixMigration"];
  hasPendingMatrixMigration: (typeof import("../../extensions/matrix/src/runtime-heavy-api.js"))["hasPendingMatrixMigration"];
  maybeCreateMatrixMigrationSnapshot: (typeof import("../../extensions/matrix/src/runtime-heavy-api.js"))["maybeCreateMatrixMigrationSnapshot"];
};

function loadFacadeModule(): MatrixRuntimeHeavyModule {
  return loadBundledPluginPublicSurfaceModuleSync<MatrixRuntimeHeavyModule>({
    dirName: "matrix",
    artifactBasename: "runtime-heavy-api.js",
  });
}

export const autoPrepareLegacyMatrixCrypto: MatrixRuntimeHeavyModule["autoPrepareLegacyMatrixCrypto"] =
  ((...args) =>
    loadFacadeModule().autoPrepareLegacyMatrixCrypto(
      ...args,
    )) as MatrixRuntimeHeavyModule["autoPrepareLegacyMatrixCrypto"];
export const detectLegacyMatrixCrypto: MatrixRuntimeHeavyModule["detectLegacyMatrixCrypto"] = ((
  ...args
) =>
  loadFacadeModule().detectLegacyMatrixCrypto(
    ...args,
  )) as MatrixRuntimeHeavyModule["detectLegacyMatrixCrypto"];
export const autoMigrateLegacyMatrixState: MatrixRuntimeHeavyModule["autoMigrateLegacyMatrixState"] =
  ((...args) =>
    loadFacadeModule().autoMigrateLegacyMatrixState(
      ...args,
    )) as MatrixRuntimeHeavyModule["autoMigrateLegacyMatrixState"];
export const detectLegacyMatrixState: MatrixRuntimeHeavyModule["detectLegacyMatrixState"] = ((
  ...args
) =>
  loadFacadeModule().detectLegacyMatrixState(
    ...args,
  )) as MatrixRuntimeHeavyModule["detectLegacyMatrixState"];
export const hasActionableMatrixMigration: MatrixRuntimeHeavyModule["hasActionableMatrixMigration"] =
  ((...args) =>
    loadFacadeModule().hasActionableMatrixMigration(
      ...args,
    )) as MatrixRuntimeHeavyModule["hasActionableMatrixMigration"];
export const hasPendingMatrixMigration: MatrixRuntimeHeavyModule["hasPendingMatrixMigration"] = ((
  ...args
) =>
  loadFacadeModule().hasPendingMatrixMigration(
    ...args,
  )) as MatrixRuntimeHeavyModule["hasPendingMatrixMigration"];
export const maybeCreateMatrixMigrationSnapshot: MatrixRuntimeHeavyModule["maybeCreateMatrixMigrationSnapshot"] =
  ((...args) =>
    loadFacadeModule().maybeCreateMatrixMigrationSnapshot(
      ...args,
    )) as MatrixRuntimeHeavyModule["maybeCreateMatrixMigrationSnapshot"];
