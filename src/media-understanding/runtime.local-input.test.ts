// Exercise the file API with real cache, filesystem, root policy, and MIME detection.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { prepareImageDescriptionInput } from "./runtime.js";

vi.mock("./runner.js", async () => {
  return {
    ...(await import("./runner.attachments.js")),
    buildProviderRegistry: vi.fn(),
    runCapability: vi.fn(),
  };
});

vi.mock("./provider-registry.js", () => ({
  buildMediaUnderstandingRegistry: vi.fn(),
  getMediaUnderstandingProvider: vi.fn(),
  normalizeMediaProviderId: vi.fn(),
}));
vi.mock("./image-runtime.js", () => ({ describeImageWithModel: vi.fn() }));

describe("local image preparation", () => {
  it.skipIf(process.platform === "win32")("keeps rejecting local image symlinks", async () => {
    await withTestDir({ prefix: "openclaw-image-input-roots-" }, async (base) => {
      const allowed = path.join(base, "allowed");
      const outside = path.join(base, "outside.png");
      const filePath = path.join(allowed, "linked.png");
      await fs.mkdir(allowed);
      await fs.writeFile(outside, "outside");
      await fs.symlink(outside, filePath);
      await expect(prepareImageDescriptionInput({ filePath, cfg: {} })).rejects.toThrow();
    });
  });
});
