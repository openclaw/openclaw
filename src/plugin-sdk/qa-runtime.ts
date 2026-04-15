import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";
import { resolvePrivateQaBundledPluginsEnv } from "./private-qa-bundled-env.js";

const QA_LAB_DIR_NAME = ["qa", "-lab"].join("");
const QA_LAB_RUNTIME_ARTIFACT = ["runtime", "-api.js"].join("");
const MISSING_QA_RUNTIME_SURFACE_MESSAGE = [
  "Unable to resolve bundled plugin public surface ",
  QA_LAB_DIR_NAME,
  "/",
  QA_LAB_RUNTIME_ARTIFACT,
].join("");

type QaRuntimeSurface = {
  defaultQaRuntimeModelForMode: (
    mode: string,
    options?: {
      alternate?: boolean;
      preferredLiveModel?: string;
    },
  ) => string;
  startQaLiveLaneGateway: (...args: unknown[]) => Promise<unknown>;
};

function isMissingQaRuntimeError(error: unknown) {
  return (
    error instanceof Error &&
    (error.message === MISSING_QA_RUNTIME_SURFACE_MESSAGE ||
      error.message.startsWith("Unable to open bundled plugin public surface "))
  );
}

export function loadQaRuntimeModule(): QaRuntimeSurface {
  const env = resolvePrivateQaBundledPluginsEnv();
  return loadBundledPluginPublicSurfaceModuleSync<QaRuntimeSurface>({
    dirName: QA_LAB_DIR_NAME,
    artifactBasename: QA_LAB_RUNTIME_ARTIFACT,
    ...(env ? { env } : {}),
  });
}

export function isQaRuntimeAvailable(): boolean {
  try {
    loadQaRuntimeModule();
    return true;
  } catch (error) {
    if (isMissingQaRuntimeError(error)) {
      return false;
    }
    throw error;
  }
}
