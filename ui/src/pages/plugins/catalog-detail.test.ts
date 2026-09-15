import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { PluginDiscoveryDetailResult } from "../../lib/plugins/index.ts";
import { renderPluginCatalogDetail } from "./catalog-detail.ts";

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
