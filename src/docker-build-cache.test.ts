// Tests Docker build cache configuration and dependency cache keys.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
describe("docker build cache layout", () => {
  it("copies .npmrc before install in the cleanup smoke image", async () => {
    const dockerfile = await readFile(
      resolve(repoRoot, "scripts/docker/cleanup-smoke/Dockerfile"),
      "utf8",
    );
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
    const manifestCopyIndex = dockerfile.search(
      /^COPY(?:\s+--chown=\S+)?\s+package\.json pnpm-lock\.yaml pnpm-workspace\.yaml \.npmrc \.\/$/m,
    );

    expect(manifestCopyIndex).toBeGreaterThan(-1);
    expect(manifestCopyIndex).toBeLessThan(installIndex);
    expect(dockerfile.search(/^COPY(?:\s+--chown=\S+)?\s+\.\s+\.$/m)).toBeGreaterThan(installIndex);
  });
});
