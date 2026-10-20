import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginGenerationReceipt } from "./plugin-generation-receipt.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
function fixture() {
  const root = fs.realpathSync(temp.make("cooperative-receipt-"));
  const files = Array.from({ length: 65 }, (_, i) => path.join(root, `${i}.js`));
  for (const file of files) {
    fs.writeFileSync(file, "original");
  }
  const make = () => {
    const receipt = createPluginGenerationReceipt();
    for (const target of files) {
      receipt.file({
        target,
        boundary: root,
        sizeBytes: 8,
        native: false,
        prepared: {
          sizeBytes: 8,
          contentHash: createHash("sha256").update("original").digest("hex"),
        },
        onContent() {},
      });
    }
    return receipt;
  };
  return { files, make };
}

it("cooperative validation retains the synchronous digest and yields before completion", () => {
  const { make } = fixture();
  const expected = make().finish();
  const steps = make().finishSteps();
  let step = steps.next();
  expect(step.done).toBe(false);
  while (!step.done) {
    step = steps.next();
  }
  expect(step.value).toEqual(expected);
});

it("rejects copied-byte tampering between validation batches", () => {
  const { files, make } = fixture();
  const steps = make().finishSteps();
  expect(steps.next().done).toBe(false);
  fs.writeFileSync(files.at(-1)!, "modified");
  expect(() => {
    while (!steps.next().done) {}
  }).toThrow(/source changed/);
});
