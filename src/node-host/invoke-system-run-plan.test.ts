import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatExecCommand } from "../infra/system-run-command.js";
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
  expectedArgvChanged?: boolean;
  expectedCmdText?: string;
  checkRawCommandMatchesArgv?: boolean;
  expectedCommandPreview?: string | null;
};

type ScriptOperandFixture = {
  command: string[];
  scriptPath: string;
  initialBody: string;
  expectedArgvIndex: number;
};

type RuntimeFixture = {
  name: string;
  argv: string[];
  scriptName: string;
  initialBody: string;
  expectedArgvIndex: number;
  binName?: string;
};

function createScriptOperandFixture(tmp: string, fixture?: RuntimeFixture): ScriptOperandFixture {
  if (fixture) {
    return {
      command: fixture.argv,
      scriptPath: path.join(tmp, fixture.scriptName),
      initialBody: fixture.initialBody,
      expectedArgvIndex: fixture.expectedArgvIndex,
    };
  }
  if (process.platform === "win32") {
    return {
      command: [process.execPath, "./run.js"],
      scriptPath: path.join(tmp, "run.js"),
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 1,
    };
  }
  return {
    command: ["/bin/sh", "./run.sh"],
    scriptPath: path.join(tmp, "run.sh"),
    initialBody: "#!/bin/sh\necho SAFE\n",
    expectedArgvIndex: 1,
  };
}

function withFakeRuntimeBin<T>(params: { binName: string; run: () => T }): T {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-${params.binName}-bin-`));
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const runtimePath =
    process.platform === "win32"
      ? path.join(binDir, `${params.binName}.cmd`)
      : path.join(binDir, params.binName);
  const runtimeBody =
    process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n";
  fs.writeFileSync(runtimePath, runtimeBody, { mode: 0o755 });
  if (process.platform !== "win32") {
    fs.chmodSync(runtimePath, 0o755);
  }
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
  try {
    return params.run();
  } finally {
    if (oldPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = oldPath;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("hardenApprovedExecutionPaths", () => {
  const cases: HardeningCase[] = [
    {
      name: "preserves shell-wrapper argv during approval hardening",
      mode: "build-plan",
      argv: ["env", "sh", "-c", "echo SAFE"],
      expectedArgv: () => ["env", "sh", "-c", "echo SAFE"],
      expectedCmdText: 'env sh -c "echo SAFE"',
      expectedCommandPreview: "echo SAFE",
    },
    {
      name: "preserves dispatch-wrapper argv during approval hardening",
      mode: "harden",
      argv: ["env", "tr", "a", "b"],
      shellCommand: null,
      expectedArgv: () => ["env", "tr", "a", "b"],
      expectedArgvChanged: false,
    },
    {
      name: "pins direct PATH-token executable during approval hardening",
      mode: "harden",
      argv: ["poccmd", "SAFE"],
      shellCommand: null,
      withPathToken: true,
      expectedArgv: ({ pathToken }) => [pathToken!.expected, "SAFE"],
      expectedArgvChanged: true,
    },
    {
      name: "preserves env-wrapper PATH-token argv during approval hardening",
      mode: "harden",
      argv: ["env", "poccmd", "SAFE"],
      shellCommand: null,
      withPathToken: true,
      expectedArgv: () => ["env", "poccmd", "SAFE"],
      expectedArgvChanged: false,
    },
    {
      name: "rawCommand matches hardened argv after executable path pinning",
      mode: "build-plan",
      argv: ["poccmd", "hello"],
      withPathToken: true,
      expectedArgv: ({ pathToken }) => [pathToken!.expected, "hello"],
      checkRawCommandMatchesArgv: true,
      expectedCommandPreview: null,
    },
    {
      name: "stores full approval text and preview for path-qualified env wrappers",
      mode: "build-plan",
      argv: ["./env", "sh", "-c", "echo SAFE"],
      expectedArgv: () => ["./env", "sh", "-c", "echo SAFE"],
      expectedCmdText: './env sh -c "echo SAFE"',
      checkRawCommandMatchesArgv: true,
      expectedCommandPreview: "echo SAFE",
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
            expect(prepared.plan.commandText).toBe(testCase.expectedCmdText);
          }
          if (testCase.checkRawCommandMatchesArgv) {
            expect(prepared.plan.commandText).toBe(formatExecCommand(prepared.plan.argv));
          }
          if ("expectedCommandPreview" in testCase) {
            expect(prepared.plan.commandPreview ?? null).toBe(testCase.expectedCommandPreview);
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
        if (typeof testCase.expectedArgvChanged === "boolean") {
          expect(hardened.argvChanged).toBe(testCase.expectedArgvChanged);
        }
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

  const mutableOperandCases: RuntimeFixture[] = [
    {
      name: "python flagged file",
      binName: "python3",
      argv: ["python3", "-B", "./run.py"],
      scriptName: "run.py",
      initialBody: 'print("SAFE")\n',
      expectedArgvIndex: 2,
    },
    {
      name: "lua direct file",
      binName: "lua",
      argv: ["lua", "./run.lua"],
      scriptName: "run.lua",
      initialBody: 'print("SAFE")\n',
      expectedArgvIndex: 1,
    },
    {
      name: "pypy direct file",
      binName: "pypy",
      argv: ["pypy", "./run.py"],
      scriptName: "run.py",
      initialBody: 'print("SAFE")\n',
      expectedArgvIndex: 1,
    },
    {
      name: "versioned node alias file",
      binName: "node20",
      argv: ["node20", "./run.js"],
      scriptName: "run.js",
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 1,
    },
    {
      name: "bun direct file",
      binName: "bun",
      argv: ["bun", "./run.ts"],
      scriptName: "run.ts",
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 1,
    },
    {
      name: "bun run file",
      binName: "bun",
      argv: ["bun", "run", "./run.ts"],
      scriptName: "run.ts",
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 2,
    },
    {
      name: "deno run file with flags",
      binName: "deno",
      argv: ["deno", "run", "-A", "--allow-read", "--", "./run.ts"],
      scriptName: "run.ts",
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 5,
    },
    {
      name: "bun test file",
      binName: "bun",
      argv: ["bun", "test", "./run.test.ts"],
      scriptName: "run.test.ts",
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 2,
    },
    {
      name: "deno test file",
      binName: "deno",
      argv: ["deno", "test", "./run.test.ts"],
      scriptName: "run.test.ts",
      initialBody: 'console.log("SAFE");\n',
      expectedArgvIndex: 2,
    },
  ];

  for (const runtimeCase of mutableOperandCases) {
    it(`captures mutable ${runtimeCase.name} operands in approval plans`, () => {
      withFakeRuntimeBin({
        binName: runtimeCase.binName!,
        run: () => {
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-script-plan-"));
          const fixture = createScriptOperandFixture(tmp, runtimeCase);
          fs.writeFileSync(fixture.scriptPath, fixture.initialBody);
          try {
            const prepared = buildSystemRunApprovalPlan({
              command: fixture.command,
              cwd: tmp,
            });
            expect(prepared.ok).toBe(true);
            if (!prepared.ok) {
              throw new Error("unreachable");
            }
            expect(prepared.plan.mutableFileOperand).toEqual({
              argvIndex: fixture.expectedArgvIndex,
              path: fs.realpathSync(fixture.scriptPath),
              sha256: expect.any(String),
            });
          } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
          }
        },
      });
    });
  }

  it("captures mutable shell script operands in approval plans", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-script-plan-"));
    const fixture = createScriptOperandFixture(tmp);
    fs.writeFileSync(fixture.scriptPath, fixture.initialBody);
    if (process.platform !== "win32") {
      fs.chmodSync(fixture.scriptPath, 0o755);
    }
    try {
      const prepared = buildSystemRunApprovalPlan({
        command: fixture.command,
        cwd: tmp,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        throw new Error("unreachable");
      }
      expect(prepared.plan.mutableFileOperand).toEqual({
        argvIndex: fixture.expectedArgvIndex,
        path: fs.realpathSync(fixture.scriptPath),
        sha256: expect.any(String),
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects bun package script names that do not bind a concrete file", () => {
    withFakeRuntimeBin({
      binName: "bun",
      run: () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bun-package-script-"));
        try {
          const prepared = buildSystemRunApprovalPlan({
            command: ["bun", "run", "dev"],
            cwd: tmp,
          });
          expect(prepared).toEqual({
            ok: false,
            message:
              "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
          });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    });
  });

  it("rejects deno eval invocations that do not bind a concrete file", () => {
    withFakeRuntimeBin({
      binName: "deno",
      run: () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-deno-eval-"));
        try {
          const prepared = buildSystemRunApprovalPlan({
            command: ["deno", "eval", "console.log('SAFE')"],
            cwd: tmp,
          });
          expect(prepared).toEqual({
            ok: false,
            message:
              "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
          });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    });
  });
});
