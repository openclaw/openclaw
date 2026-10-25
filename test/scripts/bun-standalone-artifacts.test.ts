import vm from "node:vm";
import { parse as parseAcorn } from "acorn";
import { describe, expect, it } from "vitest";
import { createStandaloneArtifactAdapter } from "../../scripts/lib/bun-standalone-artifacts.mjs";
import { createStandaloneParser } from "../../scripts/lib/bun-standalone-parser.mjs";
import { createStandaloneSourceParser } from "../../scripts/lib/bun-standalone-source-parser.mjs";

const runtimeRoot = "/removed-build/runtime";
const parsers = [
  { name: "Acorn", parse: createStandaloneParser(parseAcorn) },
  { name: "Babel ESTree", parse: createStandaloneSourceParser() },
];

describe.each(parsers)("standalone artifact syntax contract: $name", ({ parse }) => {
  function transform(contents: string) {
    return createStandaloneArtifactAdapter({
      runtimeRoot,
      embeddedPaths: { "dist/extensions/example/index.js": "/$bunfs/root/example.js" },
      parse,
    }).transform({ filename: `${runtimeRoot}/dist/owner.mjs`, contents });
  }

  it("delegates fingerprint identity and retains the original fallback body", () => {
    const marker = "openclaw-plugin-runtime-artifact-v1\0";
    const adapted = transform(`// π 🦞\r\nlet fallbacks = 0;
function fingerprint(record) { fallbacks++; return JSON.stringify([${JSON.stringify(marker)}, record]); }
({ fingerprint, readFallbacks: () => fallbacks });`);
    expect(adapted.count).toBe(1);
    const hook: { identity: string | undefined } = { identity: "image-identity" };
    const loaded = vm.runInNewContext(adapted.contents, {
      __openclawStandaloneFingerprintArtifact: () => hook.identity,
    });
    expect(loaded.fingerprint({ id: 7 })).toBe("image-identity");
    expect(loaded.readFallbacks()).toBe(0);
    hook.identity = undefined;
    expect(loaded.fingerprint({ id: 7 })).toBe(JSON.stringify([marker, { id: 7 }]));
    expect(loaded.readFallbacks()).toBe(1);
  });

  it("rewrites the owning capture call through its nested availability check", () => {
    const marker = "Bundled plugin code changed; restart the Gateway before using state operations";
    const adapted = transform(`function prepare(root, paths) {
  const selected = capture(root || ".", paths);
  function assertAvailable() { throw new Error(${JSON.stringify(marker)}); }
  return selected;
}
prepare("", ["entry.js"]);`);
    expect(adapted.count).toBe(1);
    const captured: unknown[][] = [];
    const original = () => {
      throw new Error("Unexpected original capture");
    };
    expect(
      vm.runInNewContext(adapted.contents, {
        capture: original,
        __openclawStandaloneCaptureOperationArtifact: (...args: unknown[]) => {
          captured.push(args);
          return "image-capture";
        },
      }),
    ).toBe("image-capture");
    expect(captured).toEqual([[original, ".", ["entry.js"]]]);
  });

  it("admits the image plugin before running fallback counters", () => {
    const adapted =
      transform(`const counters = { calls: 0, nativeHits: 0, sourceTransformFallbacks: 0, sourceTransformForced: 0 };
function load(target) { return invoke(() => {
  counters.calls += 1;
  counters.nativeHits += 1;
  counters.sourceTransformFallbacks += 1;
  counters.sourceTransformForced += 1;
  return "fallback";
}); }
({ load, counters });`);
    expect(adapted.count).toBe(1);
    const loaded = vm.runInNewContext(adapted.contents, {
      invoke: (callback: () => unknown) => callback(),
      __openclawStandaloneLoadPluginModule: (target: string) =>
        target === "embedded" ? { moduleExport: "image" } : undefined,
    });
    expect(loaded.load("embedded")).toBe("image");
    expect(loaded.counters).toEqual({
      calls: 1,
      nativeHits: 1,
      sourceTransformFallbacks: 0,
      sourceTransformForced: 0,
    });
    expect(loaded.load("external")).toBe("fallback");
    expect(loaded.counters).toEqual({
      calls: 2,
      nativeHits: 2,
      sourceTransformFallbacks: 1,
      sourceTransformForced: 1,
    });
  });
});
