import { isChannelStartupSuppressedByEnvironment } from "./server-sidecar-startup-mode.js";

export function createChannelAutostartRecovery(params: {
  getSuppression: () => object | null;
  clearSuppression: () => void;
  tryRecover?: () => Promise<boolean>;
  isClosing?: () => boolean;
  startChannels: () => Promise<void>;
}): () => Promise<boolean> {
  let recovery: Promise<boolean> | undefined;
  return async () => {
    if (recovery) {
      return await recovery;
    }
    const suppression = params.getSuppression();
    if (!suppression || params.isClosing?.()) {
      return false;
    }
    recovery = (async () => {
      if (
        !(await params.tryRecover?.()) ||
        params.isClosing?.() ||
        params.getSuppression() !== suppression
      ) {
        return false;
      }
      params.clearSuppression();
      if (!isChannelStartupSuppressedByEnvironment()) {
        await params.startChannels();
      }
      return true;
    })();
    try {
      return await recovery;
    } finally {
      recovery = undefined;
    }
  };
}
