/** Tests system.run approval plans, cwd snapshots, and mutable script operand binding. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveMutableFileOperandSnapshotSync } from "../infra/system-run-approval-binding.js";
import { formatExecCommand } from "../infra/system-run-command.js";
import { revalidateApprovedMutableFileOperand } from "../infra/system-run-file-snapshot.js";
import { withEnv } from "../test-utils/env.js";
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
  checkRawCommandMatchesArgv?: boolean;
  expectedCommandPreview?: string | null;
};

type UnsafeRuntimeInvocationCase = {
  name: string;
  binName: string;
  tmpPrefix: string;
  command: string[];
  setup?: (tmp: string) => void;
};

function requirePathToken(pathToken: PathTokenSetup | null): PathTokenSetup {
  if (!pathToken) {
    throw new Error("Expected PATH token fixture");
  }
  return pathToken;
}

function sha256FileSync(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

let sharedFixtureRoot = "";
let sharedRuntimeBinDir = "";
let sharedFixtureId = 0;
const sharedRuntimeBins = new Set<string>();

beforeAll(() => {
  sharedFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-run-plan-fixtures-"));
  sharedRuntimeBinDir = path.join(sharedFixtureRoot, "bin");
  fs.mkdirSync(sharedRuntimeBinDir, { recursive: true });
});

afterAll(() => {
  if (sharedFixtureRoot) {
    fs.rmSync(sharedFixtureRoot, { recursive: true, force: true });
  }
});

function createFixtureDir(prefix: string): string {
  const dir = path.join(sharedFixtureRoot, `${prefix}${sharedFixtureId++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFakeRuntimeBin(binDir: string, binName: string) {
  const runtimePath =
    process.platform === "win32" ? path.join(binDir, `${binName}.cmd`) : path.join(binDir, binName);
  const runtimeBody =
    process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n";
  fs.writeFileSync(runtimePath, runtimeBody, { mode: 0o755 });
  if (process.platform !== "win32") {
    fs.chmodSync(runtimePath, 0o755);
  }
}

function withFakeRuntimeBins<T>(params: { binNames: string[]; run: () => T }): T {
  for (const binName of params.binNames) {
    if (sharedRuntimeBins.has(binName)) {
      continue;
    }
    writeFakeRuntimeBin(sharedRuntimeBinDir, binName);
    sharedRuntimeBins.add(binName);
  }
  return withEnv(
    { PATH: `${sharedRuntimeBinDir}${path.delimiter}${process.env.PATH ?? ""}` },
    params.run,
  );
}

let cachedNativeBinaryFixturePath: string | undefined;

function resolveNativeBinaryFixturePath(): string {
  if (cachedNativeBinaryFixturePath) {
    return cachedNativeBinaryFixturePath;
  }
  for (const candidate of ["/bin/ls", "/usr/bin/ls", "/bin/echo", "/usr/bin/printf"]) {
    try {
      if (fs.statSync(candidate).isFile()) {
        cachedNativeBinaryFixturePath = candidate;
        return candidate;
      }
    } catch {
      continue;
    }
  }
  throw new Error("expected a native binary fixture path");
}

function expectShellPayloadApprovalDenied(params: {
  tmpPrefix: string;
  fileName: string;
  body: string;
}) {
  if (process.platform === "win32") {
    return;
  }
  const tmp = createFixtureDir(params.tmpPrefix);
  const scriptPath = path.join(tmp, params.fileName);
  fs.writeFileSync(scriptPath, params.body);
  fs.chmodSync(scriptPath, 0o755);
  const prepared = buildSystemRunApprovalPlan({
    command: ["/bin/sh", "-lc", scriptPath],
    rawCommand: scriptPath,
    cwd: tmp,
  });
  expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
}

const DENIED_RUNTIME_APPROVAL = expect.objectContaining({
  ok: false,
  reason: "unsupported-command-shape",
});

function runNamedCase(name: string, run: () => void) {
  try {
    run();
  } catch (error) {
    throw new Error(`case failed: ${name}`, { cause: error });
  }
}

function expectRuntimeApprovalDenied(command: string[], cwd: string) {
  const prepared = buildSystemRunApprovalPlan({ command, cwd });
  expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
}

const unsafeRuntimeInvocationCases: UnsafeRuntimeInvocationCase[] = [
  {
    name: "rejects bun package script names that do not bind a concrete file",
    binName: "bun",
    tmpPrefix: "openclaw-bun-package-script-",
    command: ["bun", "run", "dev"],
  },
  {
    name: "rejects deno eval invocations that do not bind a concrete file",
    binName: "deno",
    tmpPrefix: "openclaw-deno-eval-",
    command: ["deno", "eval", "console.log('SAFE')"],
  },
  {
    name: "rejects tsx eval invocations that do not bind a concrete file",
    binName: "tsx",
    tmpPrefix: "openclaw-tsx-eval-",
    command: ["tsx", "--eval", "console.log('SAFE')"],
  },
  {
    name: "rejects busybox applets that cannot be safely bound",
    binName: "busybox",
    tmpPrefix: "openclaw-busybox-awk-",
    command: ["busybox", "awk", 'BEGIN{system("id")}'],
  },
  {
    name: "rejects busybox applets even when cwd contains a file named after the applet",
    binName: "busybox",
    tmpPrefix: "openclaw-busybox-awk-file-bait-",
    command: ["busybox", "awk", 'BEGIN{system("id")}'],
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "awk"), "bait\n");
    },
  },
  {
    name: "rejects toybox applets that cannot be safely bound",
    binName: "toybox",
    tmpPrefix: "openclaw-toybox-awk-",
    command: ["toybox", "awk", 'BEGIN{system("id")}'],
  },
  {
    name: "rejects node inline import operands that cannot be bound to one stable file",
    binName: "node",
    tmpPrefix: "openclaw-node-import-inline-",
    command: ["node", "--import=./preload.mjs", "./main.mjs"],
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "main.mjs"), 'console.log("SAFE")\n');
      fs.writeFileSync(path.join(tmp, "preload.mjs"), 'console.log("SAFE")\n');
    },
  },
  {
    name: "rejects node inline import values that contain equals signs",
    binName: "node",
    tmpPrefix: "openclaw-node-import-inline-equals-",
    command: ["node", "--import=./pre=load.mjs", "./main.mjs"],
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "main.mjs"), 'console.log("SAFE")\n');
      fs.writeFileSync(path.join(tmp, "pre=load.mjs"), 'console.log("SAFE")\n');
    },
  },
  {
    name: "rejects ruby require preloads that approval cannot bind completely",
    binName: "ruby",
    tmpPrefix: "openclaw-ruby-require-",
    command: ["ruby", "-r", "attacker", "./safe.rb"],
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "safe.rb"), 'puts "SAFE"\n');
    },
  },
  {
    name: "rejects perl module preloads that approval cannot bind completely",
    binName: "perl",
    tmpPrefix: "openclaw-perl-module-preload-",
    command: ["perl", "-MPreload", "./safe.pl"],
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "safe.pl"), 'print "SAFE\\n";\n');
    },
  },
  {
    name: "rejects perl load-path flags that can redirect module resolution after approval",
    binName: "perl",
    tmpPrefix: "openclaw-perl-load-path-",
    command: ["perl", "-Ilib", "./safe.pl"],
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "safe.pl"), 'print "SAFE\\n";\n');
    },
  },
  {
    name: "rejects shell payloads that hide mutable interpreter scripts",
    binName: "node",
    tmpPrefix: "openclaw-inline-shell-node-",
    command: ["sh", "-lc", "node ./run.js"],
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "run.js"), 'console.log("SAFE")\n');
    },
  },
  {
    name: "rejects pnpm dlx invocations with unrecognized flags that cannot be safely bound",
    binName: "pnpm",
    tmpPrefix: "openclaw-pnpm-dlx-unknown-flag-",
    command: ["pnpm", "dlx", "--future-flag", "tsx", "./run.ts"],
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "run.ts"), 'console.log("SAFE")\n');
    },
  },
  {
    name: "rejects pnpm dlx invocations with unrecognized global flags that take a value before dlx",
    binName: "pnpm",
    tmpPrefix: "openclaw-pnpm-dlx-unknown-prefix-value-",
    command: ["pnpm", "--future-flag", "value", "dlx", "tsx", "./run.ts"],
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "run.ts"), 'console.log("SAFE")\n');
    },
  },
];

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
    },
    {
      name: "pins direct PATH-token executable during approval hardening",
      mode: "harden",
      argv: ["poccmd", "SAFE"],
      shellCommand: null,
      withPathToken: true,
      expectedArgv: ({ pathToken }) => [requirePathToken(pathToken).expected, "SAFE"],
    },
    {
      name: "preserves env-wrapper PATH-token argv during approval hardening",
      mode: "harden",
      argv: ["env", "poccmd", "SAFE"],
      shellCommand: null,
      withPathToken: true,
      expectedArgv: () => ["env", "poccmd", "SAFE"],
    },
    {
      name: "rawCommand matches hardened argv after executable path pinning",
      mode: "build-plan",
      argv: ["poccmd", "hello"],
      withPathToken: true,
      expectedArgv: ({ pathToken }) => [requirePathToken(pathToken).expected, "hello"],
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

  it.runIf(process.platform !== "win32")("handles approval hardening cases", () => {
    for (const testCase of cases) {
      runNamedCase(testCase.name, () => {
        const tmp = createFixtureDir("openclaw-approval-hardening-");
        let pathToken: PathTokenSetup | null = null;

        const checkCase = () => {
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
        };

        if (testCase.withPathToken) {
          const binDir = path.join(tmp, "bin");
          fs.mkdirSync(binDir, { recursive: true });
          const link = path.join(binDir, "poccmd");
          fs.symlinkSync("/bin/echo", link);
          pathToken = { expected: fs.realpathSync(link) };
          return withEnv(
            { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
            checkCase,
          );
        }

        return checkCase();
      });
    }
  });

  it("captures the execution host cwd when an approval request omits cwd", () => {
    const hardened = hardenApprovedExecutionPaths({
      approvedByAsk: true,
      argv: [],
      shellCommand: null,
      cwd: undefined,
    });
    expect(hardened.ok).toBe(true);
    if (!hardened.ok) {
      throw new Error("unreachable");
    }
    expect(hardened.cwd).toBe(fs.realpathSync(process.cwd()));
  });

  it("keeps fail-closed behavior for relative native-binary shell payloads", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmp = createFixtureDir("openclaw-shell-relative-binary-binding-");
    const binaryPath = resolveNativeBinaryFixturePath();
    const relativeBinaryPath = path.join(tmp, "tool");
    fs.copyFileSync(binaryPath, relativeBinaryPath);
    fs.chmodSync(relativeBinaryPath, 0o755);
    const prepared = buildSystemRunApprovalPlan({
      command: ["/bin/sh", "-lc", "./tool"],
      rawCommand: "./tool",
      cwd: tmp,
    });
    expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
  });

  it("keeps fail-closed behavior for writable absolute native-binary shell payloads", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmp = createFixtureDir("openclaw-shell-absolute-binary-binding-");
    const binaryPath = resolveNativeBinaryFixturePath();
    const copiedBinaryPath = path.join(tmp, "tool");
    fs.copyFileSync(binaryPath, copiedBinaryPath);
    fs.chmodSync(copiedBinaryPath, 0o755);
    const prepared = buildSystemRunApprovalPlan({
      command: ["/bin/sh", "-lc", copiedBinaryPath],
      rawCommand: copiedBinaryPath,
      cwd: tmp,
    });
    expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
  });

  it("keeps fail-closed behavior for owner-controlled read-only absolute binaries", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmp = createFixtureDir("openclaw-shell-owned-readonly-binding-");
    const binaryPath = path.join(tmp, "tool");
    try {
      fs.copyFileSync(resolveNativeBinaryFixturePath(), binaryPath);
      fs.chmodSync(binaryPath, 0o555);
      fs.chmodSync(tmp, 0o555);
      const prepared = buildSystemRunApprovalPlan({
        command: ["/bin/sh", "-lc", binaryPath],
        rawCommand: binaryPath,
        cwd: tmp,
      });
      expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
    } finally {
      fs.chmodSync(tmp, 0o755);
    }
  });

  it("keeps fail-closed behavior for symlinked binaries with writable targets", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmp = createFixtureDir("openclaw-shell-symlink-binary-binding-");
    const stableDir = path.join(tmp, "stable");
    const mutableDir = path.join(tmp, "mutable");
    try {
      const binaryPath = resolveNativeBinaryFixturePath();
      fs.mkdirSync(stableDir);
      fs.mkdirSync(mutableDir);
      const targetBinaryPath = path.join(mutableDir, "tool");
      const symlinkPath = path.join(stableDir, "tool");
      fs.copyFileSync(binaryPath, targetBinaryPath);
      fs.chmodSync(targetBinaryPath, 0o755);
      fs.symlinkSync(targetBinaryPath, symlinkPath);
      fs.chmodSync(stableDir, 0o555);
      const prepared = buildSystemRunApprovalPlan({
        command: ["/bin/sh", "-lc", symlinkPath],
        rawCommand: symlinkPath,
        cwd: tmp,
      });
      expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
    } finally {
      fs.chmodSync(stableDir, 0o755);
    }
  });

  it("keeps fail-closed behavior for mutable or ambiguous shell payload files", () => {
    for (const testCase of [
      {
        tmpPrefix: "openclaw-shell-script-binding-",
        fileName: "run.sh",
        body: "#!/bin/sh\necho SAFE\n",
      },
      {
        tmpPrefix: "openclaw-shell-empty-binding-",
        fileName: "empty",
        body: "",
      },
      {
        tmpPrefix: "openclaw-shell-mz-text-binding-",
        fileName: "mz-script",
        body: "MZ not really a PE file\n",
      },
      {
        tmpPrefix: "openclaw-shell-nul-header-binding-",
        fileName: "nul-script",
        body: "SAFE\u0000maybe-binary\n",
      },
    ]) {
      expectShellPayloadApprovalDenied(testCase);
    }
  });

  it("keeps fail-closed behavior when the shell payload probe stops seeing a file", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmp = createFixtureDir("openclaw-shell-race-binding-");
    const scriptPath = path.join(tmp, "run.sh");
    fs.writeFileSync(scriptPath, "#!/bin/sh\necho SAFE\n");
    fs.chmodSync(scriptPath, 0o755);
    const realStatSync = fs.statSync;
    let targetStatCalls = 0;
    const statSyncSpy = vi.spyOn(fs, "statSync").mockImplementation((pathLike, options) => {
      const targetPath = typeof pathLike === "string" ? pathLike : pathLike.toString();
      if (targetPath === scriptPath) {
        targetStatCalls += 1;
        if (targetStatCalls === 2) {
          return realStatSync(tmp, options);
        }
      }
      return realStatSync(pathLike, options);
    });
    try {
      const prepared = buildSystemRunApprovalPlan({
        command: ["/bin/sh", "-lc", scriptPath],
        rawCommand: scriptPath,
        cwd: tmp,
      });
      expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
    } finally {
      statSyncSpy.mockRestore();
    }
  });

  it("rejects unsafe runtime invocation forms", () => {
    withFakeRuntimeBins({
      binNames: [...new Set(unsafeRuntimeInvocationCases.map((testCase) => testCase.binName))],
      run: () => {
        for (const testCase of unsafeRuntimeInvocationCases) {
          runNamedCase(testCase.name, () => {
            const tmp = createFixtureDir(testCase.tmpPrefix);
            testCase.setup?.(tmp);
            expectRuntimeApprovalDenied(testCase.command, tmp);
          });
        }
      },
    });
  });

  it("captures the real shell script operand after value-taking shell flags", () => {
    const casesValue = [
      {
        name: "separate set option",
        argv: ["/bin/bash", "-o", "errexit", "./run.sh"],
        decoyName: "errexit",
        expectedArgvIndex: 3,
      },
      {
        name: "combined set option",
        argv: ["/bin/bash", "-eo", "pipefail", "./run.sh"],
        decoyName: "pipefail",
        expectedArgvIndex: 3,
      },
      {
        name: "combined trace option",
        argv: ["/bin/bash", "-xo", "errexit", "./run.sh"],
        decoyName: "errexit",
        expectedArgvIndex: 3,
      },
      {
        name: "combined unset option",
        argv: ["/bin/bash", "-uo", "nounset", "./run.sh"],
        decoyName: "nounset",
        expectedArgvIndex: 3,
      },
      {
        name: "plus set option",
        argv: ["/bin/bash", "+o", "histexpand", "./run.sh"],
        decoyName: "histexpand",
        expectedArgvIndex: 3,
      },
      {
        name: "plus shopt option",
        argv: ["/bin/bash", "+O", "extglob", "./run.sh"],
        decoyName: "extglob",
        expectedArgvIndex: 3,
      },
      {
        name: "combined plus set option",
        argv: ["/bin/bash", "+eo", "pipefail", "./run.sh"],
        decoyName: "pipefail",
        expectedArgvIndex: 3,
      },
      {
        name: "mksh plus set option",
        argv: ["mksh", "+o", "errexit", "./run.sh"],
        decoyName: "errexit",
        expectedArgvIndex: 3,
      },
      {
        name: "yash plus interactive option",
        argv: ["yash", "+i", "./run.sh"],
        decoyName: "+i",
        expectedArgvIndex: 2,
      },
    ];

    for (const testCase of casesValue) {
      runNamedCase(testCase.name, () => {
        const tmp = createFixtureDir("openclaw-shell-option-value-");
        const scriptPath = path.join(tmp, "run.sh");
        fs.writeFileSync(scriptPath, "#!/bin/sh\necho SAFE\n");
        fs.writeFileSync(path.join(tmp, testCase.decoyName), "decoy\n");
        const snapshot = resolveMutableFileOperandSnapshotSync({
          argv: testCase.argv,
          cwd: tmp,
          shellCommand: null,
        });
        expect(snapshot).toEqual({
          ok: true,
          snapshot: {
            argvIndex: testCase.expectedArgvIndex,
            path: fs.realpathSync(scriptPath),
            sha256: sha256FileSync(scriptPath),
          },
        });
        if (!snapshot.ok || snapshot.snapshot === null) {
          throw new Error("expected mutable file operand snapshot");
        }
        fs.writeFileSync(scriptPath, "#!/bin/sh\necho CHANGED\n");
        expect(
          revalidateApprovedMutableFileOperand({
            snapshot: snapshot.snapshot,
            argv: testCase.argv,
            cwd: tmp,
          }),
        ).toBe(false);
      });
    }
  });

  it("denies opaque shell inline payloads hidden by startup options", () => {
    const tmp = createFixtureDir("openclaw-opaque-shell-hidden-inline-");
    const configPath = path.join(tmp, "config.nu");
    const scriptPath = path.join(tmp, "run.sh");
    fs.writeFileSync(configPath, "print hidden\n");
    fs.writeFileSync(scriptPath, "#!/bin/sh\necho SAFE\n");
    fs.chmodSync(scriptPath, 0o755);

    const prepared = buildSystemRunApprovalPlan({
      command: ["nu", `--config=${configPath}`, "--commands", "./run.sh"],
      cwd: tmp,
    });

    expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
  });

  it("denies nushell execute payloads hidden by startup modes", () => {
    const tmp = createFixtureDir("openclaw-nu-startup-execute-");
    const scriptPath = path.join(tmp, "run.sh");
    fs.writeFileSync(scriptPath, "#!/bin/sh\necho SAFE\n");
    fs.chmodSync(scriptPath, 0o755);

    const prepared = buildSystemRunApprovalPlan({
      command: ["nu", "--interactive", "--execute", "./run.sh"],
      cwd: tmp,
    });

    expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
  });

  it("denies startup-file shell wrappers with inline commands", () => {
    expect(buildSystemRunApprovalPlan({ command: ["tcsh", "-c", "echo SAFE"] })).toEqual(
      DENIED_RUNTIME_APPROVAL,
    );
    expect(
      buildSystemRunApprovalPlan({ command: ["osh", "--rcfile", "/tmp/evil", "-c", "echo SAFE"] }),
    ).toEqual(DENIED_RUNTIME_APPROVAL);
  });

  it("captures fish script operands with plus-prefixed filenames", () => {
    const casesLocal = [
      {
        name: "plus-prefixed fish script",
        argv: ["fish", "+setup.fish"],
      },
      {
        name: "plus-prefixed fish script before script args",
        argv: ["fish", "+setup.fish", "-c", "echo arg"],
      },
    ];

    for (const testCase of casesLocal) {
      runNamedCase(testCase.name, () => {
        const tmp = createFixtureDir("openclaw-fish-plus-script-");
        const scriptPath = path.join(tmp, "+setup.fish");
        fs.writeFileSync(scriptPath, "echo SAFE\n");
        const snapshot = resolveMutableFileOperandSnapshotSync({
          argv: testCase.argv,
          cwd: tmp,
          shellCommand: null,
        });
        expect(snapshot).toEqual({
          ok: true,
          snapshot: {
            argvIndex: 1,
            path: fs.realpathSync(scriptPath),
            sha256: sha256FileSync(scriptPath),
          },
        });
        if (!snapshot.ok || snapshot.snapshot === null) {
          throw new Error("expected mutable file operand snapshot");
        }
        fs.writeFileSync(scriptPath, "echo CHANGED\n");
        expect(
          revalidateApprovedMutableFileOperand({
            snapshot: snapshot.snapshot,
            argv: testCase.argv,
            cwd: tmp,
          }),
        ).toBe(false);
      });
    }
  });
});
