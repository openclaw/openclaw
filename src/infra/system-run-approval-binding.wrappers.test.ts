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
const unresolved = {
  ok: false,
  message: "SYSTEM_RUN_DENIED: approval requires a resolved executable",
};

async function bindShell(text: string, cwd?: string, env = { PATH: systemPath }) {
  const prepared = await prepareSystemRunMutableFileBinding({
    command: { kind: "shell", text },
    cwd,
    env,
  });
  assert(prepared.ok);
  return prepared.binding;
}

function expectRevalidation(
  binding: Parameters<typeof revalidateSystemRunMutableFileBinding>[0]["binding"],
  cwd: string,
  ok = true,
) {
  return expect(revalidateSystemRunMutableFileBinding({ binding, cwd })).resolves.toEqual(
    ok ? { ok: true } : { ok: false, message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE },
  );
}

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
import assert from "node:assert/strict";
