/** Tests system.run approval-plan cwd handling for whitespace-bearing node-host paths. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSystemRunApprovalPlan,
  hardenApprovedExecutionPaths,
} from "./invoke-system-run-plan.js";

describe("node-host exec workdir whitespace preservation", () => {
  it.runIf(process.platform !== "win32")(
    "preserves leading/trailing whitespace in the cwd directory name",
    () => {
      const base = path.join(
        os.tmpdir(),
        `system-run-cwd-ws-${createHash("sha1").update("ws").digest("hex").slice(0, 8)}`,
      );
      const dirWithSpace = `${base}x `;
      const dirNoSpace = `${base}x`;
      fs.mkdirSync(dirWithSpace, { recursive: true });
      fs.mkdirSync(dirNoSpace, { recursive: true });
      try {
        const prepared = buildSystemRunApprovalPlan(
          { command: ["/bin/echo", "hi"], cwd: dirWithSpace },
          false,
        );
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) {
          throw new Error("unreachable");
        }
        expect(prepared.plan.cwd).toBe(fs.realpathSync(dirWithSpace));
        expect(prepared.plan.cwd).not.toBe(fs.realpathSync(dirNoSpace));
      } finally {
        fs.rmSync(dirWithSpace, { recursive: true, force: true });
        fs.rmSync(dirNoSpace, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "pins relative executable from the whitespace-bearing cwd, not its sibling",
    () => {
      const base = path.join(
        os.tmpdir(),
        `system-run-cwd-ws-exec-${createHash("sha1").update("exec").digest("hex").slice(0, 8)}`,
      );
      const dirWithSpace = `${base}x `;
      const dirNoSpace = `${base}x`;
      fs.mkdirSync(dirWithSpace, { recursive: true });
      fs.mkdirSync(dirNoSpace, { recursive: true });
      const toolWithSpace = path.join(dirWithSpace, "tool");
      const toolNoSpace = path.join(dirNoSpace, "tool");
      fs.writeFileSync(toolWithSpace, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      fs.writeFileSync(toolNoSpace, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      try {
        const hardened = hardenApprovedExecutionPaths({
          approvedByAsk: true,
          argv: ["./tool", "arg"],
          shellCommand: null,
          cwd: dirWithSpace,
        });
        expect(hardened.ok).toBe(true);
        if (!hardened.ok) {
          throw new Error("unreachable");
        }
        expect(hardened.argv[0]).toBe(fs.realpathSync(toolWithSpace));
        expect(hardened.argv[0]).not.toBe(fs.realpathSync(toolNoSpace));
      } finally {
        fs.rmSync(dirWithSpace, { recursive: true, force: true });
        fs.rmSync(dirNoSpace, { recursive: true, force: true });
      }
    },
  );
});
