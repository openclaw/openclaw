import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { PluginDiscoveryDetailResult } from "../../lib/plugins/index.ts";
import { renderPluginDetailReadme } from "./catalog-detail.ts";
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
