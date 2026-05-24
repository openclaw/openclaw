import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  formatSecretRefSupportedListMarkdown,
  formatSecretRefUnsupportedListMarkdown,
  replaceMarkedBlock,
} from "./credential-matrix-docs.js";
import { buildSecretRefCredentialMatrix } from "./credential-matrix.js";

const previousBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const previousTrustBundledPluginsDir = process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;

process.env.OPENCLAW_BUNDLED_PLUGINS_DIR ??= "extensions";
process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR ??= "1";

afterAll(() => {
  if (previousBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = previousBundledPluginsDir;
  }
  if (previousTrustBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = previousTrustBundledPluginsDir;
  }
});

const matrixPath = path.join(
  process.cwd(),
  "docs",
  "reference",
  "secretref-user-supplied-credentials-matrix.json",
);
const surfacePath = path.join(
  process.cwd(),
  "docs",
  "reference",
  "secretref-credential-surface.md",
);

const SUPPORTED_START = '[//]: # "secretref-supported-list-start"';
const SUPPORTED_END = '[//]: # "secretref-supported-list-end"';
const UNSUPPORTED_START = '[//]: # "secretref-unsupported-list-start"';
const UNSUPPORTED_END = '[//]: # "secretref-unsupported-list-end"';

const REGEN_HINT = `Run \`pnpm gen:secretref-docs\` to regenerate.`;

describe("secret target registry docs", () => {
  it("matrix JSON matches generator output", () => {
    const expected = `${JSON.stringify(buildSecretRefCredentialMatrix(), null, 2)}\n`;
    const actual = fs.readFileSync(matrixPath, "utf8");
    expect(actual, REGEN_HINT).toBe(expected);
  });

  it("credential-surface marker blocks match generator output", () => {
    const matrix = buildSecretRefCredentialMatrix();
    const surface = fs.readFileSync(surfacePath, "utf8");

    let expected = replaceMarkedBlock(surface, {
      startMarker: SUPPORTED_START,
      endMarker: SUPPORTED_END,
      body: formatSecretRefSupportedListMarkdown(matrix),
    });
    expected = replaceMarkedBlock(expected, {
      startMarker: UNSUPPORTED_START,
      endMarker: UNSUPPORTED_END,
      body: formatSecretRefUnsupportedListMarkdown(matrix),
    });

    expect(surface, REGEN_HINT).toBe(expected);
  });

  it("matrix and credential-surface marker blocks describe the same registry shape", () => {
    const matrix = buildSecretRefCredentialMatrix();
    const surface = fs.readFileSync(surfacePath, "utf8");

    const readMarkedCredentialList = (params: { start: string; end: string }): Set<string> => {
      const startIndex = surface.indexOf(params.start);
      const endIndex = surface.indexOf(params.end, startIndex + params.start.length);
      expect(startIndex).toBeGreaterThanOrEqual(0);
      expect(endIndex).toBeGreaterThan(startIndex);
      const block = surface.slice(startIndex + params.start.length, endIndex);
      const credentials = new Set<string>();
      for (const line of block.split(/\r?\n/)) {
        const match = line.match(/^- `([^`]+)`/);
        if (!match) {
          continue;
        }
        const candidate = match[1];
        if (!candidate.includes(".")) {
          continue;
        }
        credentials.add(candidate);
      }
      return credentials;
    };

    const supportedFromDocs = readMarkedCredentialList({
      start: SUPPORTED_START,
      end: SUPPORTED_END,
    });
    const unsupportedFromDocs = readMarkedCredentialList({
      start: UNSUPPORTED_START,
      end: UNSUPPORTED_END,
    });

    const supportedFromMatrix = new Set(
      matrix.entries.map((entry) =>
        entry.configFile === "auth-profiles.json" && entry.refPath ? entry.refPath : entry.path,
      ),
    );
    const unsupportedFromMatrix = new Set(matrix.excludedMutableOrRuntimeManaged);

    expect([...supportedFromDocs].toSorted()).toEqual([...supportedFromMatrix].toSorted());
    expect([...unsupportedFromDocs].toSorted()).toEqual([...unsupportedFromMatrix].toSorted());
  });
});
