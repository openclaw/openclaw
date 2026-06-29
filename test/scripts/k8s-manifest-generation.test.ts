// Kubernetes manifest generation tests cover source/generated drift.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateK8sManifest } from "../../scripts/k8s/generate-manifest.mjs";

describe("Kubernetes manifest generation", () => {
  it("keeps the single-file manifest generated from the source manifest directory", async () => {
    const [generated, current] = await Promise.all([
      generateK8sManifest(),
      readFile(path.join(process.cwd(), "scripts/k8s/manifest.yaml"), "utf8"),
    ]);

    expect(generated).toBe(current);
  });
});
