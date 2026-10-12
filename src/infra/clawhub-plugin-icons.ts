import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  fetchClawHubJson,
  readClawHubStringField,
  resolveClawHubImageUrl,
  type ClawHubRequestParams,
} from "./clawhub-client.js";

/** Branding needs one package read, not versions, README or security enrichment. */
export async function fetchClawHubPluginIconUrls(
  params: Pick<ClawHubRequestParams, "baseUrl" | "skipAuth" | "timeoutMs" | "fetchImpl"> & {
    packageName: string;
  },
): Promise<string[]> {
  const value = await fetchClawHubJson<unknown>({
    ...params,
    path: `/api/v1/packages/${encodeURIComponent(params.packageName)}`,
    retryTransientReads: false,
  });
  if (!isRecord(value) || !isRecord(value.package)) {
    throw new Error("Malformed ClawHub plugin icon response: expected a package object.");
  }
  if (value.package.name !== params.packageName) {
    throw new Error("ClawHub plugin icon response changed the requested package identity.");
  }
  const owner = value.owner;
  if (owner != null && !isRecord(owner)) {
    throw new Error("Malformed ClawHub plugin icon response: expected an owner object.");
  }
  const icon = readClawHubStringField(value.package, "icon", "plugin icon");
  const image = owner ? readClawHubStringField(owner, "image", "plugin owner") : undefined;
  return [icon, image].flatMap((url) =>
    url ? [resolveClawHubImageUrl(url, params.baseUrl) ?? url] : [],
  );
}
