import { createChangeListeners } from "../../../src/shared/listeners.js";

// `null` is a refused Gateway reconnect rather than one failed resource.
let reportHttpFailure: ((url: string | null) => void) | undefined;
const restoredListeners = createChangeListeners({ snapshot: true });

export function bindBrowserHttpFailures(listener: (url: string | null) => void): () => void {
  reportHttpFailure = listener;
  return () => {
    reportHttpFailure = undefined;
  };
}

export function reportBrowserAccessDenied(): void {
  reportHttpFailure?.(null);
}

export function subscribeBrowserAuthRestored(listener: () => void): () => void {
  const stop = restoredListeners.subscribe(listener);
  return () => {
    stop();
  };
}

export function notifyBrowserAuthRestored(): void {
  // A retry can replace its resource subscription during notification.
  restoredListeners.publish();
}

/** Preserve each caller's response, cancellation, and retry policy. */
export async function fetchControlUiResource(url: string, init?: RequestInit): Promise<Response> {
  const reportFailure = () => {
    if (!init?.signal?.aborted) {
      reportHttpFailure?.(url);
    }
  };
  try {
    const response = await fetch(url, init);
    if (response.status === 401) {
      reportFailure();
    }
    return response;
  } catch (error) {
    reportFailure();
    throw error;
  }
}
