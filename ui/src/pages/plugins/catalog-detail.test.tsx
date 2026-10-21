import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { domProbe } from "../../test-helpers/dom-probe.ts";
import { mountSolid, cleanupSolid } from "../../test-helpers/mount-solid.ts";
import {
  renderPluginCatalogDetail as PluginCatalogDetail,
  type PluginCatalogDetailProps as Props,
} from "./catalog-detail.tsx";
import { createDiscoveryDetail, createPlugin } from "./plugins-page.test-support.ts";

afterEach(cleanupSolid);

function mount(result = createDiscoveryDetail(), overrides: Partial<Props> = {}) {
  const props: Props = {
    connected: true,
    result,
    error: null,
    backHref: "/plugins",
    onBack: vi.fn(),
    onRetry: vi.fn(),
    canInstall: true,
    installBlockedReason: null,
    onInstall: vi.fn(),
    iconUrls: {},
    ...overrides,
  };
  const view = mountSolid(() => <PluginCatalogDetail {...props} />);
  flush();
  return { container: view.container, ...domProbe(view.container) };
}

it("keeps long README tails and wires fenced-code controls", () => {
  const tail = "README_TAIL";
  const result = createDiscoveryDetail();
  result.detail.readme = `\`\`\`bash\necho demo\n\`\`\`\n${"x".repeat(150_000)}${tail}`;
  const { container, query, text } = mount(result);

  expect(query(".code-block-copy")).not.toBeNull();
  expect(container.textContent).toContain(tail);
  expect(text(".plugin-catalog-detail__readme-section > h2")).toBe("README");
});

it("uses a white tile for an official package icon", () => {
  const imageUrl = "https://example.com/icon.png";
  const result = createDiscoveryDetail(createPlugin({ origin: "official" }));
  result.plugin.catalog.imageUrl = imageUrl;
  const { query } = mount(result, { iconUrls: { [imageUrl]: "blob:package-icon" } });

  expect(query(".plugin-catalog-detail__icon .plugins-tile--white")).not.toBeNull();
});

it.each([
  { installed: false, canInstall: true, busy: false, primary: "Install" },
  { installed: false, canInstall: false, busy: false, primary: "Install" },
  { installed: false, canInstall: true, busy: true, primary: "Installing" },
  { installed: true, canInstall: false, busy: false, primary: "Ask OpenClaw" },
])("$primary ($canInstall/$busy)", ({ installed, canInstall, busy, primary }) => {
  const result = createDiscoveryDetail(createPlugin({ installed }));
  const onInstall = vi.fn();
  const onAskPlugin = vi.fn();
  const { query } = mount(result, { canInstall, busy, onInstall, onAskPlugin });
  const actions = query(".plugin-catalog-detail__actions")!;
  const primaryButton = actions.querySelector<HTMLButtonElement>("button.primary")!;
  expect(primaryButton.textContent?.trim()).toBe(primary);
  expect(actions.querySelectorAll("button.primary")).toHaveLength(1);
  expect(actions.querySelector("button")).toBe(primaryButton);
  primaryButton.click();
  expect(onInstall).toHaveBeenCalledTimes(canInstall && !busy ? 1 : 0);
  expect(primaryButton.querySelector(".btn__spinner") !== null).toBe(busy);
  expect(primaryButton.getAttribute("aria-busy")).toBe(busy ? "true" : null);
  const ask = [...actions.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "Ask OpenClaw",
  )!;
  ask.click();
  expect(onAskPlugin).toHaveBeenCalledTimes(installed ? 2 : 1);
});

it.each([false, true])("orders capabilities before tools (mixed=%s)", (mixed) => {
  const result = createDiscoveryDetail();
  result.detail.contracts = {
    videoGenerationProviders: ["heygen", "heygen-alias"],
    gatewayMethodDispatch: ["internal-dispatch"],
    ...(mixed ? { tools: ["render_status"] } : {}),
  };
  result.detail.uiCapabilities = ["link-reader", "widget"];
  result.detail.providers = ["model-provider"];
  result.detail.channels = ["messaging-channel"];
  result.detail.skills = mixed ? [{ name: "video-guide" }] : [];
  result.detail.mcpServers = mixed ? ["media-server"] : [];
  const { query, all, container } = mount(result);
  expect(query(".plugin-capabilities button")).toBeNull();
  expect([...all(".plugin-capabilities h2")].map((heading) => heading.textContent)).toEqual([
    "Capabilities3",
    ...(mixed ? ["Skills1", "Tools1", "MCP Server1"] : []),
  ]);
  expect([...all(".plugin-capabilities strong")].map((item) => item.textContent)).toEqual([
    "Video generation",
    "Dashboard widgets",
    "Link previews",
    ...(mixed ? ["video-guide", "render_status", "media-server"] : []),
  ]);
  expect(container.textContent).not.toMatch(/internal-dispatch|heygen-alias/);
});
