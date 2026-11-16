import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginGenerationReceipt } from "./plugin-generation-receipt.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it("retains complete UTF-8 source on a native receipt hit", () => {
  const boundary = temp.make("plugin-receipt-source-");
  const target = path.join(boundary, "entry.ts");
  // Split a multibyte character across the source reader's 64 KiB chunks.
  const source = " ".repeat(65535) + "é; export const value = 42;";
  fs.writeFileSync(target, source);
  const prepared = {
    contentHash: createHash("sha256").update(source).digest("hex"),
    sizeBytes: Buffer.byteLength(source),
  };
  const initial = createPluginGenerationReceipt();
  initial.file({
    target,
    boundary,
    sizeBytes: prepared.sizeBytes,
    native: true,
    prepared,
    onContent() {},
  });
  const original = initial.finish();
  const replay = createPluginGenerationReceipt(original);
  let captured: string | undefined;
  replay.file({
    target,
    boundary,
    sizeBytes: prepared.sizeBytes,
    native: true,
    prepared,
    onContent() {},
    onSource: (text) => {
      captured = text;
    },
  });
  expect(replay.finish()).toEqual(original);
  expect(captured).toBe(source);
});
