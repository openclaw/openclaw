import { describe, expect, it } from "vitest";
import { listBundledPluginPackArtifacts } from "../scripts/lib/bundled-plugin-build-entries.mjs";
import { listPluginSdkDistArtifacts } from "../scripts/lib/plugin-sdk-entries.mjs";
import {
  collectAppcastSparkleVersionErrors,
  collectBundledExtensionManifestErrors,
  collectForbiddenPackPaths,
  collectMissingPackPaths,
  collectPackUnpackedSizeErrors,
} from "../scripts/release-check.ts";
import { bundledDistPluginFile, bundledPluginFile } from "./helpers/bundled-plugin-paths.js";

function makeItem(shortVersion: string, sparkleVersion: string): string {
  return `<item><title>${shortVersion}</title><sparkle:shortVersionString>${shortVersion}</sparkle:shortVersionString><sparkle:version>${sparkleVersion}</sparkle:version></item>`;
}

function makePackResult(filename: string, unpackedSize: number) {
  return { filename, unpackedSize };
}

const requiredPluginSdkPackPaths = [...listPluginSdkDistArtifacts(), "dist/plugin-sdk/compat.js"];
const requiredBundledPluginPackPaths = listBundledPluginPackArtifacts();
const requiredMatrixCryptoWasmPackPaths = ["dist/pkg/matrix_sdk_crypto_wasm_bg.wasm"];

describe("collectAppcastSparkleVersionErrors", () => {
  it("accepts legacy 9-digit calver builds before lane-floor cutover", () => {
    const xml = `<rss><channel>${makeItem("2026.2.26", "202602260")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toEqual([]);
  });

  it("requires lane-floor builds on and after lane-floor cutover", () => {
    const xml = `<rss><channel>${makeItem("2026.3.1", "202603010")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toEqual([
      "appcast item '2026.3.1' has sparkle:version 202603010 below lane floor 2026030190.",
    ]);
  });

  it("accepts canonical stable lane builds on and after lane-floor cutover", () => {
    const xml = `<rss><channel>${makeItem("2026.3.1", "2026030190")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toEqual([]);
  });
});

describe("collectBundledExtensionManifestErrors", () => {
  it("flags invalid bundled extension install metadata", () => {
    expect(
      collectBundledExtensionManifestErrors([
        {
          id: "broken",
          packageJson: {
            openclaw: {
              install: { npmSpec: "   " },
            },
          },
        },
      ]),
    ).toEqual([
      "bundled extension 'broken' manifest invalid | openclaw.install.npmSpec must be a non-empty string",
    ]);
  });

  it("flags invalid bundled extension minHostVersion metadata", () => {
    expect(
      collectBundledExtensionManifestErrors([
        {
          id: "broken",
          packageJson: {
            openclaw: {
              install: { npmSpec: "@openclaw/broken", minHostVersion: "2026.3.14" },
            },
          },
        },
      ]),
    ).toEqual([
      "bundled extension 'broken' manifest invalid | openclaw.install.minHostVersion must use a semver floor in the form \">=x.y.z\"",
    ]);
  });

  it("allows install metadata without npmSpec when only non-publish metadata is present", () => {
    expect(
      collectBundledExtensionManifestErrors([
        {
          id: "irc",
          packageJson: {
            openclaw: {
              install: { minHostVersion: ">=2026.3.14" },
            },
          },
        },
      ]),
    ).toEqual([]);
  });

  it("flags non-object install metadata instead of throwing", () => {
    expect(
      collectBundledExtensionManifestErrors([
        {
          id: "broken",
          packageJson: {
            openclaw: {
              install: 123,
            },
          },
        },
      ]),
    ).toEqual(["bundled extension 'broken' manifest invalid | openclaw.install must be an object"]);
  });
});

describe("collectForbiddenPackPaths", () => {
  it("allows bundled plugin runtime deps under dist/extensions but still blocks other node_modules", () => {
    expect(
      collectForbiddenPackPaths([
        "dist/index.js",
        bundledDistPluginFile("discord", "node_modules/@buape/carbon/index.js"),
        bundledPluginFile("tlon", "node_modules/.bin/tlon"),
        "node_modules/.bin/openclaw",
      ]),
    ).toEqual([bundledPluginFile("tlon", "node_modules/.bin/tlon"), "node_modules/.bin/openclaw"]);
  });
});

describe("collectMissingPackPaths", () => {
  it("requires the shipped channel catalog, control ui, and optional bundled metadata", () => {
    const missing = collectMissingPackPaths([
      "dist/index.js",
      "dist/entry.js",
      "dist/plugin-sdk/compat.js",
      "dist/plugin-sdk/index.js",
      "dist/plugin-sdk/index.d.ts",
      "dist/plugin-sdk/root-alias.cjs",
      "dist/build-info.json",
    ]);

    expect(missing).toEqual(
      expect.arrayContaining([
        "dist/channel-catalog.json",
        "dist/control-ui/index.html",
        "dist/pkg/matrix_sdk_crypto_wasm_bg.wasm",
        bundledDistPluginFile("matrix", "helper-api.js"),
        bundledDistPluginFile("matrix", "runtime-api.js"),
        bundledDistPluginFile("matrix", "thread-bindings-runtime.js"),
        bundledDistPluginFile("matrix", "openclaw.plugin.json"),
        bundledDistPluginFile("matrix", "package.json"),
        bundledDistPluginFile("whatsapp", "light-runtime-api.js"),
        bundledDistPluginFile("whatsapp", "runtime-api.js"),
        bundledDistPluginFile("whatsapp", "openclaw.plugin.json"),
        bundledDistPluginFile("whatsapp", "package.json"),
      ]),
    );
  });

  it("accepts the shipped upgrade surface when optional bundled metadata is present", () => {
    expect(
      collectMissingPackPaths([
        "dist/index.js",
        "dist/entry.js",
        "dist/control-ui/index.html",
        ...requiredBundledPluginPackPaths,
        ...requiredMatrixCryptoWasmPackPaths,
        ...requiredPluginSdkPackPaths,
        "dist/plugin-sdk/root-alias.cjs",
        "dist/build-info.json",
        "dist/channel-catalog.json",
      ]),
    ).toEqual([]);
  });

  it("requires bundled plugin runtime sidecars that dynamic plugin boundaries resolve at runtime", () => {
    expect(requiredBundledPluginPackPaths).toEqual(
      expect.arrayContaining([
        bundledDistPluginFile("matrix", "helper-api.js"),
        bundledDistPluginFile("matrix", "runtime-api.js"),
        bundledDistPluginFile("matrix", "thread-bindings-runtime.js"),
        bundledDistPluginFile("whatsapp", "light-runtime-api.js"),
        bundledDistPluginFile("whatsapp", "runtime-api.js"),
      ]),
    );
  });
});

describe("collectPackUnpackedSizeErrors", () => {
  it("accepts pack results within the unpacked size budget", () => {
    expect(
      collectPackUnpackedSizeErrors([makePackResult("openclaw-2026.3.14.tgz", 120_354_302)]),
    ).toEqual([]);
  });

  it("flags oversized pack results that risk low-memory startup failures", () => {
    expect(
      collectPackUnpackedSizeErrors([makePackResult("openclaw-2026.3.12.tgz", 224_002_564)]),
    ).toEqual([
      "openclaw-2026.3.12.tgz unpackedSize 224002564 bytes (213.6 MiB) exceeds budget 200278016 bytes (191.0 MiB). Investigate duplicate channel shims, copied extension trees, or other accidental pack bloat before release.",
    ]);
  });

  it("fails closed when npm pack output omits unpackedSize for every result", () => {
    expect(
      collectPackUnpackedSizeErrors([
        { filename: "openclaw-2026.3.14.tgz" },
        { filename: "openclaw-extra.tgz", unpackedSize: Number.NaN },
      ]),
    ).toEqual([
      "npm pack --dry-run produced no unpackedSize data; pack size budget was not verified.",
    ]);
  });
});
