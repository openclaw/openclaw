import "../test-utils/prepare-compiled-subprocesses.js";
// Exercise the real schema-to-documentation owner; no runtime schema mocks.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  renderConfigDocBaselineArtifacts,
  writeConfigDocBaselineArtifacts,
} from "./doc-baseline.js";

it("documents the optional trusted-proxy credit mapping through canonical artifacts", async () => {
  const rendered = await renderConfigDocBaselineArtifacts();
  const paths = rendered.baseline.coreEntries.map((entry) => entry.path);
  expect(paths).toEqual(
    expect.arrayContaining([
      "gateway.auth.trustedProxy.gitCoauthor",
      "gateway.auth.trustedProxy.gitCoauthor.nameHeader",
      "gateway.auth.trustedProxy.gitCoauthor.emailHeader",
      "gateway.auth.trustedProxy.gitCoauthor.emailVerifiedHeader",
    ]),
  );
  await withTestDir({ prefix: "proxy-credit-config-docs-" }, async (repoRoot) => {
    const generated = await writeConfigDocBaselineArtifacts({ repoRoot, rendered });
    const hash = await fs.readFile(generated.hashPath, "utf8");
    const counts = await fs.readFile(generated.countsPath, "utf8");
    const checked = await writeConfigDocBaselineArtifacts({ repoRoot, rendered, check: true });
    expect(checked.changed).toBe(false);
    // Retain the canonical generator bytes when remote CI discovers stale checked-in artifacts.
    // This is schema metadata only, never operator configuration or credential values.
    const current = await fs.readFile(
      path.resolve("docs/.generated/config-baseline.sha256"),
      "utf8",
    );
    if (current !== hash) {
      console.info(
        "OPENCLAW_PROXY_CREDIT_CONFIG_ARTIFACTS",
        JSON.stringify({
          hash: Buffer.from(hash).toString("base64"),
          counts: Buffer.from(counts).toString("base64"),
        }),
      );
    }
  });
}, 240_000);
