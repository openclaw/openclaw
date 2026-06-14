import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { setVerbose } from "../globals.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { loadWebMedia } from "./web-media.js";

describe("hosted media resolvers", () => {
  afterEach(() => {
    setVerbose(false);
    resetPluginRuntimeStateForTest();
  });

  it("keeps trying hosted media resolvers when verbose failure logging cannot read plugin id", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hosted-media-"));
    try {
      const pngFile = path.join(fixtureRoot, "tiny.png");
      await fs.writeFile(pngFile, createSolidPngBuffer(1, 1, { r: 255, g: 255, b: 255 }));
      const registry = createEmptyPluginRegistry();
      registry.hostedMediaResolvers = [
        {
          get pluginId() {
            throw new Error("plugin id unavailable");
          },
          resolver: () => {
            throw new Error("resolver failed");
          },
          source: "test",
        },
        {
          pluginId: "fallback",
          resolver: (mediaUrl) => (mediaUrl === "/__openclaw__/fallback/tiny.png" ? pngFile : null),
          source: "test",
        },
      ];
      setActivePluginRegistry(registry);
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      setVerbose(true);

      try {
        const result = await loadWebMedia("/__openclaw__/fallback/tiny.png", {
          maxBytes: 1024 * 1024,
          localRoots: [fixtureRoot],
        });

        expect(result.kind).toBe("image");
        expect(result.buffer.length).toBeGreaterThan(0);
      } finally {
        consoleSpy.mockRestore();
      }
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
