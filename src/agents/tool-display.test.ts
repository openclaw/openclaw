/**
 * Regression coverage for compact tool display formatting.
 * Ensures tool names, actions, and details stay readable.
 */
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

function detailFor(params: Parameters<typeof resolveToolDisplay>[0]) {
  return formatToolDetail(resolveToolDisplay(params));
}

describe("isShellToolDisplayName", () => {
  it("matches shell tools whatever case the backend spells them in", () => {
    // The Claude CLI sends "Bash"; embedded runs send "bash"/"exec".
    for (const name of ["Bash", "bash", "BASH", "Exec", "exec", "shell"]) {
      expect(isShellToolDisplayName(name)).toBe(true);
    }
    for (const name of ["Read", "web_search", undefined, ""]) {
      expect(isShellToolDisplayName(name)).toBe(false);
    }
  });
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
      verb: "search",
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

  it("puts the camera PTZ operation before its node and device", () => {
    const detail = detailFor({
      name: "nodes",
      args: {
        action: "camera_ptz",
        ptzOperation: "status",
        node: "Mac",
        deviceId: "camera-id",
      },
    });

    expect(detail).toBe("ptz operation status, node Mac, device id camera-id");
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

  it("keeps positive numbers and true booleans", () => {
    const detail = detailFor({
      name: "sessions_history",
      args: {
        sessionKey: "agent:main:main",
        limit: 20,
        includeTools: true,
      },
    });

    expect(detail).toContain("session agent:main:main");
    expect(detail).toContain("limit 20");
    expect(detail).toContain("tools true");
  });

  it("formats read/write/edit with intent-first file detail", () => {
    const readDetail = detailFor({
      name: "read",
      args: { file_path: "/tmp/a.txt", offset: 2, limit: 2 },
    });
    const writeDetail = detailFor({
      name: "write",
      args: { file_path: "/tmp/a.txt", content: "abc" },
    });
    const editDetail = detailFor({
      name: "edit",
      args: { path: "/tmp/a.txt", newText: "abcd" },
    });

    expect(readDetail).toBe("lines 2-3 from /tmp/a.txt");
    expect(writeDetail).toBe("to /tmp/a.txt (3 chars)");
    expect(editDetail).toBe("in /tmp/a.txt (4 chars)");
  });

  it("formats web_search provider query shapes", () => {
    expect(
      detailFor({
        name: "web_search",
        args: { q: "Codex OAuth API key", max_results: 5 },
      }),
    ).toBe('for "Codex OAuth API key" (top 5)');

    expect(
      detailFor({
        name: "web_search",
        args: {
          search_query: [
            { q: "latest Kimi model" },
            { q: "latest Gemini model" },
            { q: "latest Claude model" },
            { q: "latest OpenAI model" },
          ],
        },
      }),
    ).toBe('for "latest Kimi model", "latest Gemini model", "latest Claude model"…');
  });

  it("formats Parallel's native objective + search_queries shape", () => {
    expect(
      detailFor({
        name: "web_search",
        args: {
          objective: "Find the OpenClaw repository on GitHub",
          search_queries: ["openclaw github", "openclaw repository"],
          count: 5,
        },
      }),
    ).toBe(
      'for "Find the OpenClaw repository on GitHub", "openclaw github", "openclaw repository" (top 5)',
    );
  });

  it("summarizes exec commands with context", () => {
    const detail = detailFor({
      name: "exec",
      args: {
        command:
          "set -euo pipefail\ngit -C /Users/adityasingh/.openclaw/workspace status --short | head -n 3",
        workdir: "/Users/adityasingh/.openclaw/workspace",
      },
    });

    expect(detail).toContain("check git status -> show first 3 lines");
    expect(detail).toContain("(agent)");
  });

  it("summarizes bash commands with the same command explainer", () => {
    const detail = detailFor({
      name: "bash",
      args: { command: "sed -n '1,80p' extensions/discord/src/draft-stream.ts" },
      detailMode: "explain",
    });

    expect(detail).toBe("print lines 1-80 from extensions/discord/src/draft-stream.ts");
  });

  it("keeps shell compound commands intact instead of inventing command stages", () => {
    const loop = 'for d in $(find . -type d); do echo "$d"; ls "$d"; done';
    const conditional = "echo start && if test -f package.json; then pnpm test; fi";
    const subshell = "(echo one; echo two)";
    const functionBody = "f() { echo one; echo two; }";
    const functionKeyword = "function f { echo one; echo two; }";
    const hyphenatedFunction = "function deploy-prod { echo one; echo two; }";
    const namespacedFunction = "function log::info { echo one; echo two; }";
    const selectLoop = 'select d in a b; do echo "$d"; break; done';
    const doubleBracket = "[[ -f package.json && -f pnpm-lock.yaml ]] && pnpm test";
    const pipedSelect = "printf x | select d in a b; do break; done";
    const pipedDoubleBracket = "printf x | [[ -n x ]]";
    const backgroundSelect = "true & select d in a b; do break; done";
    const stderrPipedSelect = "printf x |& select d in a b; do break; done";
    const pipedFunction = "printf x | function deploy-prod { echo one; echo two; }";
    const conditionalFunction = "function deploy-prod if true; then echo ok; fi";
    const doubleBracketFunction = "function check [[ -n x ]]";
    const arithmeticFunction = "function bump (( n++ )) && pnpm test";
    const subshellFunction = "function sub() (echo one; echo two)";
    const posixConditionalFunction = "plain() if true; then echo ok; fi";
    const negatedDoubleBracket = "! [[ -f a && -f b ]] && pnpm test";
    const timedNegatedDoubleBracket = "time -p ! [[ -n x ]]";
    const negatedTimedDoubleBracket = "! time [[ -n x ]]";
    const operatorTimedSubshell = "time(echo one; echo two)";
    const operatorArithmeticFunction = "function bump(( n++ )) && pnpm test";

    for (const command of [
      loop,
      conditional,
      subshell,
      functionBody,
      functionKeyword,
      hyphenatedFunction,
      namespacedFunction,
      "deploy-prod() { echo one; echo two; }",
      "log::info() { echo one; echo two; }",
      selectLoop,
      "coproc worker { echo one; echo two; }",
      "coproc (echo one; echo two)",
      doubleBracket,
      pipedSelect,
      pipedDoubleBracket,
      backgroundSelect,
      stderrPipedSelect,
      pipedFunction,
      conditionalFunction,
      doubleBracketFunction,
      arithmeticFunction,
      subshellFunction,
      "function worker (echo one; echo two)",
      "function worker(echo one; echo two)",
      posixConditionalFunction,
      negatedDoubleBracket,
      timedNegatedDoubleBracket,
      negatedTimedDoubleBracket,
      operatorTimedSubshell,
      operatorArithmeticFunction,
      "time -- if true; then echo one; echo two; fi",
    ]) {
      expect(splitTopLevelStages(command)).toEqual([command]);
      expect(detailFor({ name: "exec", args: { command }, detailMode: "explain" })).toBe(command);
    }

    for (const command of [
      "(( ready && enabled )) && pnpm test",
      "time (( ready || fallback )) && pnpm test",
      ["(\\", "( ready && enabled )) && pnpm test"].join("\n"),
      ["echo $\\", "(( ready && enabled )) && pnpm test"].join("\n"),
      "time(( n++ )) && pnpm test",
      "time -p(( n++ )) && pnpm test",
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
      "printf '%s' 'function f { echo; }' && pnpm test",
      "printf '%s' 'select d; do echo; done' && pnpm test",
      "printf '%s' '[[ a && b ]]' && pnpm test",
      "printf '%s' $'can\\'t; if literal' && pnpm test",
      ["printf '%s' $\\", "'can\\'t; if literal' && pnpm test"].join("\n"),
    ]) {
      expect(splitTopLevelStages(quoted)).toEqual([
        quoted.slice(0, quoted.lastIndexOf(" && ")),
        "pnpm test",
      ]);
      expect(detailFor({ name: "exec", args: { command: quoted }, detailMode: "explain" })).toBe(
        "print text → run tests",
      );
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
    ]) {
      expect(detailFor({ name: "exec", args: { command }, detailMode: "explain" })).toBe(expected);
    }
  });

  it("sanitizes recursive search patterns inside pipelines", () => {
    expect(
      detailFor({
        name: "exec",
        args: { command: `printf x | rg 'search "foo" in src' .` },
        detailMode: "explain",
      }),
    ).toBe("print text -> search text in .");
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
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "exec",
        args: { command },
      }),
    );

    expect(detail).toBe(expected);
  });

  it("uses compact workspace markers for common workspace paths", () => {
    expect(
      detailFor({
        name: "bash",
        args: { command: "git fetch", workdir: "/Users/peter/mantis-workspace/openclaw" },
        detailMode: "explain",
      }),
    ).toBe("fetch git changes (agent)");

    expect(
      detailFor({
        name: "bash",
        args: { command: "git status", workdir: "/Users/peter/Projects/openclaw" },
        detailMode: "explain",
      }),
    ).toBe("check git status (repo)");

    expect(
      detailFor({
        name: "bash",
        args: {
          command: "command -v discrawl",
          workdir: "/root/.openclaw/sandboxes/agent-clawsweeper-sandbox-discor-766423d0",
        },
        detailMode: "explain",
      }),
    ).toBe("command -v discrawl");
  });

  it("omits bash and exec names from compact tool summaries", () => {
    expect(
      formatToolSummary(
        resolveToolDisplay({
          name: "Bash",
          args: { command: "git fetch", workdir: "/Users/peter/mantis-workspace/openclaw" },
          detailMode: "explain",
        }),
      ),
    ).toBe("fetch git changes (agent)");

    expect(
      formatToolSummary(
        resolveToolDisplay({
          name: "web_search",
          args: { query: "OpenClaw docs" },
        }),
      ),
    ).toBe('Web Search: for "OpenClaw docs"');
  });

  it("recognizes heredoc/inline script exec details", () => {
    const pyDetail = detailFor({
      name: "exec",
      args: {
        command: "python3 <<PY\nprint('x')\nPY",
        workdir: "/Users/adityasingh/.openclaw/workspace",
      },
    });
    const nodeCheckDetail = detailFor({
      name: "exec",
      args: {
        command: "node --check /tmp/test.js",
        workdir: "/Users/adityasingh/.openclaw/workspace",
      },
    });
    const nodeShortCheckDetail = detailFor({
      name: "exec",
      args: {
        command: "node -c /tmp/test.js",
        workdir: "/Users/adityasingh/.openclaw/workspace",
      },
    });

    expect(pyDetail).toContain("run python3 inline script (heredoc)");
    expect(nodeCheckDetail).toContain("check js syntax for /tmp/test.js");
    expect(nodeShortCheckDetail).toContain("check js syntax for /tmp/test.js");
  });

  it("matches shell-quoted heredoc terminators before keeping later stages", () => {
    const detail = detailFor({
      name: "exec",
      args: {
        command: ["python3 <<\\PY", "print('body && not a command')", "PY", "npm test"].join("\n"),
      },
      detailMode: "explain",
    });

    expect(detail).toBe("run python3 inline script (heredoc) → run tests");
  });

  it("does not treat the overlapping end of a here-string as a heredoc", () => {
    const command = ["cat <<<true", "npm test && npm build", "true", "pnpm test"].join("\n");

    expect(splitTopLevelStages(command)).toEqual([
      ["cat <<<true", "npm test"].join("\n"),
      ["npm build", "true", "pnpm test"].join("\n"),
    ]);

    const detail = detailFor({ name: "exec", args: { command }, detailMode: "explain" });
    expect(detail).toContain("run build");
  });

  it("ignores heredoc-looking tokens inside shell comments", () => {
    const command = [
      "export MODE=test # next block uses <<EOF && this is still a comment",
      "cat <<EOF",
      "body && data",
      "EOF",
      "npm test && npm build",
    ].join("\n");

    const detail = detailFor({ name: "exec", args: { command }, detailMode: "explain" });
    expect(detail).toBe("show output → run tests → run build");

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

  it("does not treat arithmetic bitshifts as heredocs", () => {
    for (const firstLine of ["echo $((flags << true ))", "((flags << true ))"]) {
      const command = [firstLine, "npm test && npm build", "true", "pnpm test"].join("\n");

      expect(splitTopLevelStages(command)).toEqual([
        [firstLine, "npm test"].join("\n"),
        ["npm build", "true", "pnpm test"].join("\n"),
      ]);

      const detail = detailFor({ name: "exec", args: { command }, detailMode: "explain" });
      expect(detail).toContain("run build");
    }
  });

  it("keeps heredoc body pipes out of top-level stage summaries", () => {
    const detail = detailFor({
      name: "exec",
      args: {
        command: [
          "cat > .openclaw/tmp/farm-notices/ventura.txt <<-'EOF'",
          "\tBuenos dias equipo; se ajusta la orden A1251718:",
          "\tsc-carwhi(100) && sc-cardoc(100) || sc-carwhi(100)",
          "\tGracias.",
          "\tEOF",
          "./scripts/email_preview_new --to farm@example.com && ./scripts/email_preview_new --to farm2@example.com",
        ].join("\n"),
      },
      detailMode: "explain",
    });

    expect(detail).toBe("show output → run email_preview_new → run email_preview_new");
  });

  it("consumes same-line heredocs in declaration order before splitting later stages", () => {
    const stages = splitTopLevelStages(
      [
        "cat <<'FIRST' <<-\"SECOND\"",
        "first; body && body || body | body",
        "FIRST",
        "\tsecond; body && body || body | body",
        "\tSECOND",
        "printf done && npm test",
      ].join("\n"),
    );

    expect(stages).toEqual([
      [
        "cat <<'FIRST' <<-\"SECOND\"",
        "first; body && body || body | body",
        "FIRST",
        "\tsecond; body && body || body | body",
        "\tSECOND",
        "printf done",
      ].join("\n"),
      "npm test",
    ]);
  });
});

describe("compactRawCommand middle truncation", () => {
  it("does not split a surrogate pair when the head boundary lands on an emoji", () => {
    // The one-line form is 140 UTF-16 units. With the default maxLength=120 the head
    // slice ends at index 59, but the 😀 emoji (U+1F600, a surrogate pair) occupies
    // indices 58-59 — so a raw .slice(0, 59) would keep the high surrogate and drop
    // its low half, leaving a lone surrogate that renders as the replacement char.
    const emoji = String.fromCodePoint(0x1f600);
    // Unknown binary so resolveExecDetail returns the compact raw form directly.
    const longCommand = `/opt/custom/bin/run ${"a".repeat(38)}${emoji}${"b".repeat(80)}`;
    const result = resolveExecDetail({ command: longCommand });

    expect(result).toBeDefined();
    // The whole emoji is dropped at the boundary rather than half of it.
    expect(result).not.toContain(emoji);
    // No dangling/lone surrogate code units remain in the rendered detail.
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(result).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    // Start and end of the command are still preserved around the ellipsis.
    expect(result).toContain("/opt/custom/bin/run");
    expect(result).toContain("…");
    expect(result).toMatch(/b{4}$/);
  });
});

describe("coerceDisplayValue middle truncation", () => {
  it("preserves string details before compacting", () => {
    const longValue =
      "Deploying with AWS key AKIDABCDEFGHIJKLMNOP1234567890 and " +
      "x".repeat(200) +
      " final-step";
    const detail = detailFor({
      name: "sessions_spawn",
      args: { label: longValue },
    });

    expect(detail).toContain("AKIDABCDEFGHIJKLMNOP1234567890");
  });
});
