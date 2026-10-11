import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import * as distImports from "../../../scripts/lib/package-dist-imports.mjs";
import {
  buildId,
  useNodeBootstrapArtifactFixtures,
  version,
  write,
} from "./node-bootstrap-artifact.test-support.js";

const { fixture } = useNodeBootstrapArtifactFixtures();

describe("node bootstrap artifact worker", () => {
  it("verifies and shares an immutable artifact without parsing imports on the caller thread", async () => {
    const { packageRoot, provider } = await fixture();
    const parser = vi.spyOn(distImports, "collectPackageDistImports").mockImplementation(() => {
      throw new Error("Bootstrap imports must be parsed off the caller thread");
    });
    const enrollment = new AbortController();
    let pending: Promise<unknown> | undefined;
    try {
      await write(packageRoot, "dist/build-info.json", { version, buildId: "stale" });
      await expect(provider.prepare()).rejects.toThrow("running Gateway build");
      await write(packageRoot, "dist/build-info.json", { version, buildId });
      const cancelled = new AbortController();
      const first = provider.prepare(enrollment.signal);
      pending = first;
      const other = provider.prepare(cancelled.signal);
      cancelled.abort(new Error("enrollment cancelled"));
      await expect(other).rejects.toMatchObject({ name: "AbortError" });
      const artifact = await first;
      expect(await provider.prepare()).toBe(artifact);
      expect(Object.isFrozen(artifact)).toBe(true);
      expect(Object.isFrozen(artifact.enabledPluginIds)).toBe(true);
      expect(parser).not.toHaveBeenCalled();
      const bytes = await fs.readFile(artifact.tarballPath);
      expect(bytes.length).toBe(artifact.tarballBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.tarballSha256);
      const closing = provider.close();
      await expect(fs.access(artifact.tarballPath)).resolves.toBeUndefined();
      enrollment.abort();
      await closing;
      await expect(fs.access(artifact.tarballPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      enrollment.abort();
      await pending?.catch(() => undefined);
      parser.mockRestore();
    }
  });
});
