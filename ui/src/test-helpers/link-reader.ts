import type {
  ControlUiLinkReaderDescriptor,
  ControlUiLinkReaderPreview,
} from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";

export const TEST_LINK_READER: ControlUiLinkReaderDescriptor = {
  pluginId: "forge",
  id: "items",
  label: "Forge",
  linkReader: {
    hosts: ["github.com", "forge.example"],
    pathPattern: "^/(?:[^/]+/[^/]+/(?:issues|pull)/[0-9]+/?|items/[0-9]+)$",
    detailMethod: "forge.detail",
    previewMethod: "forge.preview",
  },
};
export function installTestLinkReader<T extends HTMLElement>(provider: T): T {
  Object.assign(provider, {
    readers: [TEST_LINK_READER],
    client: { request: () => new Promise(() => {}) } as unknown as GatewayBrowserClient,
  });
  return provider;
}
export function testLinkPreview(
  overrides: Partial<ControlUiLinkReaderPreview> = {},
): ControlUiLinkReaderPreview {
  return {
    url: "https://github.com/openclaw/openclaw/issues/99815",
    title: "Keep hover previews reachable",
    subtitle: "openclaw/openclaw #99815",
    author: "octocat",
    updatedAt: "2026-07-05T09:55:00Z",
    badge: { label: "Open", tone: "positive" },
    metadata: [{ label: "Comments", value: "2" }],
    ...overrides,
  };
}
