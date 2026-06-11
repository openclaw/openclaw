import { describe, expect, it } from "vitest";
import {
  extractControlUiAssetRefs,
  extractControlUiFreshnessAuth,
  resolveControlUiFreshnessUrl,
} from "../../scripts/dev/control-ui-freshness-smoke.js";

describe("control-ui freshness smoke helpers", () => {
  it("extracts sorted hashed asset references from built dashboard HTML", () => {
    expect(
      extractControlUiAssetRefs(`
        <script type="module" src="./assets/index-new.js"></script>
        <link rel="stylesheet" href="/openclaw/assets/index-new.css">
        <script src="assets/chat-new.js"></script>
      `),
    ).toEqual(["assets/chat-new.js", "assets/index-new.css", "assets/index-new.js"]);
  });

  it("extracts bootstrap auth from query or fragment without needing to print it", () => {
    expect(extractControlUiFreshnessAuth("https://host/?token=query-secret")).toEqual({
      token: "query-secret",
      password: undefined,
    });
    expect(extractControlUiFreshnessAuth("https://host/#password=fragment-secret")).toEqual({
      token: undefined,
      password: "fragment-secret",
    });
  });

  it("resolves freshness URLs beside the dashboard route and strips fragments", () => {
    expect(
      resolveControlUiFreshnessUrl({
        dashboardUrl: "https://host.example/openclaw/chat#token=secret",
        relativePath: "./asset-manifest.json",
        cacheBust: "test",
      }),
    ).toBe("https://host.example/openclaw/asset-manifest.json?__openclaw_sw_update=test");
  });
});
