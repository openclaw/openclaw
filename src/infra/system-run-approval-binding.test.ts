// Covers system-run approval binding normalization and matching.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import * as commandResolution from "./exec-command-resolution.js";
import {
  APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
  buildSystemRunApprovalBinding,
  buildSystemRunApprovalEnvBinding,
  matchSystemRunApprovalBinding,
  missingSystemRunApprovalBinding,
  prepareSystemRunMutableFileBinding,
  prepareSystemRunMutableFileApproval,
  revalidateSystemRunMutableFileBinding,
} from "./system-run-approval-binding.js";
import { normalizeSystemRunApprovalPlan } from "./system-run-approval-plan.js";
import * as mutableFilePolicy from "./system-run-mutable-file-policy.js";
import {
  hasPosixShellCodeLoadingOption,
  resolvePosixShellScriptOperandIndex,
} from "./system-run-shell-file-operand.js";

function expectOk<T extends { ok: boolean }>(result: T): T & { ok: true } {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("unreachable");
  }
  return result as T & { ok: true };
}

describe("normalizeSystemRunApprovalPlan", () => {
  it.each([
    {
      name: "accepts commandText and normalized mutable file operands",
      input: {
        argv: ["bash", "-lc", "echo hi"],
        commandText: 'bash -lc "echo hi"',
        commandPreview: "echo hi",
        cwd: " /tmp ",
        agentId: " main ",
        sessionKey: " agent:main:main ",
        mutableFileOperand: {
          argvIndex: 2,
          path: " /tmp/payload.txt ",
          sha256: " abc123 ",
        },
      },
      expected: {
        argv: ["bash", "-lc", "echo hi"],
        commandText: 'bash -lc "echo hi"',
        commandPreview: "echo hi",
        cwd: "/tmp",
        agentId: "main",
        sessionKey: "agent:main:main",
        mutableFileOperand: {
          argvIndex: 2,
          path: "/tmp/payload.txt",
          sha256: "abc123",
        },
      },
    },
    {
      name: "accepts and canonicalizes a prepared policy snapshot",
      input: {
        argv: ["echo", "hi"],
        commandText: "echo hi",
        policySnapshot: {
          security: "allowlist",
          ask: "on-miss",
          askFallback: "deny",
          autoAllowSkills: false,
          allowlistRules: [
            { pattern: "/usr/bin/zsh", source: "allow-always" },
            { pattern: "/usr/bin/echo" },
            { pattern: "/usr/bin/echo" },
          ],
        },
      },
      expected: {
        argv: ["echo", "hi"],
        commandText: "echo hi",
        commandPreview: null,
        cwd: null,
        agentId: null,
        sessionKey: null,
        policySnapshot: {
          security: "allowlist",
          ask: "on-miss",
          askFallback: "deny",
          autoAllowSkills: false,
          allowlistRules: [
            { pattern: "/usr/bin/echo" },
            { pattern: "/usr/bin/zsh", source: "allow-always" },
          ],
        },
        mutableFileOperand: undefined,
      },
    },
    {
      name: "uses locale-independent UTF-8 ordering for portable policy rules",
      input: {
        argv: ["echo", "hi"],
        commandText: "echo hi",
        policySnapshot: {
          security: "allowlist",
          ask: "always",
          askFallback: "deny",
          autoAllowSkills: false,
          allowlistRules: [
            { pattern: "/😀" },
            { pattern: "/A", argPattern: "z" },
            { pattern: "/é" },
            { pattern: "/A", source: "allow-always" },
            { pattern: "/a" },
            { pattern: "/A" },
            { pattern: "/A", argPattern: "A" },
          ],
        },
      },
      expected: {
        argv: ["echo", "hi"],
        commandText: "echo hi",
        commandPreview: null,
        cwd: null,
        agentId: null,
        sessionKey: null,
        policySnapshot: {
          security: "allowlist",
          ask: "always",
          askFallback: "deny",
          autoAllowSkills: false,
          allowlistRules: [
            { pattern: "/A" },
            { pattern: "/A", source: "allow-always" },
            { pattern: "/A", argPattern: "A" },
            { pattern: "/A", argPattern: "z" },
            { pattern: "/a" },
            { pattern: "/é" },
            { pattern: "/😀" },
          ],
        },
        mutableFileOperand: undefined,
      },
    },
    {
      name: "falls back to rawCommand",
      input: {
        argv: ["bash", "-lc", "echo hi"],
        rawCommand: 'bash -lc "echo hi"',
      },
      expected: {
        argv: ["bash", "-lc", "echo hi"],
        commandText: 'bash -lc "echo hi"',
        commandPreview: null,
        cwd: null,
        agentId: null,
        sessionKey: null,
        mutableFileOperand: undefined,
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(normalizeSystemRunApprovalPlan(input)).toEqual(expected);
  });

  it.each([
    {
      argv: ["bash", "-lc", "echo hi"],
      commandText: 'bash -lc "echo hi"',
      mutableFileOperand: { argvIndex: -1, path: "/tmp/payload.txt", sha256: "abc123" },
    },
    {
      argv: ["echo", "hi"],
      commandText: "echo hi",
      policySnapshot: {
        security: "full",
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
        allowlistRules: [{ pattern: "valid" }, { pattern: 42 }],
      },
    },
  ])("rejects malformed approval plans: %j", (input) => {
    expect(normalizeSystemRunApprovalPlan(input)).toBeNull();
  });
});

describe("buildSystemRunApprovalEnvBinding", () => {
  it.each([
    {
      input: { z_key: "b", " bad key ": "ignored", alpha: "a", EMPTY: 1 },
      equivalent: { alpha: "a", z_key: "b" },
      keys: ["alpha", "z_key"],
      changed: { alpha: "changed", z_key: "b" },
    },
    {
      input: { "ProgramFiles(x86)": "C:\\Program Files (x86)" },
      equivalent: { "ProgramFiles(x86)": "C:\\Program Files (x86)" },
      keys: ["ProgramFiles(x86)"],
      changed: { "ProgramFiles(x86)": "D:\\SDKs" },
    },
  ])(
    "normalizes env keys and binds their values: $keys",
    ({ input, equivalent, keys, changed }) => {
      const normalized = buildSystemRunApprovalEnvBinding(input);
      expect(normalized).toEqual({
        envHash: buildSystemRunApprovalEnvBinding(equivalent).envHash,
        envKeys: keys,
      });
      expect(normalized.envHash).toBeTypeOf("string");
      expect(normalized.envHash).toHaveLength(64);
      expect(normalized.envHash).not.toEqual(buildSystemRunApprovalEnvBinding(changed).envHash);
    },
  );

  it("returns a null hash when no usable env entries remain", () => {
    expect(buildSystemRunApprovalEnvBinding(null)).toEqual({
      envHash: null,
      envKeys: [],
    });
    expect(
      buildSystemRunApprovalEnvBinding({
        bad: 1,
      }),
    ).toEqual({
      envHash: null,
      envKeys: [],
    });
  });
});

describe("buildSystemRunApprovalBinding", () => {
  it("normalizes argv and metadata into a binding", () => {
    const envBinding = buildSystemRunApprovalEnvBinding({
      beta: "2",
      alpha: "1",
    });

    expect(
      buildSystemRunApprovalBinding({
        argv: ["bash", "-lc", 12],
        cwd: " /tmp ",
        agentId: " main ",
        sessionKey: " agent:main:main ",
        env: {
          beta: "2",
          alpha: "1",
        },
      }),
    ).toEqual({
      binding: {
        argv: ["bash", "-lc", "12"],
        cwd: "/tmp",
        agentId: "main",
        sessionKey: "agent:main:main",
        envHash: envBinding.envHash,
      },
      envKeys: ["alpha", "beta"],
    });
  });
});

describe("matchSystemRunApprovalBinding", () => {
  const expected = {
    argv: ["bash", "-lc", "echo hi"],
    cwd: "/tmp",
    agentId: "main",
    sessionKey: "agent:main:main",
    envHash: "abc",
  };

  it.each([
    { name: "exact match", actual: { ...expected } },
    {
      name: "argv mismatch",
      actual: { ...expected, argv: ["bash", "-lc", "echo bye"] },
    },
    {
      name: "cwd mismatch",
      actual: { ...expected, cwd: "/var/tmp" },
    },
    {
      name: "agent mismatch",
      actual: { ...expected, agentId: "other" },
    },
    {
      name: "session mismatch",
      actual: { ...expected, sessionKey: "agent:main:other" },
    },
  ])("matches approval bindings: $name", ({ name, actual }) => {
    expect(
      matchSystemRunApprovalBinding({
        expected,
        actual,
        actualEnvKeys: ["ALPHA"],
      }),
    ).toEqual(
      name === "exact match"
        ? { ok: true }
        : {
            ok: false,
            code: "APPROVAL_REQUEST_MISMATCH",
            message: "approval id does not match request",
            details: undefined,
          },
    );
  });
});

describe("missingSystemRunApprovalBinding", () => {
  it("reports env keys with request mismatches", () => {
    expect(missingSystemRunApprovalBinding({ actualEnvKeys: ["ALPHA", "BETA"] })).toEqual({
      ok: false,
      code: "APPROVAL_REQUEST_MISMATCH",
      message: "approval id does not match request",
      details: {
        envKeys: ["ALPHA", "BETA"],
      },
    });
  });
});

describe("POSIX shell stdin option detection", () => {
  it.each([
    ...["-s", "-se", "-es", "-ls", "-lse"].map((flag) => ({
      argv: ["bash", flag, "job.sh"],
      loading: true,
      index: null,
    })),
    { argv: ["bash", "--", "-se"], loading: false, index: 2 },
    { argv: ["bash", "job.sh", "-secret"], loading: false, index: 1 },
  ])("detects stdin options only before the operand: $argv", ({ argv, loading, index }) => {
    expect(hasPosixShellCodeLoadingOption(argv, "bash")).toBe(loading);
    expect(resolvePosixShellScriptOperandIndex(argv, "bash")).toBe(index);
  });
});

describe("mutable file operand binding", () => {
  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "binds protected env and ls identities in dispatch order",
    async () => {
      const prepared = await prepareSystemRunMutableFileBinding({
        command: { kind: "shell", text: "env ls" },
        env: { PATH: "/usr/bin:/bin" },
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        throw new Error(prepared.message);
      }
      expect(prepared.binding.operands.filter((operand) => operand.executable)).toEqual([
        expect.objectContaining({
          kind: "identity",
          snapshot: { argvIndex: 0, path: fs.realpathSync("/usr/bin/env") },
        }),
        expect.objectContaining({
          kind: "identity",
          snapshot: { argvIndex: 0, path: fs.realpathSync("/bin/ls") },
        }),
      ]);
      await expect(
        revalidateSystemRunMutableFileBinding({ binding: prepared.binding }),
      ).resolves.toEqual({ ok: true });
    },
  );

  it.runIf(process.platform !== "win32")(
    "binds protected executable identity without hashing or requiring one-shot approval",
    async () => {
      const policy = vi
        .spyOn(mutableFilePolicy, "pathLooksMutableForShellPayloadSync")
        .mockReturnValue(false);
      try {
        const prepared = expectOk(
          await prepareSystemRunMutableFileBinding({
            command: { kind: "shell", text: "ls *.ts" },
            env: { PATH: "/bin" },
          }),
        );
        expect(prepared.binding.operands).toEqual([
          expect.objectContaining({
            kind: "identity",
            executable: true,
            argv: ["ls", "*.ts"],
            snapshot: { argvIndex: 0, path: fs.realpathSync("/bin/ls") },
            pathSearch: expect.objectContaining({ path: "/bin" }),
          }),
        ]);
        const reads = vi.spyOn(fs, "readFileSync");
        try {
          await expect(
            revalidateSystemRunMutableFileBinding({ binding: prepared.binding }),
          ).resolves.toEqual({ ok: true });
          expect(reads).not.toHaveBeenCalled();
        } finally {
          reads.mockRestore();
        }
        const approval = expectOk(
          await prepareSystemRunMutableFileApproval({ command: "/bin/ls *.ts" }),
        );
        expect(approval.requiresOneShot).toBe(false);
        const access = fs.accessSync;
        const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation((target, mode) => {
          if (target === "/bin/ls") {
            throw new Error("synthetic executable unavailable");
          }
          return access(target, mode);
        });
        try {
          await expect(
            revalidateSystemRunMutableFileBinding({ binding: prepared.binding }),
          ).resolves.toEqual({
            ok: false,
            message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
          });
        } finally {
          accessSpy.mockRestore();
        }
      } finally {
        policy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "denies protected executable resolution drift after preparation",
    async () => {
      const policy = vi
        .spyOn(mutableFilePolicy, "pathLooksMutableForShellPayloadSync")
        .mockReturnValue(false);
      const resolution = commandResolution.resolveCommandResolutionFromArgv(["ls"], undefined, {
        PATH: "/bin:/usr/bin",
      });
      if (!resolution) {
        throw new Error("expected executable resolution");
      }
      const resolve = vi
        .spyOn(commandResolution, "resolveCommandResolutionFromArgv")
        .mockReturnValue(resolution);
      try {
        const prepared = expectOk(
          await prepareSystemRunMutableFileBinding({
            command: {
              kind: "segments",
              segments: [{ argv: ["ls", "*.ts"], raw: "ls *.ts", resolution }],
            },
            env: { PATH: "/bin:/usr/bin" },
          }),
        );
        resolve.mockReturnValue({
          ...resolution,
          execution: { ...resolution.execution, resolvedRealPath: "/synthetic/changed/ls" },
        });
        await expect(
          revalidateSystemRunMutableFileBinding({ binding: prepared.binding }),
        ).resolves.toEqual({
          ok: false,
          message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
        });
        expect(resolve).toHaveBeenLastCalledWith(
          ["ls", "*.ts"],
          undefined,
          expect.objectContaining({ PATH: "/bin:/usr/bin" }),
          process.platform,
          { useCache: false },
        );
      } finally {
        resolve.mockRestore();
        policy.mockRestore();
      }
    },
  );

  it("binds every script in a compound command and detects drift", async () => {
    await withTempDir("openclaw-system-run-binding-", async (rawCwd) => {
      const cwd = fs.realpathSync(rawCwd);
      const first = path.join(cwd, "first.sh");
      const second = path.join(cwd, "second.py");
      fs.writeFileSync(first, "#!/bin/sh\necho first\n");
      fs.writeFileSync(second, "print('second')\n");
      const command = { kind: "shell" as const, text: "sh first.sh && python3 second.py" };
      const prepared = expectOk(await prepareSystemRunMutableFileBinding({ command, cwd }));

      // Assert the script operands by path: a host whose interpreters live in a writable
      // prefix (Homebrew, asdf, nix profiles) also binds those executables, so an operand
      // count would only describe the host that ran the test.
      expect(
        prepared.binding.operands
          .filter((operand) => !operand.executable)
          .map((operand) => operand.snapshot.path),
      ).toEqual([first, second]);
      await expect(
        revalidateSystemRunMutableFileBinding({ binding: prepared.binding, cwd }),
      ).resolves.toEqual({ ok: true });

      fs.writeFileSync(second, "print('changed')\n");
      await expect(
        revalidateSystemRunMutableFileBinding({ binding: prepared.binding, cwd }),
      ).resolves.toEqual({
        ok: false,
        message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
      });
    });
  });

  it.each([
    { kind: "direct", command: "./direct.sh", file: "direct.sh", mutate: "direct.sh" },
    {
      kind: "wrapper",
      command: "env WRAPPED=1 ./wrapped.sh",
      file: "wrapped.sh",
      mutate: "wrapped.sh",
    },
    {
      kind: "native",
      command: "./native-tool --version",
      file: "native-tool",
      mutate: "native-tool",
    },
    {
      kind: "path",
      command: "workspace-tool",
      file: "bin/workspace-tool",
      mutate: "bin/workspace-tool",
    },
    { kind: "path-shim", command: "python payload.py", file: "bin/python", mutate: "payload.py" },
    { kind: "explicit-shim", command: "./python payload.py", file: "python", mutate: "python" },
  ])("binds $kind executables and rejects drift", async ({ kind, command, file, mutate }) => {
    await withTempDir("openclaw-system-run-binding-", async (rawCwd) => {
      const cwd = fs.realpathSync(rawCwd);
      const executable = path.join(cwd, file);
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      if (kind === "native") {
        fs.copyFileSync(process.execPath, executable);
        fs.chmodSync(executable, 0o755);
      } else {
        fs.writeFileSync(
          executable,
          kind.endsWith("shim") ? '#!/bin/sh\nexec python3 "$@"\n' : "#!/bin/sh\necho approved\n",
          { mode: 0o755 },
        );
      }
      if (kind.endsWith("shim")) {
        fs.writeFileSync(path.join(cwd, "payload.py"), "print('approved')\n");
      }
      const prepared = expectOk(
        await prepareSystemRunMutableFileBinding({
          command: { kind: "shell", text: command },
          cwd,
          ...(kind.startsWith("path")
            ? {
                env: {
                  ...process.env,
                  PATH: path.join(cwd, "bin") + path.delimiter + (process.env.PATH ?? ""),
                },
              }
            : {}),
        }),
      );
      const operands = prepared.binding.operands;
      if (kind === "wrapper") {
        expect(operands.map((operand) => operand.snapshot.path)).toContain(
          fs.realpathSync(executable),
        );
      } else if (kind === "direct" || kind === "native") {
        expect(
          operands.filter((operand) =>
            kind === "native" ? operand.executable : !operand.executable,
          ),
        ).toHaveLength(1);
      } else {
        expect(operands).toHaveLength(kind === "path" ? 1 : 2);
      }
      await expect(
        revalidateSystemRunMutableFileBinding({ binding: prepared.binding, cwd }),
      ).resolves.toEqual({ ok: true });
      if (kind === "native") {
        fs.appendFileSync(executable, Buffer.from([0]));
      } else {
        fs.writeFileSync(
          path.join(cwd, mutate),
          kind === "path-shim"
            ? "print('changed')\n"
            : kind === "explicit-shim"
              ? '#!/bin/sh\nexec python3 -I "$@"\n'
              : "#!/bin/sh\necho changed\n",
          { mode: 0o755 },
        );
      }
      await expect(
        revalidateSystemRunMutableFileBinding({ binding: prepared.binding, cwd }),
      ).resolves.toEqual({
        ok: false,
        message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
      });
    });
  });

  it("refuses commands whose executable or loading inputs cannot be bound", async () => {
    await withTempDir("openclaw-system-run-refusal-", async (cwd) => {
      const files = {
        "init.sh": "echo init\n",
        "job.sh": "echo job\n",
        "loaded.sh": "echo loaded\n",
        "loader.ts": "export {};\n",
        "app.ts": "console.log('app');\n",
        "sub/script.sh": "echo sub\n",
        "loader.js": "module.exports = {};\n",
        "payload.sh": "echo payload\n",
      };
      for (const [file, bytes] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
        fs.writeFileSync(path.join(cwd, file), bytes, {
          mode: file === "payload.sh" ? 0o755 : 0o644,
        });
      }
      const positionalArgument = expectOk(
        await prepareSystemRunMutableFileBinding({
          command: { kind: "argv", argv: ["bash", "job.sh", "-secret"] },
          cwd,
        }),
      );
      expect(
        positionalArgument.binding.operands
          .filter((operand) => !operand.executable)
          .map((operand) => operand.snapshot.path),
      ).toEqual([path.join(cwd, "job.sh")]);
      const cannotBind = "SYSTEM_RUN_DENIED: approval cannot safely bind ";
      const startup = cannotBind + "shell startup files";
      const environment = cannotBind + "shell startup environment";
      const runtime = cannotBind + "runtime code-loading or cwd options";
      const cases: Array<[input: string | string[], message: string | null, startupEnv?: boolean]> =
        [
          [["sh", "-s", "job.sh"], startup],
          [["bash", "-se", "job.sh"], startup],
          [["bash", "-es", "job.sh"], startup],
          [["bash", "-ls", "job.sh"], startup],
          [["bash", "-lse", "job.sh"], startup],
          ["bash --rcfile init.sh -i job.sh", startup],
          [["bash", "-O", "extglob", "-i", "job.sh"], startup],
          [["bash", "--rcfile", "init.sh", "-c", "echo ok"], startup],
          [["bash", "-i", "job.sh"], startup],
          [["bash", "-c", "source loaded.sh"], null],
          [["bash", "-c", "echo ok; source loaded.sh"], null],
          [["env", "BASH_ENV=loaded.sh", "bash", "-c", "echo ok"], environment],
          ["bash -c 'echo ok'", environment, true],
          [["node", "--env-file=approved.env", "app.js"], null],
          [["bash", "-c", "sh < payload.sh"], null],
          ["cat payload.sh | sh", cannotBind + "shell pipelines"],
          ["command source loaded.sh", cannotBind + "shell source operands"],
          [["bun", "--preload", "loader.ts", "app.ts"], runtime],
          [["ruby", "-S", "app.rb"], null],
          [["perl", "-S", "app.pl"], null],
          [["ruby", "--require=loader.rb", "app.rb"], null],
          [["ruby", "-Csub", "app.rb"], null],
          [["php", "-d", "auto_prepend_file=loader.php", "app.php"], runtime],
          [["deno", "run", "--config", "deno.json", "app.ts"], runtime],
          ["cd sub && sh script.sh", cannotBind + "commands after cwd changes"],
          [["env", "-C", "sub", "sh", "script.sh"], cannotBind + "dispatch cwd options"],
          ["sh missing.sh", "SYSTEM_RUN_DENIED: approval requires an existing script operand"],
          [
            "command-that-does-not-exist",
            "SYSTEM_RUN_DENIED: approval requires a resolved executable",
          ],
          ["sh < missing.sh", cannotBind + "this command"],
          ["node --require loader.js --eval 'console.log(1)'", null],
          [["bash", "-c", "./payload.sh"], null],
        ];
      for (const [input, message, startupEnv] of cases) {
        const result = await prepareSystemRunMutableFileBinding({
          command:
            typeof input === "string"
              ? { kind: "shell", text: input }
              : { kind: "argv", argv: input },
          cwd,
          ...(startupEnv ? { env: { ...process.env, BASH_ENV: path.join(cwd, "loaded.sh") } } : {}),
        });
        if (message === null) {
          expect(result, JSON.stringify(input)).toMatchObject({
            ok: false,
            reason: "unsupported-command-shape",
          });
        } else {
          expect(result, JSON.stringify(input)).toEqual({ ok: false, message });
        }
      }
    });
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "fails closed when a script operand is unreadable",
    async () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-system-run-unreadable-"));
      const script = path.join(cwd, "unreadable.sh");
      try {
        fs.writeFileSync(script, "#!/bin/sh\necho hidden\n", { mode: 0o000 });
        await expect(
          prepareSystemRunMutableFileBinding({
            command: { kind: "shell", text: "sh unreadable.sh" },
            cwd,
          }),
        ).resolves.toEqual({
          ok: false,
          message: "SYSTEM_RUN_DENIED: approval requires a readable script operand",
        });
      } finally {
        fs.chmodSync(script, 0o600);
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
});
