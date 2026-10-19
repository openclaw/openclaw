import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readInstalledPluginOverview } from "./installed-plugin-overview.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("reads the full installed README and package presentation without relying on ClawHub", () => {
  const rootDir = dirs.make("plugin-overview-");
  const readme = `# Local plugin\n${"Full instructions.\n".repeat(8000)}README_TAIL`;
  fs.writeFileSync(path.join(rootDir, "README.md"), readme);
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({
      repository: { url: "git+https://github.com/Acme/demo.git" },
      homepage: "https://example.org/docs",
      author: { name: "Acme" },
    }),
  );
  expect(
    withPluginCache(createPluginCache(), () =>
      readInstalledPluginOverview({
        rootDir,
        origin: "global",
        providers: ["local-model"],
        channels: ["local-channel"],
        contracts: { speechProviders: ["local-speech"] },
        uiCapabilities: ["link-reader"],
      }),
    ),
  ).toEqual({
    readme,
    repositoryUrl: "git+https://github.com/Acme/demo.git",
    documentationUrl: "https://example.org/docs",
    publisherName: "Acme",
    capabilities: {
      providers: ["local-model"],
      channels: ["local-channel"],
      contracts: { speechProviders: ["local-speech"] },
      ui: ["link-reader"],
    },
  });
});

it.each(["symlink", "hardlink", "oversize"])(
  "does not disclose a %s README outside the permitted artifact contract",
  (kind) => {
    const rootDir = dirs.make("plugin-overview-");
    const outside = path.join(dirs.make("plugin-overview-outside-"), "README.md");
    fs.writeFileSync(outside, "private outside content");
    const target = path.join(rootDir, "README.md");
    if (kind === "symlink") {
      fs.symlinkSync(outside, target);
    } else if (kind === "hardlink") {
      fs.linkSync(outside, target);
    } else {
      fs.writeFileSync(target, "x".repeat(524_289));
    }
    expect(
      withPluginCache(createPluginCache(), () =>
        readInstalledPluginOverview({ rootDir, origin: "global", providers: [], channels: [] }),
      )?.readme,
    ).toBeUndefined();
  },
);
