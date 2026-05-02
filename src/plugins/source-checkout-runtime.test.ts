import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadOpenClawPlugins } from "./loader.js";

describe("source checkout bundled plugin runtime", () => {
  it("loads enabled bundled plugins from built dist when available", () => {
    const registry = loadOpenClawPlugins({
      cache: false,
      onlyPluginIds: ["twitch"],
      config: {
        plugins: {
          entries: {
            twitch: { enabled: true },
          },
        },
      },
    });

    const twitch = registry.plugins.find((plugin) => plugin.id === "twitch");
    expect(twitch).toMatchObject({
      status: "loaded",
      origin: "bundled",
    });
    expect(twitch?.source).toContain(
      `${path.sep}dist${path.sep}extensions${path.sep}twitch${path.sep}index.js`,
    );
    expect(twitch?.rootDir).toContain(`${path.sep}dist${path.sep}extensions${path.sep}twitch`);
  });
});
