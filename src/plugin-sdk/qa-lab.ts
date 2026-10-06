// Manual facade. Keep loader boundary explicit.
import { loadBundledPluginPublicSurfaceModuleSyncCore } from "./facade-loader.js";

type FacadeModule = {
  isQaLabCliAvailable: () => boolean;
  registerQaLabCli: (program: unknown) => void;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSyncCore<FacadeModule>({
    dirName: "qa-lab",
    artifactBasename: "cli.js",
  });
}

/** Register QA Lab CLI commands when the bundled QA Lab facade is present. */
export const registerQaLabCli: FacadeModule["registerQaLabCli"] = (...args) =>
  loadFacadeModule().registerQaLabCli(...args);

/** Returns whether the QA Lab CLI facade can be loaded in this package build. */
export const isQaLabCliAvailable: FacadeModule["isQaLabCliAvailable"] = () => {
  try {
    return loadFacadeModule().isQaLabCliAvailable();
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message === "Unable to resolve bundled plugin public surface qa-lab/cli.js" ||
        err.message.startsWith("Unable to open bundled plugin public surface "))
    ) {
      return false;
    }
    throw err;
  }
};
