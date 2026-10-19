let reportHttpFailure: ((url: string) => void) | undefined;
const restoredListeners = new Set<() => void>();

export function bindBrowserHttpFailures(listener: (url: string) => void): () => void {
  reportHttpFailure = listener;
  return () => {
    reportHttpFailure = undefined;
  };
}

export function subscribeBrowserAuthRestored(listener: () => void): () => void {
  restoredListeners.add(listener);
  return () => void restoredListeners.delete(listener);
}

export function notifyBrowserAuthRestored(): void {
  // A retry can replace its resource subscription during notification.
  const listeners = [...restoredListeners];
  for (const listener of listeners) {
    listener();
  }
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
