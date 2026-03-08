import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDefaultRepoBootstrapManifest,
  getRepoBootstrapEntry,
  resolveSreRepoCheckoutRoot,
} from "./manifest.js";

describe("repo bootstrap manifest", () => {
  it("uses the default checkout root when unset", () => {
    expect(resolveSreRepoCheckoutRoot({})).toBe("/Users/florian/morpho");
  });

  it("supports overriding the checkout root", () => {
    const manifest = createDefaultRepoBootstrapManifest({
      OPENCLAW_SRE_REPO_CHECKOUT_ROOT: "/tmp/repos",
    });

    expect(getRepoBootstrapEntry(manifest, "openclaw-sre")?.localPath).toBe(
      path.join("/tmp/repos", "openclaw-sre"),
    );
    expect(getRepoBootstrapEntry(manifest, "morpho-infra-helm")?.localPath).toBe(
      path.join("/tmp/repos", "morpho-infra-helm"),
    );
  });

  it("keeps openclaw-sre in the deterministic checkout set", () => {
    const manifest = createDefaultRepoBootstrapManifest();
    expect(manifest.repos.map((repo) => repo.repoId)).toContain("openclaw-sre");
  });
});
