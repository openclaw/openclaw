import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";

type ControlUiAuthSource = {
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
  settings?: { token?: string | null } | null;
  password?: string | null;
};

// Saved tokens and passwords are Bearer credentials too. Keep them after the
// live device token so callers can recover from a rejected credential.
export function resolveControlUiAuthCandidates(source: ControlUiAuthSource): string[] {
  return normalizeUniqueTrimmedStringList([
    source.hello?.auth?.deviceToken,
    source.settings?.token,
    source.password,
  ]).filter((token) => !/[\r\n]/.test(token));
}

export function resolveControlUiAuthToken(source: ControlUiAuthSource): string | null {
  return resolveControlUiAuthCandidates(source)[0] ?? null;
}

export async function fetchWithControlUiAuth(
  url: string,
  init: Omit<RequestInit, "headers" | "signal"> & {
    headers?: Record<string, string>;
    signal: AbortSignal;
  },
  authCandidates: readonly string[],
  isCurrent: () => boolean,
): Promise<Response> {
  const candidates = authCandidates.length ? authCandidates : [""];
  const readOnly = !init.method || init.method === "GET" || init.method === "HEAD";
  for (let index = 0; ; index++) {
    init.signal.throwIfAborted();
    if (!isCurrent()) {
      throw new DOMException("Gateway request is no longer current", "AbortError");
    }
    const token = candidates[index];
    const response = await fetch(url, {
      ...init,
      ...(token ? { headers: { ...init.headers, Authorization: `Bearer ${token}` } } : {}),
    });
    init.signal.throwIfAborted();
    // A mutation's 403 is a scope/origin rejection, not a rejected credential.
    if (
      index === candidates.length - 1 ||
      (response.status !== 401 && !(readOnly && response.status === 403))
    ) {
      return response;
    }
    void response.body?.cancel().catch(() => undefined);
  }
}
