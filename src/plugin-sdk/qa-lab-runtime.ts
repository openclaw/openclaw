import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

type QaLabRuntimeSurface = {
  defaultQaRuntimeModelForMode: (
    mode: string,
    options?: {
      alternate?: boolean;
      preferredLiveModel?: string;
    },
  ) => string;
  startQaLiveLaneGateway: (...args: unknown[]) => Promise<unknown>;
};

function isMissingQaLabRuntimeError(error: unknown) {
  return (
    error instanceof Error &&
    (error.message === "Unable to resolve bundled plugin public surface qa-lab/runtime-api.js" ||
      error.message.startsWith("Unable to open bundled plugin public surface "))
  );
}

export function loadQaLabRuntimeModule(): QaLabRuntimeSurface {
  return loadBundledPluginPublicSurfaceModuleSync<QaLabRuntimeSurface>({
    dirName: "qa-lab",
    artifactBasename: "runtime-api.js",
  });
}

export function isQaLabRuntimeAvailable(): boolean {
  try {
    loadQaLabRuntimeModule();
    return true;
  } catch (error) {
    if (isMissingQaLabRuntimeError(error)) {
      return false;
    }
    throw error;
  }
}
