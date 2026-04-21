import { normalizeOptionalString } from "./string-coerce.ts";

type ControlUiAuthSource = {
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
  settings?: { token?: string | null } | null;
  password?: string | null;
};

export function resolveControlUiAuthToken(source: ControlUiAuthSource): string | null {
  return (
    normalizeOptionalString(source.hello?.auth?.deviceToken) ??
    normalizeOptionalString(source.settings?.token) ??
    normalizeOptionalString(source.password) ??
    null
  );
}

export function resolveControlUiAuthHeader(source: ControlUiAuthSource): string | null {
  const token = resolveControlUiAuthToken(source);
  return token ? `Bearer ${token}` : null;
}

export function appendControlUiAuthToken(url: string, authToken?: string | null): string {
  const token = authToken?.trim();
  if (!token) {
    return url;
  }
  const hashIndex = url.indexOf("#");
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const pathAndQuery = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  if (/^https?:\/\//i.test(pathAndQuery) || /^data:image\//i.test(pathAndQuery)) {
    return url;
  }
  const queryIndex = pathAndQuery.indexOf("?");
  const path = queryIndex >= 0 ? pathAndQuery.slice(0, queryIndex) : pathAndQuery;
  const query = queryIndex >= 0 ? pathAndQuery.slice(queryIndex + 1) : "";
  const params = new URLSearchParams(query);
  if (!params.has("token")) {
    params.set("token", token);
  }
  const nextQuery = params.toString();
  return `${path}${nextQuery ? `?${nextQuery}` : ""}${hash}`;
}
