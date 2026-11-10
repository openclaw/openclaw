import { describe, expect, it } from "vitest";
import {
  hasShellCompoundCommand,
  scanTopLevelChars,
  splitTopLevelPipes,
  splitTopLevelStages,
} from "./tool-display-exec-shell.js";
import { resolveExecDetail } from "./tool-display-exec.js";
import {
  formatToolDetail,
  formatToolSummary,
  isShellToolDisplayName,
  resolveToolDisplay,
} from "./tool-display.js";

function detailFor(name: string, args: unknown) {
  return formatToolDetail(resolveToolDisplay({ name, args }));
}

function execDetail(command: string, detailMode?: "explain", workdir?: string, name = "exec") {
  return formatToolDetail(resolveToolDisplay({ name, args: { command, workdir }, detailMode }));
}

it("matches shell tools whatever case the backend spells them in", () => {
  // The Claude CLI sends "Bash"; embedded runs send "bash"/"exec".
  for (const name of ["Bash", "bash", "BASH", "Exec", "exec", "shell"]) {
    expect(isShellToolDisplayName(name)).toBe(true);
  }
  for (const name of ["Read", "web_search", undefined, ""]) {
    expect(isShellToolDisplayName(name)).toBe(false);
  }
});

describe("tool display details", () => {
  it("displays the called tool and inner query for a Tool Search invocation", () => {
    expect(
      resolveToolDisplay({
        name: "tool_call",
        args: { id: "openclaw:search:web_search", args: { query: "OpenClaw release notes" } },
      }),
    ).toMatchObject({
      name: "web_search",
      label: "Web Search",
      detail: 'for "OpenClaw release notes"',
    });
  });

  it("keeps sessions_yield private context out of tool status", () => {
    const display = resolveToolDisplay({
      name: "sessions_yield",
      args: {
        message: "private resume context",
        acknowledgment: "Public waiting status",
      },
    });

    expect(formatToolSummary(display)).toBe("Yield");
    expect(formatToolDetail(display)).toBeUndefined();
  });

  it("keeps same-line heredoc operators from attaching the body to later stages", () => {
    const command = "cat <<EOF && printf ok\nbody | secret\nEOF\nprintf done";
    const stages = splitTopLevelStages(command);

    expect(stages).toHaveLength(2);
    expect(stages[0]).toBe("cat <<EOF");
    expect(stages[1]).toContain("printf ok");
    expect(stages[1]).toContain("printf done");
    expect(stages[1]).not.toContain("body | secret");
    expect(splitTopLevelPipes(stages[1] ?? "")).toHaveLength(1);
  });

  it.each([
    [
      "nodes",
      { action: "camera_ptz", ptzOperation: "status", node: "Mac", deviceId: "camera-id" },
      "ptz operation status, node Mac, device id camera-id",
    ],
    ["read", { file_path: "/tmp/a.txt", offset: 2, limit: 2 }, "lines 2-3 from /tmp/a.txt"],
    ["write", { file_path: "/tmp/a.txt", content: "abc" }, "to /tmp/a.txt (3 chars)"],
    ["edit", { path: "/tmp/a.txt", newText: "abcd" }, "in /tmp/a.txt (4 chars)"],
    [
      "web_search",
      { q: "Codex OAuth API key", max_results: 5 },
      'for "Codex OAuth API key" (top 5)',
    ],
    [
      "web_search",
      { search_query: ["a", "b", "c", "d"].map((q) => ({ q })) },
      'for "a", "b", "c"…',
    ],
    [
      "web_search",
      {
        objective: "Find OpenClaw",
        search_queries: ["github", "repository"],
        count: 5,
      },
      'for "Find OpenClaw", "github", "repository" (top 5)',
    ],
  ] as const)("formats %s arguments with intent-first detail: %j", (name, args, expected) => {
    expect(detailFor(name, args)).toBe(expected);
  });

  it("keeps positive numbers and true booleans", () => {
    const detail = detailFor("sessions_history", {
      sessionKey: "agent:main:main",
      limit: 20,
      includeTools: true,
    });
    for (const field of ["session agent:main:main", "limit 20", "tools true"]) {
      expect(detail).toContain(field);
    }
  });

  it("summarizes exec commands with context", () => {
    const detail = execDetail(
      "set -euo pipefail\ngit -C /Users/adityasingh/.openclaw/workspace status --short | head -n 3",
      undefined,
      "/Users/adityasingh/.openclaw/workspace",
    );

    expect(detail).toContain("check git status -> show first 3 lines");
    expect(detail).toContain("(agent)");
  });

  it("summarizes bash commands with the same command explainer", () => {
    expect(
      execDetail(
        "sed -n '1,80p' extensions/discord/src/draft-stream.ts",
        "explain",
        undefined,
        "bash",
      ),
    ).toBe("print lines 1-80 from extensions/discord/src/draft-stream.ts");
  });

  it("keeps shell compound commands intact instead of inventing command stages", () => {
    for (const command of [
      'for d in $(find . -type d); do echo "$d"; ls "$d"; done',
      "echo start && if test -f package.json; then pnpm test; fi",
      "(echo one; echo two)",
      "f() { echo one; echo two; }",
      "function deploy-prod { echo one; echo two; }",
      "log::info() { echo one; echo two; }",
      'select d in a b; do echo "$d"; break; done',
      "coproc worker { echo one; echo two; }",
      "coproc (echo one; echo two)",
      "[[ -f package.json && -f pnpm-lock.yaml ]] && pnpm test",
      "printf x | select d in a b; do break; done",
      "true & select d in a b; do break; done",
      "printf x |& select d in a b; do break; done",
      "function deploy-prod if true; then echo ok; fi",
      "function check [[ -n x ]]",
      "function bump (( n++ )) && pnpm test",
      "function sub() (echo one; echo two)",
      "function worker (echo one; echo two)",
      "function worker(echo one; echo two)",
      "plain() if true; then echo ok; fi",
      "time -p ! [[ -n x ]]",
      "time(echo one; echo two)",
      "function bump(( n++ )) && pnpm test",
      "time -- if true; then echo one; echo two; fi",
    ]) {
      expect(execDetail(command, "explain")).toBe(command);
    }

    for (const command of [
      "(( ready && enabled )) && pnpm test",
      "time (( ready || fallback )) && pnpm test",
      ["(\\", "( ready && enabled )) && pnpm test"].join("\n"),
      ["echo $\\", "(( ready && enabled )) && pnpm test"].join("\n"),
      "!(( n++ )) && pnpm test",
      "time -p -- (( n++ )) && pnpm test",
    ]) {
      const separatorIndex = command.lastIndexOf(" && ");
      expect(splitTopLevelStages(command)).toEqual([command.slice(0, separatorIndex), "pnpm test"]);
    }

    for (const command of [
      ["true && \\", "if true; then echo ok; fi"].join("\n"),
      ["printf x | \\", "select d in a b; do break; done"].join("\n"),
      ["true && \\\\", "if true; then echo ok; fi"].join("\n"),
    ]) {
      expect(splitTopLevelStages(command)).toEqual([command]);
    }

    for (const quoted of [
      "printf '%s' '; if ' && pnpm test",
      "printf '%s' $'can\\'t; if literal' && pnpm test",
      ["printf '%s' $\\", "'can\\'t; if literal' && pnpm test"].join("\n"),
    ]) {
      expect(execDetail(quoted, "explain")).toBe("print text → run tests");
    }

    for (const command of [
      "select-editor --version && pnpm test",
      "coprocess --version && pnpm test",
      "[[helper arg && pnpm test",
      '"x"select --version && pnpm test',
      "select'' --version && pnpm test",
      'selec"t" --version && pnpm test',
    ]) {
      expect(splitTopLevelStages(command)).toEqual([
        command.slice(0, command.lastIndexOf(" && ")),
        "pnpm test",
      ]);
    }

    for (const command of [
      "function f{ echo one; echo two; }",
      "function f {not-a-body; echo two; }",
      "printf x >& select",
      "printf x &> select",
      "printf x >| select",
    ]) {
      expect(hasShellCompoundCommand(command)).toBe(false);
    }
  });

  it("keeps normal search patterns concise", () => {
    for (const [command, expected] of [
      ['rg "foo|bar" src/agents', 'search "foo|bar" in src/agents'],
      ["rg 'search engine' src/agents", 'search "search engine" in src/agents'],
      ["rg 'search textual data' src/agents", 'search "search textual data" in src/agents'],
      ["rg 'research text in docs' src/agents", 'search "research text in docs" in src/agents'],
    ] as const) {
      expect(execDetail(command, "explain")).toBe(expected);
    }
  });

  it("sanitizes recursive search patterns inside pipelines", () => {
    expect(execDetail(`printf x | rg 'search "foo" in src' .`, "explain")).toBe(
      "print text -> search text in .",
    );
  });

  it.each<[name: string, command: string, expected: string]>([
    [
      "clears inferred cwd when popd is stripped from preamble",
      "pushd /tmp && popd && npm install",
      "install dependencies, `pushd /tmp && popd && npm install`",
    ],
    // both cd's are preamble; last path wins
    [
      "handles chained cd commands using last path",
      "cd /tmp && cd /app",
      "cd /tmp && cd /app (in /app)",
    ],
  ])("%s", (_name, command, expected) => {
    expect(execDetail(command)).toBe(expected);
  });

  it("uses compact workspace markers for common workspace paths", () => {
    for (const [command, workdir, expected] of [
      ["git fetch", "/Users/peter/mantis-workspace/openclaw", "fetch git changes (agent)"],
      ["git status", "/Users/peter/Projects/openclaw", "check git status (repo)"],
      [
        "command -v discrawl",
        "/root/.openclaw/sandboxes/agent-clawsweeper-sandbox-discor-766423d0",
        "command -v discrawl",
      ],
    ] as const) {
      expect(execDetail(command, "explain", workdir, "bash")).toBe(expected);
    }
  });

  it("omits bash and exec names from compact tool summaries", () => {
    const summary = (params: Parameters<typeof resolveToolDisplay>[0]) =>
      formatToolSummary(resolveToolDisplay(params));
    expect(
      summary({
        name: "Bash",
        args: { command: "git fetch", workdir: "/Users/peter/mantis-workspace/openclaw" },
        detailMode: "explain",
      }),
    ).toBe("fetch git changes (agent)");

    expect(summary({ name: "web_search", args: { query: "OpenClaw docs" } })).toBe(
      'Web Search: for "OpenClaw docs"',
    );
  });

  it("recognizes heredoc/inline script exec details", () => {
    for (const [command, expected] of [
      ["python3 <<PY\nprint('x')\nPY", "run python3 inline script (heredoc)"],
      ["node --check /tmp/test.js", "check js syntax for /tmp/test.js"],
      ["node -c /tmp/test.js", "check js syntax for /tmp/test.js"],
    ] as const) {
      expect(execDetail(command, undefined, "/Users/adityasingh/.openclaw/workspace")).toContain(
        expected,
      );
    }
  });

  it("matches shell-quoted heredoc terminators before keeping later stages", () => {
    const command = ["python3 <<\\PY", "print('body && not a command')", "PY", "npm test"].join(
      "\n",
    );
    expect(execDetail(command, "explain")).toBe("run python3 inline script (heredoc) → run tests");
  });

  it.each(["cat <<<true", "echo $((flags << true ))", "((flags << true ))"])(
    "does not treat %s as a heredoc",
    (firstLine) => {
      const command = [firstLine, "npm test && npm build", "true", "pnpm test"].join("\n");

      expect(splitTopLevelStages(command)).toEqual([
        [firstLine, "npm test"].join("\n"),
        ["npm build", "true", "pnpm test"].join("\n"),
      ]);

      expect(execDetail(command, "explain")).toContain("run build");
    },
  );

  it("ignores heredoc-looking tokens inside shell comments", () => {
    const command = [
      "export MODE=test # next block uses <<EOF && this is still a comment",
      "cat <<EOF",
      "body && data",
      "EOF",
      "npm test && npm build",
    ].join("\n");

    expect(execDetail(command, "explain")).toBe("show output → run tests → run build");

    expect(splitTopLevelStages("echo foo\\ #bar && npm test")).toEqual([
      "echo foo\\ #bar",
      "npm test",
    ]);
    expect(splitTopLevelStages("echo prefix$(printf suffix)#bar && npm test")).toEqual([
      "echo prefix$(printf suffix)#bar",
      "npm test",
    ]);

    const bodies: string[] = [];
    const scanBodies = (input: string) => {
      scanTopLevelChars(
        input,
        () => true,
        (_operatorIndex, start, end) => bodies.push(input.slice(start, end)),
      );
    };
    scanBodies(["(printf ok)# comment uses <<STOP", "npm test && npm build", "STOP"].join("\n"));
    scanBodies(["echo $(# comment uses <<STOP", "printf ok", ") && npm test"].join("\n"));
    expect(bodies).toEqual([]);

    for (const expansion of [
      "echo $(printf suffix)#tag",
      "echo <(printf suffix)#tag",
      "echo $(case x in x) printf ok;; esac)#tag",
    ]) {
      const withHeredoc = [expansion + " <<STOP", "body", "STOP"].join("\n");
      scanBodies(withHeredoc);
    }
    expect(bodies).toEqual(["body\nSTOP", "body\nSTOP", "body\nSTOP"]);
  });

  it("keeps heredoc body pipes out of top-level stage summaries", () => {
    const command = [
      "cat > .openclaw/tmp/farm-notices/ventura.txt <<-'EOF'",
      "\tBuenos dias equipo; se ajusta la orden A1251718:",
      "\tsc-carwhi(100) && sc-cardoc(100) || sc-carwhi(100)",
      "\tGracias.",
      "\tEOF",
      "./scripts/email_preview_new --to farm@example.com && ./scripts/email_preview_new --to farm2@example.com",
    ].join("\n");
    expect(execDetail(command, "explain")).toBe(
      "show output → run email_preview_new → run email_preview_new",
    );
  });

  it("consumes same-line heredocs in declaration order before splitting later stages", () => {
    const body = [
      "cat <<'FIRST' <<-\"SECOND\"",
      "first; body && body || body | body",
      "FIRST",
      "\tsecond; body && body || body | body",
      "\tSECOND",
    ].join("\n");
    expect(splitTopLevelStages(`${body}\nprintf done && npm test`)).toEqual([
      `${body}\nprintf done`,
      "npm test",
    ]);
  });
});

it("does not split a surrogate pair when the head boundary lands on an emoji", () => {
  // Default head ends at index 59, inside the emoji at UTF-16 indices 58–59.
  const emoji = String.fromCodePoint(0x1f600);
  const longCommand = `/opt/custom/bin/run ${"a".repeat(38)}${emoji}${"b".repeat(80)}`;
  const result = resolveExecDetail({ command: longCommand });

  expect(result).toBeDefined();
  expect(result).not.toContain(emoji);
  expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  expect(result).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  expect(result).toContain("/opt/custom/bin/run");
  expect(result).toContain("…");
  expect(result).toMatch(/b{4}$/);
});

it("preserves string details before compacting", () => {
  const longValue =
    "Deploying with AWS key AKIDABCDEFGHIJKLMNOP1234567890 and " + "x".repeat(200) + " final-step";
  const detail = detailFor("sessions_spawn", { label: longValue });

  expect(detail).toContain("AKIDABCDEFGHIJKLMNOP1234567890");
});
