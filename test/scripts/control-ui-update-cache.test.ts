import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("reports payload roots and cycles without treating source maps as chunk dependencies", () => {
  const root = tempDirs.make("openclaw-update-cache-");
  const builds = ["base", "head"].map((side, index) => {
    const directory = path.join(root, side);
    fs.mkdirSync(path.join(directory, "assets"), { recursive: true });
    const a = `a-${index ? "cccccccc" : "aaaaaaaa"}.js`;
    const b = `b-${index ? "dddddddd" : "bbbbbbbb"}.js`;
    const leaf = `leaf-${index ? "22222222" : "11111111"}.js`;
    const files = {
      [a]: `import "./${b}"; export const load = () => import("./${leaf}"); const css = ["theme-ssssssss.css"];`,
      [b]: `import "./${a}"; /*# sourceMappingURL=./map-mmmmmmmm.js */\n//# sourceMappingURL=./map-mmmmmmmm.js\n`,
      [leaf]: `export const value = ${index + 1};`,
      "theme-ssssssss.css": "body { color: red; }",
      "unchanged-uuuuuuuu.js": "export const unchanged = true;",
      "map-mmmmmmmm.js": '{"version":3,"sources":[],"mappings":""}',
    };
    for (const [file, source] of Object.entries(files)) {
      fs.writeFileSync(path.join(directory, "assets", file), source);
    }
    fs.writeFileSync(path.join(directory, "index.html"), `<script src="./assets/${a}"></script>`);
    fs.writeFileSync(
      path.join(directory, "sw.js"),
      `const OFFLINE_BOOT = ${JSON.stringify({
        publicAssetVersion: "same",
        publicAssets: [],
        assets: [],
        deferredAssets: [],
      })};\n`,
    );
    return directory;
  });
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.resolve("scripts/compare-control-ui-update-cache.ts"),
        "--base-dir",
        builds[0]!,
        "--head-dir",
        builds[1]!,
      ],
      { encoding: "utf8", timeout: 10_000 },
    ),
  );
  expect(report.referenceGraph.head).toEqual({
    nodes: {
      "assets/a-cccccccc.js": [
        "assets/b-dddddddd.js",
        "assets/leaf-22222222.js",
        "assets/theme-ssssssss.css",
      ],
      "assets/b-dddddddd.js": ["assets/a-cccccccc.js"],
      "assets/leaf-22222222.js": [],
      "assets/map-mmmmmmmm.js": [],
      "assets/theme-ssssssss.css": [],
      "assets/unchanged-uuuuuuuu.js": [],
    },
    edgeCount: 4,
    stronglyConnectedComponents: [["assets/a-cccccccc.js", "assets/b-dddddddd.js"]],
  });
  expect(report.referenceGraph.payloadRoots).toEqual([
    {
      path: "assets/leaf-22222222.js",
      previousPath: "assets/leaf-11111111.js",
      change: "renamed-payload-change",
      directReferrers: ["assets/a-cccccccc.js"],
      reachableReferrers: ["assets/a-cccccccc.js", "assets/b-dddddddd.js"],
    },
  ]);
  expect(report.all).toMatchObject({
    "identical-path-content": { count: 4 },
    "renamed-hash-reference-only": { count: 3 },
    "renamed-payload-change": { count: 1 },
  });
});
