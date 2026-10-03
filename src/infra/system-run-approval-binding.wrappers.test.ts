import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { MAX_DISPATCH_WRAPPER_DEPTH } from "./dispatch-wrapper-resolution.js";
import { planShellAuthorization } from "./exec-authorization-plan.js";
import { resolveUnpinnedAutoApprovalEligibility } from "./exec-auto-approval-eligibility.js";
import { resolveCommandResolutionFromArgv } from "./exec-command-resolution.js";
import {
  APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
  prepareSystemRunExecutableIdentityBinding,
  prepareSystemRunMutableFileBinding,
  revalidateSystemRunMutableFileBinding,
} from "./system-run-approval-binding.js";

const systemPath = "/usr/bin:/bin";

describe.runIf(process.platform !== "win32")("dispatch wrapper executable binding", () => {
  it.each([
    { command: "ls *.txt", eligible: true },
    { command: "env ls *.txt", eligible: true },
    { command: "env FOO=bar ls *.txt", eligible: false },
    { command: "sh -c 'ls *.txt'", eligible: false },
    { command: `${"env ".repeat(MAX_DISPATCH_WRAPPER_DEPTH)}ls *.txt`, eligible: true },
    { command: `${"env ".repeat(MAX_DISPATCH_WRAPPER_DEPTH + 1)}ls *.txt`, eligible: false },
    { command: "command ls *.txt", eligible: false },
    { command: "exec ls *.txt", eligible: false },
  ])("requires complete dispatch binding for $command", async ({ command, eligible }) => {
    const env = { PATH: systemPath };
    const authorizationPlan = await planShellAuthorization({ command, env });
    const prepared = await prepareSystemRunMutableFileBinding({
      command: { kind: "shell", text: command },
      env,
    });
    if (!prepared.ok) {
      throw new Error(prepared.message);
    }
    expect(
      resolveUnpinnedAutoApprovalEligibility({ authorizationPlan, binding: prepared.binding })
        .eligible,
    ).toBe(eligible);
  });

  it.each(["env", "ls"])(
    "requires the recorded operand for %s in a complete chain",
    async (executable) => {
      const command = "env ls *.txt";
      const env = { PATH: systemPath };
      const authorizationPlan = await planShellAuthorization({ command, env });
      const prepared = await prepareSystemRunMutableFileBinding({
        command: { kind: "shell", text: command },
        env,
      });
      if (!prepared.ok) {
        throw new Error(prepared.message);
      }
      expect(
        resolveUnpinnedAutoApprovalEligibility({ authorizationPlan, binding: prepared.binding })
          .eligible,
      ).toBe(true);
      prepared.binding.operands = prepared.binding.operands.filter(
        (operand) =>
          operand.snapshot.path !==
          fs.realpathSync(executable === "env" ? "/usr/bin/env" : "/bin/ls"),
      );
      expect(
        resolveUnpinnedAutoApprovalEligibility({ authorizationPlan, binding: prepared.binding }),
      ).toEqual({
        eligible: false,
        reason: "Exec auto-review skipped: dispatch chain cannot be bound",
      });
    },
  );

  describe.each(["builtin", "command", "exec"])("%s dispatch position", (carrier) => {
    it.each([
      { name: "initial shell builtin", shellCommand: true, prefix: [], external: false },
      { name: "direct argv executable", shellCommand: false, prefix: [], external: true },
      { name: "shell env child", shellCommand: true, prefix: ["env"], external: true },
      { name: "direct argv env child", shellCommand: false, prefix: ["env"], external: true },
    ])("binds the external files for $name", async ({ shellCommand, prefix, external }) => {
      await withTempDir("openclaw-wrapper-carrier-", async (rawCwd) => {
        const cwd = fs.realpathSync(rawCwd);
        const carrierPath = path.join(cwd, carrier);
        fs.copyFileSync("/usr/bin/true", carrierPath);
        fs.chmodSync(carrierPath, 0o755);
        const env = { PATH: `${cwd}${path.delimiter}${systemPath}` };
        const argv = [...prefix, carrier, "true"];
        const resolution = resolveCommandResolutionFromArgv(argv, cwd, env);
        expect(resolution?.execution.resolvedRealPath).toBe(fs.realpathSync("/usr/bin/true"));
        const prepared = prepareSystemRunExecutableIdentityBinding({
          segments: [{ argv, raw: argv.join(" "), resolution }],
          cwd,
          env,
          shellCommand,
        });
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) {
          throw new Error(prepared.message);
        }
        expect(prepared.binding.operands.map((operand) => operand.snapshot.path)).toEqual([
          ...prefix.map(() => fs.realpathSync("/usr/bin/env")),
          ...(external ? [carrierPath] : []),
          fs.realpathSync("/usr/bin/true"),
        ]);
      });
    });
  });

  it.each([
    { wrapper: "busybox", command: ["sh", "-c", "true"], enabled: true },
    { wrapper: "toybox", command: ["sh", "-c", "true"], enabled: true },
    { wrapper: "xcrun", command: ["true"], enabled: process.platform === "darwin" },
  ])(
    "rejects an unavailable $wrapper even when its final executable resolves",
    async ({ wrapper, command, enabled }) => {
      if (!enabled) {
        return;
      }
      await withTempDir("openclaw-wrapper-unavailable-", async (cwd) => {
        const argv = [path.join(cwd, wrapper), ...command];
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
        ).toEqual({
          ok: false,
          message: "SYSTEM_RUN_DENIED: approval requires a resolved executable",
        });
      });
    },
  );

  it("binds original absolute and relative wrapper paths throughout a nested dispatch chain", async () => {
    await withTempDir("openclaw-wrapper-original-", async (rawCwd) => {
      const cwd = fs.realpathSync(rawCwd);
      const binDir = path.join(cwd, "bin");
      fs.mkdirSync(binDir);
      const envPath = path.join(binDir, "env");
      const nicePath = path.join(binDir, "nice");
      fs.copyFileSync("/usr/bin/env", envPath);
      fs.copyFileSync("/usr/bin/nice", nicePath);
      fs.chmodSync(envPath, 0o755);
      fs.chmodSync(nicePath, 0o755);
      const prepared = await prepareSystemRunMutableFileBinding({
        command: { kind: "shell", text: `'${envPath}' ./bin/nice -n 1 ls` },
        cwd,
        env: { PATH: systemPath },
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        throw new Error(prepared.message);
      }
      expect(
        prepared.binding.operands
          .filter((operand) => operand.executable)
          .map((operand) => operand.snapshot.path),
      ).toEqual([envPath, nicePath, fs.realpathSync("/bin/ls")]);
      await expect(
        revalidateSystemRunMutableFileBinding({ binding: prepared.binding, cwd }),
      ).resolves.toEqual({ ok: true });

      fs.appendFileSync(nicePath, Buffer.from([0]));
      await expect(
        revalidateSystemRunMutableFileBinding({ binding: prepared.binding, cwd }),
      ).resolves.toEqual({
        ok: false,
        message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
      });
    });
  });

  it.each(["env", "ls"])(
    "rejects a changed real-file target for PATH-resolved %s",
    async (name) => {
      await withTempDir("openclaw-wrapper-realpath-", async (rawCwd) => {
        const cwd = fs.realpathSync(rawCwd);
        const binDir = path.join(cwd, "bin");
        fs.mkdirSync(binDir);
        const executable = path.join(binDir, name);
        fs.symlinkSync(name === "env" ? "/usr/bin/env" : "/bin/ls", executable);
        const prepared = await prepareSystemRunMutableFileBinding({
          command: { kind: "shell", text: "env ls" },
          cwd,
          env: { PATH: `${binDir}${path.delimiter}${systemPath}` },
        });
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) {
          throw new Error(prepared.message);
        }
        await expect(
          revalidateSystemRunMutableFileBinding({ binding: prepared.binding, cwd }),
        ).resolves.toEqual({ ok: true });

        fs.unlinkSync(executable);
        fs.symlinkSync(name === "env" ? "/bin/ls" : "/usr/bin/env", executable);

        await expect(
          revalidateSystemRunMutableFileBinding({ binding: prepared.binding, cwd }),
        ).resolves.toEqual({
          ok: false,
          message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE,
        });
      });
    },
  );

  it("rejects an unresolved original external wrapper token", async () => {
    await withTempDir("openclaw-wrapper-missing-", async (cwd) => {
      await expect(
        prepareSystemRunMutableFileBinding({
          command: { kind: "shell", text: "./missing/env ls" },
          cwd,
          env: { PATH: systemPath },
        }),
      ).resolves.toEqual({
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval requires a resolved executable",
      });
    });
  });
});
