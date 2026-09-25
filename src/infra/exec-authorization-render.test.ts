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

async function render(
  command: string,
  options: Omit<Parameters<typeof buildAuthorizedShellCommandFromPlan>[0], "plan">,
  env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" },
) {
  const plan = await planShellAuthorization({ command, env });
  return buildAuthorizedShellCommandFromPlan({ plan, ...options });
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
  it("rewrites only approved executables while preserving pipeline arguments", async () => {
    const command = renderOk(
      await render("git diff | head", {
        mode: "safeBins",
        segmentSatisfiedBy: [null, "safeBins"],
      }),
    );
    expect(command).toMatch(/^git diff \| \/.+\/head$/);
  });

  it("fails closed when POSIX safe-bin arguments contain shell expansion source", async () => {
    await expect(
      render("rg foo src/*.ts | head -n {5,/etc/passwd} && echo ok", {
        mode: "safeBins",
        segmentSatisfiedBy: [null, "safeBins", null],
      }),
    ).resolves.toEqual({ ok: false, reason: "shell expansion in safe-bin arguments" });
  });

  it("renders dispatch-wrapper safe-bin commands without quote-all argv rendering", async () => {
    const command = renderOk(
      await render(
        "env rg -n needle",
        {
          mode: "safeBins",
          segmentSatisfiedBy: ["safeBins"],
        },
        makePathEnv(makeExecApprovalsTempDir()),
      ),
    );
    expect(command).toBe("rg -n needle");
  });

  it("renders shell-wrapper payloads by preserving wrapper transport", async () => {
    const command = renderOk(
      await render("sh -c 'tr a b && head -c 16'", {
        mode: "safeBins",
        segmentSatisfiedBy: ["safeBins", "safeBins"],
      }),
    );
    expect(command).toMatch(/^sh -c '\/.+\/tr a b && \/.+\/head -c 16'$/);
  });

  it("preserves non-rewritten wrapper payload commands", async () => {
    const command = renderOk(
      await render("sh -c 'git status && head -c 16'", {
        mode: "safeBins",
        segmentSatisfiedBy: [null, "safeBins"],
      }),
    );
    expect(command).toMatch(/^sh -c 'git status && \/.+\/head -c 16'$/);
  });

  it("source-preserves arguments for enforced POSIX commands", async () => {
    const command = renderOk(
      await render("head -c 16", {
        mode: "enforced",
        segmentSatisfiedBy: ["safeBins"],
      }),
    );
    expect(command).toMatch(/^\/.+\/head -c 16$/);
  });

  it("leaves POSIX safe builtins unrewritten in enforced mode", async () => {
    const command = renderOk(
      await render("cd .", {
        mode: "enforced",
        segmentSatisfiedBy: ["safeBuiltins"],
      }),
    );
    expect(command).toBe("cd .");
  });

  it("rejects shell expansion in safe builtins without rewriting them", async () => {
    await expect(
      render("true *.txt && head -n 1", {
        mode: "enforced",
        segmentSatisfiedBy: ["safeBuiltins", "allowlist"],
      }),
    ).resolves.toEqual({ ok: false, reason: "shell expansion in enforced arguments" });
  });

  it("rewrites quoted POSIX executable source spans", async () => {
    const command = renderOk(
      await render('"head" -c 16', {
        mode: "safeBins",
        segmentSatisfiedBy: ["safeBins"],
      }),
    );
    expect(command).toMatch(/^\/.+\/head -c 16$/);
  });

  it("fails closed for enforced POSIX commands with shell glob arguments", async () => {
    await expect(
      render("ls *.ts", {
        mode: "enforced",
        segmentSatisfiedBy: ["allowlist"],
      }),
    ).resolves.toEqual({ ok: false, reason: "shell expansion in enforced arguments" });
  });

  it("fails closed for enforced POSIX commands with tilde-expanded arguments", async () => {
    await expect(
      render("cat ~/secret", {
        mode: "enforced",
        segmentSatisfiedBy: ["allowlist"],
      }),
    ).resolves.toEqual({ ok: false, reason: "shell expansion in enforced arguments" });
  });

  it("preserves env assignment prefixes for enforced POSIX commands", async () => {
    const command = renderOk(
      await render("LIMIT=1 head -n 5", {
        mode: "enforced",
        segmentSatisfiedBy: ["allowlist"],
      }),
    );
    expect(command).toMatch(/^LIMIT=1 \/.+\/head -n 5$/);
  });

  it("fails closed for enforced shell-wrapper payload rewrites", async () => {
    await expect(
      render("sh -c 'head -n 5'", {
        mode: "enforced",
        segmentSatisfiedBy: ["allowlist"],
      }),
    ).resolves.toEqual({ ok: false, reason: "shell quoting required in wrapper payload" });
  });

  it("fails closed when shell-wrapper safe-bin rewrites would need outer quote escaping", async () => {
    const dir = path.join(makeExecApprovalsTempDir(), "safe bin dir");
    fs.mkdirSync(dir);
    makeExecutable(dir, "head");
    await expect(
      render(
        "sh -c 'head -n 5'",
        {
          mode: "safeBins",
          segmentSatisfiedBy: ["safeBins"],
        },
        makePathEnv(dir),
      ),
    ).resolves.toEqual({ ok: false, reason: "shell quoting required in wrapper payload" });
  });

  it("fails closed when candidate metadata does not match the plan", async () => {
    await expect(
      render("git diff | head", {
        mode: "safeBins",
        segmentSatisfiedBy: ["safeBins"],
      }),
    ).resolves.toEqual({ ok: false, reason: "segment metadata mismatch" });
  });
});

describe.skipIf(process.platform === "win32")("reviewed shell dispatch renderer", () => {
  it.each([
    ["ls *.txt", "'BIN/ls' *.txt"],
    ["env -- env 'ls' ~/docs/*.txt", "'BIN/env' -- 'BIN/env' 'BIN/ls' ~/docs/*.txt"],
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

  it.each(["spans", "wrapper binding", "final binding"])(
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
          (operand) => operand.argv.length !== (missing === "wrapper binding" ? 1 : 3),
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
