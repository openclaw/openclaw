/** Verifies docs stay aligned with the secret target registry. */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { buildSecretRefCredentialMatrix } from "./credential-matrix.test-support.js";

const bundledPluginEnv = captureEnv([
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
]);

process.env.OPENCLAW_BUNDLED_PLUGINS_DIR ??= "extensions";
process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR ??= "1";

afterAll(() => {
  bundledPluginEnv.restore();
});

describe("secret target registry docs", () => {
  const matrixPath = path.join(
    process.cwd(),
    "docs/reference/secretref-user-supplied-credentials-matrix.json",
  );

  it("stays in sync with docs/reference/secretref-user-supplied-credentials-matrix.json", () => {
    expect(fs.readFileSync(matrixPath, "utf8")).toBe(
      `${JSON.stringify(buildSecretRefCredentialMatrix(), null, 2)}\n`,
    );
  });
});
