import { expect, it } from "vitest";
import { resolveBundledWebSearchPluginIds } from "./bundled-web-search.js";

it("keeps bundled web search compat ids aligned with bundled manifests", () => {
  expect(resolveBundledWebSearchPluginIds({})).toEqual([
    "brave",
    "firecrawl",
    "google",
    "moonshot",
    "perplexity",
    "xai",
  ]);
});
