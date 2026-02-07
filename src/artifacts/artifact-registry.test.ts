import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactTooLargeError, createArtifactRegistry } from "./artifact-registry.js";

describe("artifact-registry", () => {
  it("stores + retrieves text artifacts", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-artifacts-"));
    const registry = createArtifactRegistry({ rootDir: tmp });

    const meta = await registry.storeText({ content: "hello", mime: "text/plain" });
    expect(meta.id).toMatch(/^[a-f0-9]{64}$/);
    expect(meta.sha256).toBe(meta.id);
    expect(meta.mime).toBe("text/plain");
    expect(meta.sizeBytes).toBeGreaterThan(0);

    const loaded = await registry.get(meta.id);
    expect(loaded.meta.id).toBe(meta.id);
    expect(loaded.content).toBe("hello");
  });

  it("enforces size caps", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-artifacts-"));
    const registry = createArtifactRegistry({ rootDir: tmp });

    await expect(
      registry.storeText({ content: "x".repeat(100), maxBytes: 50 }),
    ).rejects.toBeInstanceOf(ArtifactTooLargeError);
  });

  it("stores json as application/json", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-artifacts-"));
    const registry = createArtifactRegistry({ rootDir: tmp });

    const meta = await registry.storeJson({ value: { a: 1 } });
    expect(meta.mime).toBe("application/json");

    const loaded = await registry.get(meta.id);
    expect(loaded.content).toContain('"a": 1');
  });
});
