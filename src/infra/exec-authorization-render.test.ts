import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  makeExecutable,
  makePathEnv,
  makeExecApprovalsTempDir,
} from "./exec-approvals-test-helpers.js";
import { planShellAuthorization as planShell } from "./exec-authorization-plan.js";
import {
  buildAuthorizedShellCommandFromPlan as renderAuthorized,
  buildReviewedShellCommandFromPlan as renderReviewed,
} from "./exec-authorization-render.js";
import { prepareSystemRunMutableFileBinding as prepareBinding } from "./system-run-approval-binding.js";

const POSIX_ENV = { PATH: "/usr/bin:/bin" };
type RenderOptions = Parameters<typeof renderAuthorized>[0];
function executableEnv(...names: string[]) {
  const dir = makeExecApprovalsTempDir();
  names.forEach((name) => makeExecutable(dir, name));
  return { dir, env: makePathEnv(dir) };
}

async function render(
  command: string,
  mode: RenderOptions["mode"],
  segmentSatisfiedBy: RenderOptions["segmentSatisfiedBy"],
  env: NodeJS.ProcessEnv = POSIX_ENV,
) {
  const plan = await planShell({ command, env });
  return renderAuthorized({ plan, mode, segmentSatisfiedBy });
}

function renderOk(result: ReturnType<typeof renderAuthorized>): string {
  assert(result.ok, "Expected an authorized shell command");
  return result.command;
}

async function prepareReviewedCommand(command: string, env: NodeJS.ProcessEnv, cwd?: string) {
  const plan = await planShell({ command, env, cwd });
  assert(plan.ok, "Expected a shell authorization plan");
  const prepared = await prepareBinding({
    command: {
      kind: "segments",
      segments: plan.groups.flatMap((group) =>
        group.candidates.map((entry) => entry.sourceSegment),
      ),
    },
    env,
    cwd,
  });
  assert(prepared.ok, "Expected a prepared shell binding");
  return { plan, binding: prepared.binding };
}

describe("exec authorization renderer", () => {
  it.each<[string, Parameters<typeof render>[1], Parameters<typeof render>[2], string]>([
    [
      "rg foo src/*.ts | head -n {5,/etc/passwd} && echo ok",
      "safeBins",
      [null, "safeBins", null],
      "shell expansion in safe-bin arguments",
    ],
    [
      "true *.txt && head -n 1",
      "enforced",
      ["safeBuiltins", "allowlist"],
      "shell expansion in enforced arguments",
    ],
    ["cat ~/secret", "enforced", ["allowlist"], "shell expansion in enforced arguments"],
    ["sh -c 'head -n 5'", "enforced", ["allowlist"], "shell quoting required in wrapper payload"],
    ["git diff | head", "safeBins", ["safeBins"], "segment metadata mismatch"],
  ])("fails closed for %s (%s)", async (command, mode, satisfiedBy, reason) => {
    await expect(render(command, mode, satisfiedBy)).resolves.toEqual({ ok: false, reason });
  });

  it.each<[string, RenderOptions["mode"], RenderOptions["segmentSatisfiedBy"], unknown]>([
    ["env rg -n needle", "safeBins", ["safeBins"], "rg -n needle"],
    [
      "sh -c 'git status && head -c 16'",
      "safeBins",
      [null, "safeBins"],
      expect.stringMatching(/^sh -c 'git status && \/.+\/head -c 16'$/),
    ],
    ["cd .", "enforced", ["safeBuiltins"], "cd ."],
    [
      "LIMIT=1 head -n 5",
      "enforced",
      ["allowlist"],
      expect.stringMatching(/^LIMIT=1 \/.+\/head -n 5$/),
    ],
  ])("preserves authorized shell semantics: %s", async (command, mode, satisfiedBy, expected) => {
    const env = command.startsWith("env ") ? makePathEnv(makeExecApprovalsTempDir()) : POSIX_ENV;
    await expect(render(command, mode, satisfiedBy, env)).resolves.toEqual({
      ok: true,
      command: expected,
    });
  });

  it("fails closed when shell-wrapper safe-bin rewrites would need outer quote escaping", async () => {
    const dir = path.join(makeExecApprovalsTempDir(), "safe bin dir");
    fs.mkdirSync(dir);
    makeExecutable(dir, "head");
    await expect(
      render("sh -c 'head -n 5'", "safeBins", ["safeBins"], makePathEnv(dir)),
    ).resolves.toEqual({ ok: false, reason: "shell quoting required in wrapper payload" });
  });
});

describe.skipIf(process.platform === "win32")("reviewed shell dispatch renderer", () => {
  it("preserves argument expansion and topology", async () => {
    const { dir, env } = executableEnv("env", "ls", "cat");
    const source = '"ls"  "雪" *.txt | cat && env ls ~/docs; ls \\*.txt\nls "*.txt"';
    const expected =
      "'BIN/ls'  \"雪\" *.txt | 'BIN/cat' && 'BIN/env' 'BIN/ls' ~/docs; 'BIN/ls' \\*.txt\n'BIN/ls' \"*.txt\"";
    const prepared = await prepareReviewedCommand(source, env);
    expect(renderOk(renderReviewed(prepared))).toBe(expected.replaceAll("BIN", dir));
  });

  it("quotes bound executable paths containing shell metacharacters", async () => {
    const { dir, env } = executableEnv("tool's name");
    const prepared = await prepareReviewedCommand('"tool\'s name" *.txt', env);

    expect(renderOk(renderReviewed(prepared))).toBe(`'${dir}/tool'"'"'s name' *.txt`);
  });

  it.each(["spans", "final binding"])(
    "refuses a partially pinned dispatch when %s are missing",
    async (missing) => {
      const { env } = executableEnv("env", "ls");
      const prepared = await prepareReviewedCommand("env ls *.txt", env);
      if (missing === "spans") {
        for (const candidate of prepared.plan.groups.flatMap((group) => group.candidates)) {
          delete candidate.sourceStep.argvSpans;
        }
      } else {
        prepared.binding.operands = prepared.binding.operands.filter(
          (operand) => operand.argv.length !== 3,
        );
      }

      expect(renderReviewed(prepared).ok).toBe(false);
    },
  );

  for (const shell of ["/bin/bash", "/bin/zsh"]) {
    it.skipIf(!fs.existsSync(shell))(
      `executes bound globs and wrappers despite functions, aliases, and PATH in ${shell}`,
      async () => {
        const cwd = makeExecApprovalsTempDir();
        fs.writeFileSync(path.join(cwd, "approved.txt"), "");
        const prepared = await prepareReviewedCommand(
          "env -- env ls *.txt | cat && ls *.txt",
          POSIX_ENV,
          cwd,
        );
        const command = renderOk(renderReviewed(prepared));
        const aliases = shell.endsWith("zsh")
          ? [...new Set(prepared.binding.operands.map((entry) => entry.snapshot.path))]
              .map((executable) => `alias -g '${executable}=false'`)
              .join("\n")
          : "";
        const startup = [
          'if [ -n "${BASH_VERSION:-}" ]; then shopt -s expand_aliases; fi',
          "ls() { printf 'UNREVIEWED_FUNCTION\\n'; }",
          "env() { printf 'UNREVIEWED_WRAPPER_FUNCTION\\n'; }",
          "alias ls=false",
          "alias env=false",
          aliases,
          "PATH=/unreviewed-path",
          'eval "$1"',
        ].join("\n");
        const shellArgs = shell.endsWith("bash") ? ["--noprofile", "--norc"] : ["-f"];

        expect(
          execFileSync(shell, [...shellArgs, "-c", startup, "reviewed-dispatch", command], {
            cwd,
            env: { ...POSIX_ENV, HOME: cwd },
            encoding: "utf8",
          }),
        ).toBe("approved.txt\napproved.txt\n");
      },
    );
  }
});
