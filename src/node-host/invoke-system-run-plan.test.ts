import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSystemRunApprovalPlan,
  hardenApprovedExecutionPaths,
} from "./invoke-system-run-plan.js";

type PathTokenSetup = {
  expected: string;
};

type HardeningCase = {
  name: string;
  mode: "build-plan" | "harden";
  argv: string[];
  shellCommand?: string | null;
  withPathToken?: boolean;
  expectedArgv: (ctx: { pathToken: PathTokenSetup | null }) => string[];
  expectedCmdText?: string;
};

describe("hardenApprovedExecutionPaths", () => {
  const cases: HardeningCase[] = [
    {
      name: "preserves shell-wrapper argv during approval hardening",
      mode: "build-plan",
      argv: ["env", "sh", "-c", "echo SAFE"],
      expectedArgv: () => ["env", "sh", "-c", "echo SAFE"],
      expectedCmdText: "echo SAFE",
    },
    {
      name: "preserves dispatch-wrapper argv during approval hardening",
      mode: "harden",
      argv: ["env", "tr", "a", "b"],
      shellCommand: null,
      expectedArgv: () => ["env", "tr", "a", "b"],
    },
    {
      name: "pins direct PATH-token executable during approval hardening",
      mode: "harden",
      argv: ["poccmd", "SAFE"],
      shellCommand: null,
      withPathToken: true,
      expectedArgv: ({ pathToken }) => [pathToken!.expected, "SAFE"],
    },
    {
      name: "preserves env-wrapper PATH-token argv during approval hardening",
      mode: "harden",
      argv: ["env", "poccmd", "SAFE"],
      shellCommand: null,
      withPathToken: true,
      expectedArgv: () => ["env", "poccmd", "SAFE"],
    },
  ];

  for (const testCase of cases) {
    it.runIf(process.platform !== "win32")(testCase.name, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-hardening-"));
      const oldPath = process.env.PATH;
      let pathToken: PathTokenSetup | null = null;
      if (testCase.withPathToken) {
        const binDir = path.join(tmp, "bin");
        fs.mkdirSync(binDir, { recursive: true });
        const link = path.join(binDir, "poccmd");
        fs.symlinkSync("/bin/echo", link);
        pathToken = { expected: fs.realpathSync(link) };
        process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
      }
      try {
        if (testCase.mode === "build-plan") {
          const prepared = buildSystemRunApprovalPlan({
            command: testCase.argv,
            cwd: tmp,
          });
          expect(prepared.ok).toBe(true);
          if (!prepared.ok) {
            throw new Error("unreachable");
          }
          expect(prepared.plan.argv).toEqual(testCase.expectedArgv({ pathToken }));
          if (testCase.expectedCmdText) {
            expect(prepared.cmdText).toBe(testCase.expectedCmdText);
          }
          return;
        }

        const hardened = hardenApprovedExecutionPaths({
          approvedByAsk: true,
          argv: testCase.argv,
          shellCommand: testCase.shellCommand ?? null,
          cwd: tmp,
        });
        expect(hardened.ok).toBe(true);
        if (!hardened.ok) {
          throw new Error("unreachable");
        }
        expect(hardened.argv).toEqual(testCase.expectedArgv({ pathToken }));
      } finally {
        if (testCase.withPathToken) {
          if (oldPath === undefined) {
            delete process.env.PATH;
          } else {
            process.env.PATH = oldPath;
          }
        }
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});

describe("buildSystemRunApprovalPlan cross-platform cwd handling", () => {
  // Skip on Windows: echo is a cmd.exe builtin, not a file, so resolveCommandResolutionFromArgv
  // returns null and tests fail.
  it.runIf(process.platform !== "win32")("omits cwd from plan when cwd does not exist (cross-platform exec)", () => {
    // This test simulates the case where a gateway sends its workspace path
    // (e.g., /root/workspace on WSL) to a Windows node where that path doesn't exist.
    // The prepare phase should gracefully omit the cwd rather than failing.
    const nonExistentCwd = "/nonexistent/gateway/workspace/path";
    const prepared = buildSystemRunApprovalPlan({
      command: ["echo", "test"],
      cwd: nonExistentCwd,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("unreachable");
    }
    // The cwd should be omitted (null) since it doesn't exist
    expect(prepared.plan.cwd).toBeNull();
  });

  // Skip on Windows: echo is a cmd.exe builtin, not a file, so resolveCommandResolutionFromArgv
  // returns null and tests fail.
  it.runIf(process.platform !== "win32")("preserves cwd in plan when cwd exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cwd-exists-"));
    try {
      const prepared = buildSystemRunApprovalPlan({
        command: ["echo", "test"],
        cwd: tmp,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        throw new Error("unreachable");
      }
      // The cwd should be preserved since it exists
      expect(prepared.plan.cwd).toBe(fs.realpathSync(tmp));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
