import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSystemRunApprovalPlan,
  hardenApprovedExecutionPaths,
} from "./invoke-system-run-plan.js";

describe("hardenApprovedExecutionPaths", () => {
  it.runIf(process.platform !== "win32")(
    "preserves shell-wrapper argv during approval hardening",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shell-wrapper-"));
      try {
        const prepared = buildSystemRunApprovalPlan({
          command: ["env", "sh", "-c", "echo SAFE"],
          cwd: tmp,
        });
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) {
          throw new Error("unreachable");
        }
        expect(prepared.plan.argv).toEqual(["env", "sh", "-c", "echo SAFE"]);
        expect(prepared.cmdText).toBe("echo SAFE");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves dispatch-wrapper argv during approval hardening",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dispatch-wrapper-"));
      try {
        const hardened = hardenApprovedExecutionPaths({
          approvedByAsk: true,
          argv: ["env", "tr", "a", "b"],
          shellCommand: null,
          cwd: tmp,
        });
        expect(hardened.ok).toBe(true);
        if (!hardened.ok) {
          throw new Error("unreachable");
        }
        expect(hardened.argv).toEqual(["env", "tr", "a", "b"]);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "pins direct PATH-token executable during approval hardening",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-direct-pin-"));
      const binDir = path.join(tmp, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      const link = path.join(binDir, "poccmd");
      fs.symlinkSync("/bin/echo", link);
      const expected = fs.realpathSync(link);
      const oldPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
      try {
        const hardened = hardenApprovedExecutionPaths({
          approvedByAsk: true,
          argv: ["poccmd", "SAFE"],
          shellCommand: null,
          cwd: tmp,
        });
        expect(hardened.ok).toBe(true);
        if (!hardened.ok) {
          throw new Error("unreachable");
        }
        expect(hardened.argv).toEqual([expected, "SAFE"]);
      } finally {
        if (oldPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = oldPath;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
