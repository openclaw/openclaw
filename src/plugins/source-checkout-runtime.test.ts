import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadOpenClawPlugins } from "./loader.js";

describe("source checkout bundled plugin runtime", () => {
  it("loads enabled bundled plugins from built dist or source checkout", () => {
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

    const runtimeCandidates = [
      `${path.sep}dist${path.sep}extensions${path.sep}twitch${path.sep}index.js`,
      `${path.sep}extensions${path.sep}twitch${path.sep}index.ts`,
    ];
    const rootCandidates = [
      `${path.sep}dist${path.sep}extensions${path.sep}twitch`,
      `${path.sep}extensions${path.sep}twitch`,
    ];
    const includesAny = (actual: string | undefined, candidates: readonly string[]) =>
      actual !== undefined && candidates.some((candidate) => actual.includes(candidate));

    expect(includesAny(twitch?.source, runtimeCandidates)).toBe(true);
    expect(includesAny(twitch?.rootDir, rootCandidates)).toBe(true);
  });
});
