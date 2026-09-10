import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { PluginDiscoveryDetailResult } from "../../lib/plugins/index.ts";
import { renderPluginCatalogDetail, renderPluginDetailReadme } from "./catalog-detail.ts";
import { clawHubPackageUrl } from "./catalog-links.ts";

describe("clawHubPackageUrl", () => {
  it("derives the publisher route from a scoped package when author metadata is absent", () => {
    expect(clawHubPackageUrl("@openclaw/matrix", undefined)).toBe(
      "https://clawhub.ai/openclaw/plugins/matrix",
    );
  });

  it("preserves the package-only route for unscoped packages without author metadata", () => {
    expect(clawHubPackageUrl("matrix", undefined)).toBe("https://clawhub.ai/plugins/matrix");
  });
});

describe("renderPluginDetailReadme", () => {
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

    render(renderPluginDetailReadme(result), container);

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
        tab: "readme",
        backHref: "/plugins",
        onBack: () => undefined,
        onRetry: () => undefined,
        onTabChange: () => undefined,
        canInstall: false,
        installBlockedReason: null,
        onInstall: () => undefined,
        iconUrls: {},
      }),
      container,
    );

    expect(container.querySelector(".plugin-catalog-detail__clawhub")).toBeNull();
  });
});
