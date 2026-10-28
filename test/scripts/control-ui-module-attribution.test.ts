import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectControlUiModuleAttribution,
  formatControlUiModuleAttribution,
} from "../../scripts/lib/control-ui-module-attribution.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

describe("Control UI emitted module attribution", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("partitions route assets by emitted ranges, retaining UTF-8 and unmapped bytes", () => {
    const dist = tempDirs.make("control-ui-module-attribution-");
    const assetsDir = path.join(dist, "assets");
    fs.mkdirSync(assetsDir);
    const asset = (name: string, code: string, gzipBytes: number) => {
      fs.writeFileSync(path.join(assetsDir, name), code);
      return { file: `assets/${name}`, type: "js", gzipBytes };
    };
    const shared = asset("shared.js", "p;const a='é';x;const b=2;\n// tail\n", 90);
    const chat = asset("chat.js", "opaque chunk", 40);
    const newSession = asset("new.js", "newOnly()", 30);
    fs.writeFileSync(
      path.join(assetsDir, "shared.js.map"),
      JSON.stringify({
        version: 3,
        sources: [
          "/build/node_modules/.pnpm/example@1.0.0/node_modules/example/a.js",
          "../../ui/src/b.ts",
        ],
        // Deliberately unrelated source sizes: measure emitted code, not these.
        sourcesContent: ["", "very large original source".repeat(200)],
        names: [],
        mappings: "EAAA,W,ECAA;;",
      }),
    );
    fs.writeFileSync(
      path.join(assetsDir, "new.js.map"),
      JSON.stringify({
        version: 3,
        sourceRoot: "/other-build/node_modules/example",
        sources: ["a.js"],
        names: [],
        mappings: "AAAA",
      }),
    );

    const result = collectControlUiModuleAttribution(dist, {
      chat: { assets: [shared, chat, { file: "assets/style.css", type: "css", gzipBytes: 10 }] },
      new: { assets: [shared, newSession] },
    });
    expect(result.chat).toMatchObject({
      shippedGzipBytes: 130,
      mappedRawBytes: 23,
      unmappedRawBytes: 25,
      missingSourceMaps: ["assets/chat.js"],
    });
    expect(result.chat!.modules).toEqual(
      expect.arrayContaining([
        {
          module: "node_modules/example/a.js",
          rawBytes: 12,
          standaloneGzipBytes: expect.any(Number),
        },
        { module: "ui/src/b.ts", rawBytes: 11, standaloneGzipBytes: expect.any(Number) },
      ]),
    );
    expect(result.new).toMatchObject({
      shippedGzipBytes: 120,
      mappedRawBytes: 32,
      unmappedRawBytes: 13,
      missingSourceMaps: [],
    });
    expect(result.new!.modules).toContainEqual({
      module: "node_modules/example/a.js",
      rawBytes: 21,
      standaloneGzipBytes: expect.any(Number),
    });
    expect(result.new!.modules).toHaveLength(2);
    const report = formatControlUiModuleAttribution(result);
    expect(report).toContain("non-additive");
    expect(report).toContain("25 B unmapped raw");
    expect(report).toContain("missing source map: assets/chat.js");
  });
});
