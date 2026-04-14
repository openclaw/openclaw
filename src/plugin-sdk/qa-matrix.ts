import type { Command } from "commander";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

type MatrixQaCliSurface = {
  registerMatrixQaCli: (qa: Command) => void;
};

function isMissingMatrixQaFacadeError(error: unknown) {
  return (
    error instanceof Error &&
    (error.message === "Unable to resolve bundled plugin public surface qa-matrix/cli.js" ||
      error.message.startsWith("Unable to open bundled plugin public surface "))
  );
}

function loadFacadeModule(): MatrixQaCliSurface {
  return loadBundledPluginPublicSurfaceModuleSync<MatrixQaCliSurface>({
    dirName: "qa-matrix",
    artifactBasename: "cli.js",
  });
}

export const registerMatrixQaCli: MatrixQaCliSurface["registerMatrixQaCli"] = ((...args) =>
  loadFacadeModule().registerMatrixQaCli(...args)) as MatrixQaCliSurface["registerMatrixQaCli"];

export function isMatrixQaCliAvailable(): boolean {
  try {
    loadFacadeModule();
    return true;
  } catch (error) {
    if (isMissingMatrixQaFacadeError(error)) {
      return false;
    }
    throw error;
  }
}
