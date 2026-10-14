import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ControlUiLinkPreview } from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { subscribeToSharedRequest } from "./shared-request-subscription.ts";

type Entry = {
  expiresAt: number;
  promise: Promise<ControlUiLinkPreview>;
  controller: AbortController;
  subscribers: Set<object>;
};
type PreviewCache = {
  generation: number;
  recoveryScope: string;
  entries: Map<string, Entry>;
};
// Browser cards and hovercards share one bounded projection of the Gateway's
// anonymous metadata cache. A reconnect cannot reuse an old authority's flight.
const previews = new WeakMap<GatewayBrowserClient, PreviewCache>();

export function clearLinkPreviews(client: GatewayBrowserClient): void {
  for (const entry of previews.get(client)?.entries.values() ?? []) {
    entry.controller.abort();
  }
  previews.delete(client);
}

function parsePreview(value: unknown): ControlUiLinkPreview {
  if (!isRecord(value)) {
    return {};
  }
  const text = (key: string, limit: number) =>
    typeof value[key] === "string"
      ? truncateUtf16Safe(value[key].replace(/\s+/gu, " ").trim(), limit)
      : undefined;
  const image = (key: string, limit: number) =>
    typeof value[key] === "string" &&
    value[key].length <= limit &&
    /^data:image\/(?:png|x-icon);base64,[A-Za-z0-9+/]+=*$/u.test(value[key])
      ? value[key]
      : undefined;
  return {
    title: text("title", 180),
    description: text("description", 400),
    imageDataUrl: image("imageDataUrl", 350_000),
    faviconDataUrl: image("faviconDataUrl", 90_000),
  };
}

export function loadLinkPreview(
  client: GatewayBrowserClient,
  url: string,
  signal?: AbortSignal,
): Promise<ControlUiLinkPreview> {
  let cache = previews.get(client);
  if (
    cache?.generation !== client.connectionGeneration ||
    cache?.recoveryScope !== client.recoveryScope
  ) {
    clearLinkPreviews(client);
    cache = undefined;
  }
  if (!cache) {
    cache = {
      generation: client.connectionGeneration,
      recoveryScope: client.recoveryScope,
      entries: new Map(),
    };
    previews.set(client, cache);
  }
  const parsed = URL.parse(url);
  if (
    !parsed ||
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    return Promise.resolve({});
  }
  parsed.hash = "";
  const key = parsed.href;
  const owner = cache;
  const cached = owner.entries.get(key);
  if (cached && !cached.controller.signal.aborted && cached.expiresAt > Date.now()) {
    return subscribeToSharedRequest(cached, {}, signal);
  }
  const controller = new AbortController();
  const entry: Entry = {
    expiresAt: Number.POSITIVE_INFINITY,
    controller,
    subscribers: new Set(),
    promise: client
      .request("controlUi.linkPreview", { url: key }, { signal: controller.signal })
      .then(
        (value) => {
          if (
            controller.signal.aborted ||
            previews.get(client) !== owner ||
            owner.generation !== client.connectionGeneration ||
            owner.recoveryScope !== client.recoveryScope
          ) {
            return {};
          }
          const preview = parsePreview(value);
          entry.expiresAt =
            Date.now() + (Object.values(preview).some(Boolean) ? 5 * 60_000 : 30_000);
          return preview;
        },
        () => {
          // Transport failures are not missing metadata; reconnect/reentry may retry.
          if (owner.entries.get(key) === entry) {
            owner.entries.delete(key);
          }
          return {};
        },
      ),
  };
  owner.entries.delete(key);
  owner.entries.set(key, entry);
  if (owner.entries.size > 32) {
    owner.entries.delete(owner.entries.keys().next().value!);
  }
  return subscribeToSharedRequest(entry, {}, signal);
}
