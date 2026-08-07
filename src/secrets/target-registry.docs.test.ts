/** Verifies docs stay aligned with the secret target registry. */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  renderSecretRefCredentialMatrixJson,
  renderSecretRefCredentialSurface,
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

describe("secret target registry docs", () => {
  let matrixDocsCase: { raw: string; expected: string };

  beforeAll(() => {
    const pathname = path.join(
      process.cwd(),
      "docs",
      "reference",
      "secretref-user-supplied-credentials-matrix.json",
    );
    const raw = fs.readFileSync(pathname, "utf8");
    const expected = renderSecretRefCredentialMatrixJson(buildSecretRefCredentialMatrix());
    matrixDocsCase = { raw, expected };
  });

  it("stays in sync with docs/reference/secretref-user-supplied-credentials-matrix.json", () => {
    expect(matrixDocsCase.raw).toBe(matrixDocsCase.expected);
  });

  it("stays in sync with docs/reference/secretref-credential-surface.md", () => {
    const surfacePath = path.join(
      process.cwd(),
      "docs",
      "reference",
      "secretref-credential-surface.md",
    );
    const surface = fs.readFileSync(surfacePath, "utf8");
    expect(surface).toBe(
      renderSecretRefCredentialSurface(surface, buildSecretRefCredentialMatrix()),
    );
  });
});
