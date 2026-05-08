import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertLocalMediaAllowed } from "./local-media-access.js";
import { saveMediaBuffer } from "./store.js";

describe("assertLocalMediaAllowed", () => {
  it("allows managed inbound media paths before explicit root checks", async () => {
    const saved = await saveMediaBuffer(Buffer.from("png"), "image/png", "inbound");

    try {
      await expect(assertLocalMediaAllowed(saved.path, [])).resolves.toBeUndefined();
    } finally {
      await fs.rm(saved.path, { force: true });
    }
  });

  it("does not allow nested inbound paths as managed media", async () => {
    const filePath = path.join(
      path.dirname((await saveMediaBuffer(Buffer.from("png"))).path),
      "nested",
      "hidden.png",
    );
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from("png"));

    try {
      await expect(assertLocalMediaAllowed(filePath, [])).rejects.toMatchObject({
        code: "path-not-allowed",
      });
    } finally {
      await fs.rm(path.dirname(filePath), { recursive: true, force: true });
    }
  });
});
