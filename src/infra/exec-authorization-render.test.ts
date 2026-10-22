import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  makeExecutable,
  makePathEnv,
  makeExecApprovalsTempDir,
} from "./exec-approvals-test-helpers.js";
import { planShellAuthorization } from "./exec-authorization-plan.js";
import {
  buildAuthorizedShellCommandFromPlan,
  buildReviewedShellCommandFromPlan,
} from "./exec-authorization-render.js";
import { prepareSystemRunMutableFileBinding } from "./system-run-approval-binding.js";

const POSIX_ENV = { PATH: "/usr/bin:/bin" };

async function render(
  command: string,
  mode: Parameters<typeof buildAuthorizedShellCommandFromPlan>[0]["mode"],
  segmentSatisfiedBy: Parameters<
    typeof buildAuthorizedShellCommandFromPlan
  >[0]["segmentSatisfiedBy"],
  env: NodeJS.ProcessEnv = POSIX_ENV,
) {
  const plan = await planShellAuthorization({ command, env });
  return buildAuthorizedShellCommandFromPlan({ plan, mode, segmentSatisfiedBy });
}

function renderOk(result: ReturnType<typeof buildAuthorizedShellCommandFromPlan>): string {
  expect(result).toEqual(expect.objectContaining({ ok: true }));
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.command;
}

async function prepareReviewedCommand(command: string, env: NodeJS.ProcessEnv, cwd?: string) {
  const plan = await planShellAuthorization({ command, env, cwd });
  if (!plan.ok) {
    throw new Error(plan.reason);
  }
  const prepared = await prepareSystemRunMutableFileBinding({
    command: {
      kind: "segments",
      segments: plan.groups.flatMap((group) =>
        group.candidates.map((entry) => entry.sourceSegment),
      ),
    },
    env,
    cwd,
  });
  if (!prepared.ok) {
    throw new Error(prepared.message);
  }
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

  it("renders dispatch-wrapper safe-bin commands without quote-all argv rendering", async () => {
    const env = makePathEnv(makeExecApprovalsTempDir());
    expect(renderOk(await render("env rg -n needle", "safeBins", ["safeBins"], env))).toBe(
      "rg -n needle",
    );
  });

  it("preserves non-rewritten wrapper payload commands", async () => {
    const result = await render("sh -c 'git status && head -c 16'", "safeBins", [null, "safeBins"]);
    expect(renderOk(result)).toMatch(/^sh -c 'git status && \/.+\/head -c 16'$/);
  });

  it("leaves POSIX safe builtins unrewritten in enforced mode", async () => {
    expect(renderOk(await render("cd .", "enforced", ["safeBuiltins"]))).toBe("cd .");
  });

  it("preserves env assignment prefixes for enforced POSIX commands", async () => {
    const result = await render("LIMIT=1 head -n 5", "enforced", ["allowlist"]);
    expect(renderOk(result)).toMatch(/^LIMIT=1 \/.+\/head -n 5$/);
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
  it.each([
    [
      '"ls"  "雪" *.txt | cat && env ls ~/docs; ls \\*.txt\nls "*.txt"',
      "'BIN/ls'  \"雪\" *.txt | 'BIN/cat' && 'BIN/env' 'BIN/ls' ~/docs; 'BIN/ls' \\*.txt\n'BIN/ls' \"*.txt\"",
    ],
  ])("preserves argument expansion and topology for %s", async (source, expected) => {
    const binDir = makeExecApprovalsTempDir();
    for (const executable of ["env", "ls", "cat"]) {
      makeExecutable(binDir, executable);
    }
    const prepared = await prepareReviewedCommand(source, makePathEnv(binDir));

    expect(renderOk(buildReviewedShellCommandFromPlan(prepared))).toBe(
      expected.replaceAll("BIN", binDir),
    );
  });

  it("quotes bound executable paths containing shell metacharacters", async () => {
    const binDir = makeExecApprovalsTempDir();
    makeExecutable(binDir, "tool's name");
    const prepared = await prepareReviewedCommand('"tool\'s name" *.txt', makePathEnv(binDir));

    expect(renderOk(buildReviewedShellCommandFromPlan(prepared))).toBe(
      `'${binDir}/tool'"'"'s name' *.txt`,
    );
  });

  it.each(["spans", "final binding"])(
    "refuses a partially pinned dispatch when %s are missing",
    async (missing) => {
      const binDir = makeExecApprovalsTempDir();
      makeExecutable(binDir, "env");
      makeExecutable(binDir, "ls");
      const prepared = await prepareReviewedCommand("env ls *.txt", makePathEnv(binDir));
      if (missing === "spans") {
        for (const group of prepared.plan.groups) {
          for (const candidate of group.candidates) {
            delete candidate.sourceStep.argvSpans;
          }
        }
      } else {
        prepared.binding.operands = prepared.binding.operands.filter(
          (operand) => operand.argv.length !== 3,
        );
      }

      expect(buildReviewedShellCommandFromPlan(prepared).ok).toBe(false);
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
        const command = renderOk(buildReviewedShellCommandFromPlan(prepared));
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
