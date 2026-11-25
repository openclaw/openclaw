import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectControlUiModuleAttribution,
  collectControlUiCoverageAttribution,
  formatControlUiCoverageAttribution,
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
      return { file: `assets/${name}`, type: "js", servedGzipBytes: gzipBytes };
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
      chat: {
        assets: [shared, chat, { file: "assets/style.css", type: "css", servedGzipBytes: 10 }],
      },
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

  it("attributes nested coverage and fetched-only assets without confusing UTF-16 with bytes", () => {
    const dist = tempDirs.make("control-ui-coverage-attribution-");
    fs.mkdirSync(path.join(dist, "assets"));
    const code = "αα;aaa();bbb();🙂;\n";
    fs.writeFileSync(path.join(dist, "assets/shared.js"), code);
    fs.writeFileSync(
      path.join(dist, "assets/shared.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["../../ui/src/a.ts", "../../ui/src/b.ts"],
        names: [],
        mappings: "AAAA,S,MCAA;",
      }),
    );
    fs.writeFileSync(path.join(dist, "assets/prefetch.js"), "never()");
    fs.writeFileSync(
      path.join(dist, "assets/prefetch.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["../../ui/src/b.ts"],
        names: [],
        mappings: "AAAA",
      }),
    );
    fs.writeFileSync(path.join(dist, "assets/opaque.js"), "opaque");
    const coverage = [
      {
        url: "http://localhost/control/assets/shared.js",
        loadedBytes: 23,
        functions: [
          {
            ranges: [
              { startOffset: 0, endOffset: 19, count: 1 },
              { startOffset: 3, endOffset: 15, count: 0 },
              { startOffset: 9, endOffset: 12, count: 1 },
            ],
          },
        ],
      },
      {
        url: "http://localhost/control/assets/opaque.js",
        loadedBytes: 6,
        functions: [{ ranges: [{ startOffset: 0, endOffset: 6, count: 0 }] }],
      },
    ];
    const report = collectControlUiCoverageAttribution(
      dist,
      coverage,
      [
        ...coverage.map((entry) => ({ ...entry, decodedBytes: 0 })),
        { url: "http://localhost/control/assets/prefetch.js", decodedBytes: 7 },
        { url: "http://localhost/control/assets/prefetch.js", decodedBytes: 7 },
        { url: "http://localhost/control/assets/inflight.js", decodedBytes: 0 },
        { url: "http://localhost/control/assets/style.css", decodedBytes: 10 },
      ],
      "coverage cutoff",
    );
    expect(report).toMatchObject({
      loadedBytes: 36,
      executedBytes: 14,
      unusedBytes: 22,
      fetchedOnlyBytes: 7,
      inventoryScope: "coverage cutoff",
      missingSourceMaps: ["assets/opaque.js"],
      unmapped: { loadedBytes: 13, executedBytes: 4, unusedBytes: 9, fetchedOnlyBytes: 0 },
      modules: [
        {
          module: "ui/src/b.ts",
          loadedBytes: 12,
          executedBytes: 5,
          unusedBytes: 7,
          fetchedOnlyBytes: 7,
        },
        {
          module: "ui/src/a.ts",
          loadedBytes: 11,
          executedBytes: 5,
          unusedBytes: 6,
          fetchedOnlyBytes: 0,
        },
      ],
    });
    expect(report.assets).toHaveLength(3);
    expect(collectControlUiCoverageAttribution(dist, coverage, []).inventoryScope).toBe(
      "whole-run (may include later fetches)",
    );
    expect(collectControlUiCoverageAttribution(dist, coverage).inventoryScope).toBe("V8 only");
    expect(formatControlUiCoverageAttribution(report)).toContain("<unmapped>");
    expect(
      formatControlUiCoverageAttribution(collectControlUiCoverageAttribution(dist, coverage)),
    ).toContain("fetched-only scripts are excluded");
    expect(() =>
      collectControlUiCoverageAttribution(dist, [{ ...coverage[0]!, loadedBytes: 19 }]),
    ).toThrow("Coverage/bundle byte mismatch");
    expect(() =>
      collectControlUiCoverageAttribution(dist, [
        {
          ...coverage[0]!,
          functions: [{ ranges: [{ startOffset: 0, endOffset: 24, count: 1 }] }],
        },
      ]),
    ).toThrow("Coverage range outside bundle text");
  });
});
