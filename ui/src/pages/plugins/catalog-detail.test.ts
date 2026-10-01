import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginDiscoveryDetailResult } from "../../lib/plugins/index.ts";
import { renderPluginCatalogDetail } from "./catalog-detail.ts";
import { createDiscoveryDetail, createPlugin } from "./plugins-page.test-support.ts";

afterEach(() => document.body.replaceChildren());

describe("catalog README", () => {
  it("keeps long README tails and wires fenced-code controls", () => {
    const tail = "README_TAIL";
    const result = {
      plugin: {
        id: "ch_demo",
        catalog: {
          name: "Demo",
          packageName: "demo",
          family: "code-plugin",
          official: false,
          categories: [],
          publishedToClawHub: true,
        },
        local: {
          present: false,
          installed: false,
          enabled: false,
          state: "not-installed",
          action: "install",
        },
      },
      detail: {
        origin: "clawhub",
        packageName: "demo",
        topics: [],
        readme: `\`\`\`bash\necho demo\n\`\`\`\n${"x".repeat(150_000)}${tail}`,
        configuration: [],
        mcpServers: [],
        skills: [],
        versions: [],
      },
    } satisfies PluginDiscoveryDetailResult;
    const container = document.createElement("div");

    render(
      renderPluginCatalogDetail({
        connected: true,
        result,
        error: null,
        backHref: "/plugins",
        onBack: () => undefined,
        onRetry: () => undefined,
        canInstall: true,
        installBlockedReason: null,
        onInstall: () => undefined,
        iconUrls: {},
      }),
      container,
    );

    expect(container.querySelector(".code-block-copy")).not.toBeNull();
    expect(container.textContent).toContain(tail);
  });
});

describe("renderPluginCatalogDetail", () => {
  it("uses a white tile for an official package icon", () => {
    const imageUrl = "https://example.com/icon.png";
    const result = createDiscoveryDetail(createPlugin({ origin: "official" }));
    result.plugin.catalog.imageUrl = imageUrl;
    const container = document.createElement("div");

    render(
      renderPluginCatalogDetail({
        connected: true,
        result,
        error: null,
        backHref: "/plugins",
        onBack: vi.fn(),
        onRetry: vi.fn(),
        canInstall: true,
        installBlockedReason: null,
        onInstall: vi.fn(),
        iconUrls: { [imageUrl]: "blob:package-icon" },
      }),
      container,
    );

    expect(
      container.querySelector(".plugin-catalog-detail__icon .plugins-tile--white"),
    ).not.toBeNull();
  });

  it("does not invent a ClawHub link for an unproven local package", () => {
    const result = {
      plugin: {
        id: "local_ZGVtbw",
        catalog: {
          name: "Demo",
          packageName: "demo",
          official: false,
          categories: [],
        },
        local: {
          present: true,
          installed: true,
          enabled: false,
          state: "disabled",
          pluginId: "demo",
          action: "manage",
        },
      },
      detail: {
        origin: "local",
        packageName: "demo",
        topics: [],
        configuration: [],
        mcpServers: [],
        skills: [],
        versions: [],
      },
    } satisfies PluginDiscoveryDetailResult;
    const container = document.createElement("div");

    render(
      renderPluginCatalogDetail({
        connected: true,
        result,
        error: null,
        backHref: "/plugins",
        onBack: () => undefined,
        onRetry: () => undefined,
        canInstall: false,
        installBlockedReason: null,
        onInstall: () => undefined,
        iconUrls: {},
      }),
      container,
    );

    expect(container.querySelector('a[href^="https://clawhub.ai/"]')).toBeNull();
  });
});

it.each([
  { installed: false, canInstall: true, busy: false, primary: "Install" },
  { installed: false, canInstall: false, busy: false, primary: "Install" },
  { installed: false, canInstall: true, busy: true, primary: "Installing" },
  { installed: true, canInstall: false, busy: false, primary: "Ask OpenClaw" },
])(
  "prioritizes $primary with installed=$installed, canInstall=$canInstall, busy=$busy",
  async ({ installed, canInstall, busy, primary }) => {
    const result = createDiscoveryDetail();
    result.plugin.local.installed = installed;
    result.plugin.local.action = installed ? "manage" : "install";
    const onInstall = vi.fn();
    const onAskPlugin = vi.fn();
    const container = document.createElement("div");
    render(
      renderPluginCatalogDetail({
        connected: true,
        result,
        error: null,
        backHref: "/plugins",
        onBack: vi.fn(),
        onRetry: vi.fn(),
        canInstall,
        busy,
        installBlockedReason: null,
        onInstall,
        onAskPlugin,
        iconUrls: {},
      }),
      container,
    );
    document.body.append(container);
    await container.querySelector("openclaw-plugin-install-action")?.updateComplete;
    const actions = container.querySelector(".plugin-catalog-detail__actions")!;
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
  },
);

it.each([false, true])(
  "renders user capabilities before tools without redundant provider or channel lists (mixed=%s)",
  (mixed) => {
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
    const container = document.createElement("div");
    render(
      renderPluginCatalogDetail({
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
      }),
      container,
    );
    const sections = [...container.querySelectorAll(".plugin-capabilities")];
    expect(container.querySelector(".plugin-capabilities button")).toBeNull();
    expect(sections.map((section) => section.querySelector("h2")?.textContent)).toEqual([
      "Capabilities3",
      ...(mixed ? ["Skills1", "Tools1", "MCP servers1"] : []),
    ]);
    expect(
      sections.flatMap((section) =>
        [...section.querySelectorAll("strong")].map((item) => item.textContent),
      ),
    ).toEqual([
      "Video generation",
      "Dashboard widgets",
      "Link previews",
      ...(mixed ? ["video-guide", "render_status", "media-server"] : []),
    ]);
    expect(container.textContent).not.toContain("internal-dispatch");
    expect(container.textContent).not.toContain("heygen-alias");
  },
);
