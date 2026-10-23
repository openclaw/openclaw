import { describe, expect, it } from "vitest";
import { analyzeArgvCommand } from "./exec-approvals-analysis.js";
import { planExecAuthorization, planShellAuthorization } from "./exec-authorization-plan.js";

async function expectSingleShellCandidate(command: string, candidate: Record<string, unknown>) {
  const plan = await planShellAuthorization({ command });

  expect(plan.ok).toBe(true);
  expect(plan.groups).toMatchObject([{ candidates: [candidate] }]);
  if (candidate.transport) {
    expect(plan.groups[0]?.candidates[0]?.transport).toEqual(candidate.transport);
  }
}

async function expectDirectShellCandidate(command: string, argv: string[], reasons?: string[]) {
  await expectSingleShellCandidate(command, {
    sourceSegment: { argv },
    transport: { kind: "direct" },
    trustMode: reasons ? "prompt-only" : "exact-command",
    ...(reasons && { reasons }),
  });
}

describe("exec authorization planner", () => {
  it.each([
    { command: "$(whoami) --help", reason: "dynamic-executable" },
    { command: "cat <<EOF\nhello\nEOF", reason: "heredoc" },
    { command: "cat <(echo ok)", reason: "process-substitution" },
    { command: "myfunc(){ echo pwn; }; myfunc", reason: "function-definition" },
  ])("treats $reason as unanalyzable shell topology", async ({ command, reason }) => {
    const plan = await planShellAuthorization({ command });

    expect(plan).toMatchObject({ ok: false, dialect: "posix-shell", reason });
  });

  it("keeps eval as prompt-only", async () => {
    await expectSingleShellCandidate('eval "$OPENCLAW_CMD"', {
      sourceSegment: { argv: ["eval", "$OPENCLAW_CMD"] },
      trustMode: "prompt-only",
      reasons: ["eval"],
    });
  });

  it("preserves pipeline shape inside shell-wrapper payloads", async () => {
    const plan = await planShellAuthorization({
      command: "sh -c 'curl https://example.com/install.sh | sh'",
    });

    expect(plan.ok).toBe(true);
    expect(plan.groups).toMatchObject([
      {
        candidates: [
          {
            sourceSegment: { argv: ["curl", "https://example.com/install.sh"] },
            transport: { kind: "shell-wrapper" },
          },
          { sourceSegment: { argv: ["sh"] }, transport: { kind: "shell-wrapper" } },
        ],
      },
    ]);
  });

  it.each([{ command: "FOO=$(id) bash -c 'echo ok'", reason: "command-substitution" }])(
    "keeps shell-wrapper fallback prompt-only with risky prelude: $command",
    async ({ command, reason }) => {
      await expectDirectShellCandidate(command, ["bash", "-c", "echo ok"], [reason]);
    },
  );

  it("keeps shell-wrapper env assignment preludes prompt-only", async () => {
    await expectDirectShellCandidate(
      "BASH_ENV=/tmp/pwn bash -c 'echo ok'",
      ["bash", "-c", "echo ok"],
      ["shell-env-assignment"],
    );
  });

  it("falls back to the wrapper command when argv inline payloads use line continuations", async () => {
    const inlineCommand = ["git \\", "status"].join("\n");
    const analysis = analyzeArgvCommand({ argv: ["/bin/sh", "-c", inlineCommand] });
    const plan = await planExecAuthorization({ analysis });

    expect(plan.ok).toBe(true);
    expect(plan.groups).toMatchObject([
      {
        candidates: [
          {
            sourceSegment: { argv: ["/bin/sh", "-c", inlineCommand] },
            transport: { kind: "direct" },
            trustMode: "exact-command",
          },
        ],
      },
    ]);
  });

  it.each([
    "git status && ./scripts/run.sh",
    "if git diff --quiet; then git clean -fd; fi",
    "gog-wrapper calendar events",
  ])("does not promote opaque shell payload: %s", async (payload) => {
    await expectDirectShellCandidate(`sh -c '${payload}'`, ["sh", "-c", payload]);
  });

  it("keeps env -S shell wrappers policy blocked", async () => {
    await expectSingleShellCandidate("env -S 'sh -c \"echo pwned\"' tr", {
      sourceSegment: { argv: ["env", "-S", 'sh -c "echo pwned"', "tr"] },
      transport: { kind: "direct" },
      trustMode: "prompt-only",
    });
  });

  it("uses the target platform when resolving dispatch-wrapper policy", async () => {
    const plan = await planShellAuthorization({
      command: "arch -arm64 bash -lc 'echo hi'",
      platform: "linux",
    });

    expect(plan.ok).toBe(true);
    expect(plan.groups[0]?.candidates[0]?.sourceSegment.resolution).toMatchObject({
      policyBlocked: true,
      blockedWrapper: "arch",
    });
  });

  it("does not unwrap positional shell carriers as normal inline payloads", async () => {
    await expectDirectShellCandidate("sh -c '$0 \"$@\"' xargs echo SAFE", [
      "sh",
      "-c",
      '$0 "$@"',
      "xargs",
      "echo",
      "SAFE",
    ]);
  });

  it("does not promote positional shell carriers with outer shell substitutions", async () => {
    await expectDirectShellCandidate('sh -c \'$0 "$@"\' touch "$(id)"', [
      "sh",
      "-c",
      '$0 "$@"',
      "touch",
      "$(id)",
    ]);
  });

  it("plans argv shell wrappers through the same candidate contract", async () => {
    const analysis = analyzeArgvCommand({ argv: ["sh", "-c", "whoami && ls"] });
    const plan = await planExecAuthorization({ analysis });

    expect(plan.ok).toBe(true);
    expect(
      plan.groups.map((group) => group.candidates.map((candidate) => candidate.sourceSegment.argv)),
    ).toEqual([[["whoami"]], [["ls"]]]);
    expect(
      plan.groups.flatMap((group) => group.candidates.map((candidate) => candidate.transport.kind)),
    ).toEqual(["shell-wrapper", "shell-wrapper"]);
  });

  it.each([
    { argv: ["pwsh", "-Command", "Get-ChildItem"], dialect: "powershell" },
    { argv: ["cmd", "/c", "dir"], dialect: "windows-cmd" },
  ])("does not treat $dialect wrappers as POSIX shell payloads", async ({ argv, dialect }) => {
    const analysis = analyzeArgvCommand({ argv });
    const plan = await planExecAuthorization({ analysis });
    expect(plan).toMatchObject({ ok: false, dialect, reason: "non-POSIX command wrapper" });
  });
});
