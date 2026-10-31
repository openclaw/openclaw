import fs from "node:fs";
import path from "node:path";
import * as fsSafePath from "@openclaw/fs-safe/path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { pathLooksMutableForShellPayloadSync } from "./system-run-mutable-file-policy.js";

vi.mock("@openclaw/fs-safe/path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/path")>();
  return { ...actual, safeStatSync: vi.fn(actual.safeStatSync) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fsSafePath.safeStatSync).mockReset();
});

function createOperand(writable: boolean): string {
  const dir = fs.realpathSync(tempDirs.make("openclaw-mutable-policy-"));
  const operand = path.join(dir, "tool");
  fs.writeFileSync(operand, "#!/bin/sh\n", { mode: writable ? 0o755 : 0o555 });
  return operand;
}

describe.runIf(process.platform !== "win32" && typeof process.getuid === "function")(
  "pathLooksMutableForShellPayloadSync",
  () => {
    it.each([
      { owned: true, writable: true, mutable: true },
      { owned: true, writable: false, mutable: true },
      { owned: false, writable: true, mutable: true },
      { owned: false, writable: false, mutable: false },
    ])(
      "classifies owned=$owned writable=$writable without probing owned operands",
      ({ owned, writable, mutable }) => {
        const operand = createOperand(writable);
        if (!owned) {
          vi.mocked(fsSafePath.safeStatSync).mockImplementation((candidate) => {
            const stat = fs.statSync(candidate);
            stat.uid += 1;
            return stat;
          });
        }
        const access = vi.spyOn(fs, "accessSync").mockImplementation(() => {
          if (!writable) {
            throw new Error("write access denied");
          }
        });

        expect(pathLooksMutableForShellPayloadSync(operand)).toBe(mutable);
        if (owned) {
          expect(access).not.toHaveBeenCalled();
        } else {
          expect(access).toHaveBeenCalledWith(operand, fs.constants.W_OK);
        }
      },
    );

    it("rechecks ownership after a failed write probe", () => {
      const operand = createOperand(false);
      const owned = fs.statSync(operand);
      const unowned = fs.statSync(operand);
      unowned.uid += 1;
      let ownershipChanged = false;
      vi.mocked(fsSafePath.safeStatSync).mockImplementation(() =>
        ownershipChanged ? owned : unowned,
      );
      const access = vi.spyOn(fs, "accessSync").mockImplementation(() => {
        ownershipChanged = true;
        throw new Error("write access denied");
      });

      expect(pathLooksMutableForShellPayloadSync(operand)).toBe(true);
      expect(access).toHaveBeenCalledWith(operand, fs.constants.W_OK);
    });
  },
);
