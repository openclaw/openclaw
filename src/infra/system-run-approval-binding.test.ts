import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { MAX_DISPATCH_WRAPPER_DEPTH } from "./dispatch-wrapper-resolution.js";
import { planShellAuthorization } from "./exec-authorization-plan.js";
import { resolveUnpinnedAutoApprovalEligibility } from "./exec-auto-approval-eligibility.js";
import * as commandResolution from "./exec-command-resolution.js";
import { resolveCommandResolutionFromArgv } from "./exec-command-resolution.js";
import {
  APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
  buildSystemRunApprovalBinding,
  buildSystemRunApprovalEnvBinding,
  matchSystemRunApprovalBinding,
  prepareSystemRunMutableFileBinding,
  prepareSystemRunMutableFileApproval,
  prepareSystemRunExecutableIdentityBinding,
  revalidateSystemRunMutableFileBinding,
} from "./system-run-approval-binding.js";
import { normalizeSystemRunApprovalPlan } from "./system-run-approval-plan.js";
import * as mutableFilePolicy from "./system-run-mutable-file-policy.js";

function expectOk<T extends { ok: boolean }>(result: T): T & { ok: true } {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("unreachable");
  }
  return result as T & { ok: true };
}

function expectRevalidation(
  binding: Parameters<typeof revalidateSystemRunMutableFileBinding>[0]["binding"],
  cwd?: string,
  ok = true,
) {
  return expect(revalidateSystemRunMutableFileBinding({ binding, cwd })).resolves.toEqual(
    ok ? { ok: true } : { ok: false, message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE },
  );
}

async function bind(
  command: Parameters<typeof prepareSystemRunMutableFileBinding>[0]["command"],
  cwd?: string,
  env?: Record<string, string | undefined>,
) {
  return expectOk(await prepareSystemRunMutableFileBinding({ command, cwd, env })).binding;
}

const scriptPaths = (binding: Awaited<ReturnType<typeof bind>>) =>
  binding.operands.filter((operand) => !operand.executable).map((operand) => operand.snapshot.path);

describe("normalizeSystemRunApprovalPlan", () => {
  const emptyFields = {
    commandPreview: null,
    cwd: null,
    agentId: null,
    sessionKey: null,
    mutableFileOperand: undefined,
  };
  const policy = {
    security: "allowlist",
    ask: "on-miss",
    askFallback: "deny",
    autoAllowSkills: false,
  };
  const echo = { argv: Object.freeze(["echo", "hi"]), commandText: "echo hi" };
  const bash = {
    argv: Object.freeze(["bash", "-lc", "echo hi"]),
    commandText: 'bash -lc "echo hi"',
  };
  it("accepts commandText and normalized mutable file operands", () => {
    expect(
      normalizeSystemRunApprovalPlan({
        ...bash,
        commandPreview: "echo hi",
        cwd: " /tmp ",
        agentId: " main ",
        sessionKey: " agent:main:main ",
        mutableFileOperand: { argvIndex: 2, path: " /tmp/payload.txt ", sha256: " abc123 " },
      }),
    ).toEqual({
      ...bash,
      commandPreview: "echo hi",
      cwd: " /tmp ",
      agentId: "main",
      sessionKey: "agent:main:main",
      mutableFileOperand: { argvIndex: 2, path: "/tmp/payload.txt", sha256: "abc123" },
    });
  });
  it.each([
    [
      "canonicalizes and deduplicates",
      "on-miss",
      [
        { pattern: "/usr/bin/zsh", source: "allow-always" },
        { pattern: "/usr/bin/echo" },
        { pattern: "/usr/bin/echo" },
      ],
      [{ pattern: "/usr/bin/echo" }, { pattern: "/usr/bin/zsh", source: "allow-always" }],
    ],
    [
      "uses portable UTF-8 ordering",
      "always",
      [
        { pattern: "/😀" },
        { pattern: "/A", argPattern: "z" },
        { pattern: "/é" },
        { pattern: "/A", source: "allow-always" },
        { pattern: "/a" },
        { pattern: "/A" },
        { pattern: "/A", argPattern: "A" },
      ],
      [
        { pattern: "/A" },
        { pattern: "/A", source: "allow-always" },
        { pattern: "/A", argPattern: "A" },
        { pattern: "/A", argPattern: "z" },
        { pattern: "/a" },
        { pattern: "/é" },
        { pattern: "/😀" },
      ],
    ],
  ])("%s for prepared policy rules", (_name, ask, input, expected) => {
    expect(
      normalizeSystemRunApprovalPlan({
        ...echo,
        policySnapshot: { ...policy, ask, allowlistRules: input },
      }),
    ).toEqual({
      ...echo,
      ...emptyFields,
      policySnapshot: { ...policy, ask, allowlistRules: expected },
    });
  });
  it("falls back to rawCommand", () => {
    expect(
      normalizeSystemRunApprovalPlan({ argv: bash.argv, rawCommand: bash.commandText }),
    ).toEqual({ ...bash, ...emptyFields });
  });

  it.each([
    {
      ...bash,
      mutableFileOperand: { argvIndex: -1, path: "/tmp/payload.txt", sha256: "abc123" },
    },
    {
      ...echo,
      policySnapshot: {
        ...policy,
        security: "full",
        ask: "off",
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
    expect(buildSystemRunApprovalEnvBinding({ bad: 1 })).toEqual({ envHash: null, envKeys: [] });
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
        cwd: " /tmp ",
        agentId: "main",
        sessionKey: "agent:main:main",
        envHash: envBinding.envHash,
      },
      envKeys: ["alpha", "beta"],
    });
  });

  it("produces distinct bindings for whitespace-distinct cwd values", () => {
    const withSpace = buildSystemRunApprovalBinding({
      argv: ["echo", "hi"],
      cwd: "/srv/data ",
    });
    const noSpace = buildSystemRunApprovalBinding({
      argv: ["echo", "hi"],
      cwd: "/srv/data",
    });
    expect(withSpace.binding.cwd).toBe("/srv/data ");
    expect(noSpace.binding.cwd).toBe("/srv/data");
    expect(withSpace.binding.cwd).not.toBe(noSpace.binding.cwd);
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
    { argv: ["bash", "-lc", "echo bye"] },
    { cwd: "/var/tmp" },
    { agentId: "other" },
    { sessionKey: "agent:main:other" },
  ])("rejects approval binding mismatch: %j", (difference) => {
    expect(
      matchSystemRunApprovalBinding({
        expected,
        actual: { ...expected, ...difference },
        actualEnvKeys: ["ALPHA"],
      }),
    ).toEqual({
      ok: false,
      code: "APPROVAL_REQUEST_MISMATCH",
      message: "approval id does not match request",
      details: undefined,
    });
  });
});

describe("mutable file operand binding", () => {
  afterEach(() => vi.restoreAllMocks());
  it.runIf(process.platform !== "win32")(
    "binds protected executable identity without hashing or requiring one-shot approval",
    async () => {
      vi.spyOn(mutableFilePolicy, "pathLooksMutableForShellPayloadSync").mockReturnValue(false);
      const binding = await bind({ kind: "shell", text: "ls *.ts" }, undefined, { PATH: "/bin" });
      expect(binding.operands).toEqual([
        expect.objectContaining({
          kind: "identity",
          executable: true,
          argv: ["ls", "*.ts"],
          snapshot: { argvIndex: 0, path: fs.realpathSync("/bin/ls") },
          pathSearch: expect.objectContaining({ path: "/bin" }),
        }),
      ]);
      const reads = vi.spyOn(fs, "readFileSync");
      await expectRevalidation(binding);
      expect(reads).not.toHaveBeenCalled();
      reads.mockRestore();
      const approval = expectOk(
        await prepareSystemRunMutableFileApproval({ command: "/bin/ls *.ts" }),
      );
      expect(approval.requiresOneShot).toBe(false);
      const access = fs.accessSync;
      vi.spyOn(fs, "accessSync").mockImplementation((target, mode) => {
        if (target === "/bin/ls") {
          throw new Error("synthetic executable unavailable");
        }
        return access(target, mode);
      });
      await expectRevalidation(binding, undefined, false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "denies protected executable resolution drift after preparation",
    async () => {
      vi.spyOn(mutableFilePolicy, "pathLooksMutableForShellPayloadSync").mockReturnValue(false);
      const resolution = commandResolution.resolveCommandResolutionFromArgv(["ls"], undefined, {
        PATH: "/bin:/usr/bin",
      });
      if (!resolution) {
        throw new Error("expected executable resolution");
      }
      const resolve = vi
        .spyOn(commandResolution, "resolveCommandResolutionFromArgv")
        .mockReturnValue(resolution);
      const binding = await bind(
        { kind: "segments", segments: [{ argv: ["ls", "*.ts"], raw: "ls *.ts", resolution }] },
        undefined,
        { PATH: "/bin:/usr/bin" },
      );
      resolve.mockReturnValue({
        ...resolution,
        execution: { ...resolution.execution, resolvedRealPath: "/synthetic/changed/ls" },
      });
      await expectRevalidation(binding, undefined, false);
      expect(resolve).toHaveBeenLastCalledWith(
        ["ls", "*.ts"],
        undefined,
        expect.objectContaining({ PATH: "/bin:/usr/bin" }),
        process.platform,
        { useCache: false },
      );
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
      const binding = await bind(command, cwd);

      // Writable interpreter prefixes also bind executables; assert scripts by path.
      expect(scriptPaths(binding)).toEqual([first, second]);
      await expectRevalidation(binding, cwd);

      fs.writeFileSync(second, "print('changed')\n");
      await expectRevalidation(binding, cwd, false);
    });
  });

  it.each([
    ["direct", "./direct.sh", "direct.sh", "direct.sh"],
    ["wrapper", "env WRAPPED=1 ./wrapped.sh", "wrapped.sh", "wrapped.sh"],
    ["native", "./native-tool --version", "native-tool", "native-tool"],
    ["path", "workspace-tool", "bin/workspace-tool", "bin/workspace-tool"],
    ["path-shim", "python payload.py", "bin/python", "payload.py"],
    ["explicit-shim", "./python payload.py", "python", "python"],
  ])("binds %s executables and rejects drift", async (kind, command, file, mutate) => {
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
      const binding = await bind(
        { kind: "shell", text: command },
        cwd,
        kind.startsWith("path")
          ? {
              ...process.env,
              PATH: path.join(cwd, "bin") + path.delimiter + (process.env.PATH ?? ""),
            }
          : undefined,
      );
      const operands = binding.operands;
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
      await expectRevalidation(binding, cwd);
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
      await expectRevalidation(binding, cwd, false);
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
        "-se": "echo positional\n",
      };
      for (const [file, bytes] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
        fs.writeFileSync(path.join(cwd, file), bytes, {
          mode: file === "payload.sh" ? 0o755 : 0o644,
        });
      }
      const positionalArgument = await bind(
        { kind: "argv", argv: ["bash", "job.sh", "-secret"] },
        cwd,
      );
      expect(scriptPaths(positionalArgument)).toEqual([path.join(cwd, "job.sh")]);
      const afterDoubleDash = await bind({ kind: "argv", argv: ["bash", "--", "-se"] }, cwd);
      expect(scriptPaths(afterDoubleDash)).toEqual([path.join(cwd, "-se")]);
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
      await withTempDir("openclaw-system-run-unreadable-", async (cwd) => {
        const script = path.join(cwd, "unreadable.sh");
        fs.writeFileSync(script, "#!/bin/sh\necho hidden\n", { mode: 0o000 });
        try {
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
        }
      });
    },
  );
});

const systemPath = "/usr/bin:/bin";
const unresolved = {
  ok: false,
  message: "SYSTEM_RUN_DENIED: approval requires a resolved executable",
};
const bindShell = (text: string, cwd?: string, env = { PATH: systemPath }) =>
  bind({ kind: "shell", text }, cwd, env);

describe.runIf(process.platform !== "win32")("dispatch wrapper executable binding", () => {
  it.each([
    { command: "ls *.txt", eligible: true },
    { command: "env FOO=bar ls *.txt", eligible: false },
    { command: "sh -c 'ls *.txt'", eligible: false },
    { command: `${"env ".repeat(MAX_DISPATCH_WRAPPER_DEPTH)}ls *.txt`, eligible: true },
    { command: `${"env ".repeat(MAX_DISPATCH_WRAPPER_DEPTH + 1)}ls *.txt`, eligible: false },
    { command: "command ls *.txt", eligible: false },
    { command: "exec ls *.txt", eligible: false },
  ])("requires complete dispatch binding for $command", async ({ command, eligible }) => {
    const env = { PATH: systemPath };
    const authorizationPlan = await planShellAuthorization({ command, env });
    const binding = await bindShell(command, undefined, env);
    expect(resolveUnpinnedAutoApprovalEligibility({ authorizationPlan, binding }).eligible).toBe(
      eligible,
    );
  });

  it.each(["env", "ls"])(
    "requires the recorded operand for %s in a complete chain",
    async (executable) => {
      const command = "env ls *.txt";
      const env = { PATH: systemPath };
      const authorizationPlan = await planShellAuthorization({ command, env });
      const binding = await bindShell(command, undefined, env);
      expect(resolveUnpinnedAutoApprovalEligibility({ authorizationPlan, binding }).eligible).toBe(
        true,
      );
      binding.operands = binding.operands.filter(
        (operand) =>
          operand.snapshot.path !==
          fs.realpathSync(executable === "env" ? "/usr/bin/env" : "/bin/ls"),
      );
      expect(resolveUnpinnedAutoApprovalEligibility({ authorizationPlan, binding })).toEqual({
        eligible: false,
        reason: "Exec auto-review skipped: dispatch chain cannot be bound",
      });
    },
  );

  it.each([
    { name: "direct argv executable", shellCommand: false, prefix: [] },
    { name: "shell env child", shellCommand: true, prefix: ["env"] },
  ])("binds an external command carrier used as $name", ({ shellCommand, prefix }) =>
    withTempDir("openclaw-wrapper-carrier-", async (rawCwd) => {
      const cwd = fs.realpathSync(rawCwd);
      const carrierPath = path.join(cwd, "command");
      fs.copyFileSync("/usr/bin/true", carrierPath);
      fs.chmodSync(carrierPath, 0o755);
      const env = { PATH: `${cwd}${path.delimiter}${systemPath}` };
      const argv = [...prefix, "command", "true"];
      const resolution = resolveCommandResolutionFromArgv(argv, cwd, env);
      expect(resolution?.execution.resolvedRealPath).toBe(fs.realpathSync("/usr/bin/true"));
      const prepared = prepareSystemRunExecutableIdentityBinding({
        segments: [{ argv, raw: argv.join(" "), resolution }],
        cwd,
        env,
        shellCommand,
      });
      assert(prepared.ok);
      expect(prepared.binding.operands.map((operand) => operand.snapshot.path)).toEqual([
        ...prefix.map(() => fs.realpathSync("/usr/bin/env")),
        carrierPath,
        fs.realpathSync("/usr/bin/true"),
      ]);
    }),
  );

  it("rejects an unavailable wrapper even when its final executable resolves", () =>
    withTempDir("openclaw-wrapper-unavailable-", async (cwd) => {
      const argv = [path.join(cwd, "toybox"), "sh", "-c", "true"];
      const env = { PATH: systemPath };
      const resolution = resolveCommandResolutionFromArgv(argv, cwd, env);
      expect(resolution?.execution.resolvedRealPath).toBeTruthy();
      expect(
        prepareSystemRunExecutableIdentityBinding({
          segments: [{ argv, raw: argv.join(" "), resolution }],
          cwd,
          env,
          shellCommand: true,
        }),
      ).toEqual(unresolved);
    }));

  it("binds original absolute and relative wrapper paths throughout a nested dispatch chain", () =>
    withTempDir("openclaw-wrapper-original-", async (rawCwd) => {
      const cwd = fs.realpathSync(rawCwd);
      const binDir = path.join(cwd, "bin");
      fs.mkdirSync(binDir);
      const envPath = path.join(binDir, "env");
      const nicePath = path.join(binDir, "nice");
      fs.copyFileSync("/usr/bin/env", envPath);
      fs.copyFileSync("/usr/bin/nice", nicePath);
      fs.chmodSync(envPath, 0o755);
      fs.chmodSync(nicePath, 0o755);
      const binding = await bindShell(`'${envPath}' ./bin/nice -n 1 ls`, cwd);
      expect(
        binding.operands
          .filter((operand) => operand.executable)
          .map((operand) => operand.snapshot.path),
      ).toEqual([envPath, nicePath, fs.realpathSync("/bin/ls")]);
      await expectRevalidation(binding, cwd);

      fs.appendFileSync(nicePath, Buffer.from([0]));
      await expectRevalidation(binding, cwd, false);
    }));

  it("rejects a changed real-file target for a PATH-resolved executable", () =>
    withTempDir("openclaw-wrapper-realpath-", async (rawCwd) => {
      const cwd = fs.realpathSync(rawCwd);
      const binDir = path.join(cwd, "bin");
      fs.mkdirSync(binDir);
      const executable = path.join(binDir, "ls");
      fs.symlinkSync("/bin/ls", executable);
      const binding = await bindShell("env ls", cwd, {
        PATH: `${binDir}${path.delimiter}${systemPath}`,
      });
      await expectRevalidation(binding, cwd);

      fs.unlinkSync(executable);
      fs.symlinkSync("/usr/bin/env", executable);

      await expectRevalidation(binding, cwd, false);
    }));

  it("rejects an unresolved original external wrapper token", () =>
    withTempDir("openclaw-wrapper-missing-", async (cwd) => {
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "shell", text: "./missing/env ls" },
          cwd,
          env: { PATH: systemPath },
        }),
      ).resolves.toEqual(unresolved);
    }));
});
