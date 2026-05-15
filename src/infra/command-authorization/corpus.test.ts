import { describe, expect, it } from "vitest";
import {
  createExecCommandAnalysisFromAuthorizationPlan,
  planCommandForAuthorization,
  renderAuthorizationShellCommand,
} from "./plan.js";

describe("command authorization planner corpus", () => {
  it("marks tokenized argv commands as reusable trust candidates", async () => {
    const plan = await planCommandForAuthorization({
      dialect: "argv",
      argv: ["git", "status", "--short"],
    });

    expect(plan.kind).toBe("analyzable");
    if (plan.kind !== "analyzable") {
      throw new Error(`expected analyzable plan, got ${plan.kind}`);
    }
    expect(plan.dialect).toBe("argv");
    expect(plan.tree).toEqual({ kind: "unit", unitId: "unit-0" });
    expect(plan.units).toEqual([
      expect.objectContaining({
        id: "unit-0",
        argv: ["git", "status", "--short"],
        relationship: "simple",
        allowlistEligible: true,
        allowAlwaysEligible: true,
        promptOnlyReasons: [],
        blockReasons: [],
      }),
    ]);
  });

  it("preserves empty arguments in tokenized argv commands", async () => {
    const plan = await planCommandForAuthorization({
      dialect: "argv",
      argv: ["printf", "%s", ""],
    });

    expect(plan.kind).toBe("analyzable");
    if (plan.kind !== "analyzable") {
      throw new Error(`expected analyzable plan, got ${plan.kind}`);
    }
    expect(plan.units).toEqual([
      expect.objectContaining({
        raw: "printf %s ",
        argv: ["printf", "%s", ""],
      }),
    ]);
  });

  it("marks simple POSIX commands as reusable trust candidates", async () => {
    const plan = await planCommandForAuthorization({
      dialect: "posix-shell",
      command: "ls /tmp",
    });

    expect(plan.kind).toBe("analyzable");
    if (plan.kind !== "analyzable") {
      throw new Error(`expected analyzable plan, got ${plan.kind}`);
    }
    expect(plan.dialect).toBe("posix-shell");
    expect(plan.tree).toEqual({ kind: "unit", unitId: "unit-0" });
    expect(plan.units[0]).toEqual(
      expect.objectContaining({
        raw: "ls /tmp",
        argv: ["ls", "/tmp"],
        relationship: "simple",
        allowlistEligible: true,
        allowAlwaysEligible: true,
      }),
    );
  });

  it("preserves simple POSIX pipelines as reusable command trees", async () => {
    const plan = await planCommandForAuthorization({
      dialect: "posix-shell",
      command: "ls /tmp | grep log",
    });

    expect(plan.kind).toBe("analyzable");
    if (plan.kind !== "analyzable") {
      throw new Error(`expected analyzable plan, got ${plan.kind}`);
    }
    expect(plan.tree).toEqual({
      kind: "pipeline",
      children: [
        { kind: "unit", unitId: "unit-0" },
        { kind: "unit", unitId: "unit-1" },
      ],
    });
    expect(plan.units.map((unit) => unit.argv)).toEqual([
      ["ls", "/tmp"],
      ["grep", "log"],
    ]);
    expect(plan.units.every((unit) => unit.relationship === "pipeline")).toBe(true);
    expect(plan.units.every((unit) => unit.allowAlwaysEligible)).toBe(true);
  });

  it.each(["grep needle missing-file |& cat", "! grep needle file && echo missing"])(
    "makes unsupported pipeline modifiers prompt-only: %s",
    async (command) => {
      const plan = await planCommandForAuthorization({
        dialect: "posix-shell",
        command,
      });

      expect(plan.kind).toBe("prompt-only");
      if (plan.kind !== "prompt-only") {
        throw new Error(`expected prompt-only plan, got ${plan.kind}`);
      }
      expect(plan.promptOnlyReasons).toContain("unsupported-shell-syntax");
      expect(plan.units.every((unit) => !unit.allowlistEligible)).toBe(true);
      expect(plan.units.every((unit) => !unit.allowAlwaysEligible)).toBe(true);
    },
  );

  it.each([
    "true # ||\necho after",
    "false # &&\necho after",
    "printf a # |\nwc -c",
    "echo one # ;\necho two",
  ])("makes shell comments between commands prompt-only: %s", async (command) => {
    const plan = await planCommandForAuthorization({
      dialect: "posix-shell",
      command,
    });

    expect(plan.kind).toBe("prompt-only");
    if (plan.kind !== "prompt-only") {
      throw new Error(`expected prompt-only plan, got ${plan.kind}`);
    }
    expect(plan.promptOnlyReasons).toContain("unsupported-shell-syntax");
    expect(plan.units.every((unit) => !unit.allowlistEligible)).toBe(true);
    expect(plan.units.every((unit) => !unit.allowAlwaysEligible)).toBe(true);
  });

  it("renders enforced POSIX commands from the planner tree", async () => {
    const plan = await planCommandForAuthorization({
      dialect: "posix-shell",
      command: "env printf hi | wc -c",
    });
    const analysis = createExecCommandAnalysisFromAuthorizationPlan({ plan });
    expect(analysis?.ok).toBe(true);
    if (!analysis) {
      throw new Error("expected command analysis");
    }

    const rendered = renderAuthorizationShellCommand({
      plan,
      segments: analysis.segments,
      mode: "enforced",
    });

    expect(rendered.ok).toBe(true);
    expect(rendered.command).toMatch(/'(?:[^']*\/)?printf' 'hi' \| '(?:[^']*\/)?wc' '-c'/);
    expect(rendered.command).not.toContain("'env'");
  });

  it("renders only safe-bin POSIX segments literally from the planner tree", async () => {
    const plan = await planCommandForAuthorization({
      dialect: "posix-shell",
      command: "rg foo src/*.ts | head -n 5 && echo ok",
    });
    const analysis = createExecCommandAnalysisFromAuthorizationPlan({ plan });
    expect(analysis?.ok).toBe(true);
    if (!analysis) {
      throw new Error("expected command analysis");
    }

    const rendered = renderAuthorizationShellCommand({
      plan,
      segments: analysis.segments,
      segmentSatisfiedBy: [null, "safeBins", null],
      mode: "safe-bins",
    });

    expect(rendered.ok).toBe(true);
    expect(rendered.command).toContain("rg foo src/*.ts");
    expect(rendered.command).toMatch(/'(?:[^']*\/)?head' '-n' '5'/);
  });

  it("fails closed when planner render segment metadata does not match", async () => {
    const plan = await planCommandForAuthorization({
      dialect: "posix-shell",
      command: "echo ok",
    });
    const analysis = createExecCommandAnalysisFromAuthorizationPlan({ plan });
    expect(analysis?.ok).toBe(true);
    if (!analysis) {
      throw new Error("expected command analysis");
    }

    expect(
      renderAuthorizationShellCommand({
        plan,
        segments: analysis.segments,
        segmentSatisfiedBy: [],
        mode: "safe-bins",
      }),
    ).toEqual({ ok: false, reason: "segment metadata mismatch" });
  });

  it.each([
    {
      name: "and conditionals",
      command: "pnpm test && pnpm build",
      operators: ["&&"],
      relationships: ["simple", "and-conditional"],
    },
    {
      name: "or conditionals",
      command: "test -f package.json || echo missing",
      operators: ["||"],
      relationships: ["simple", "or-conditional"],
    },
    {
      name: "sequences",
      command: "echo one; echo two",
      operators: [";"],
      relationships: ["simple", "sequence"],
    },
  ])("preserves POSIX $name tree shape", async ({ command, operators, relationships }) => {
    const plan = await planCommandForAuthorization({
      dialect: "posix-shell",
      command,
    });

    expect(plan.kind).toBe("analyzable");
    if (plan.kind !== "analyzable") {
      throw new Error(`expected analyzable plan, got ${plan.kind}`);
    }
    expect(plan.tree).toEqual({
      kind: "chain",
      operators,
      children: [
        { kind: "unit", unitId: "unit-0" },
        { kind: "unit", unitId: "unit-1" },
      ],
    });
    expect(plan.units.map((unit) => unit.relationship)).toEqual(relationships);
    expect(plan.units.every((unit) => unit.allowlistEligible)).toBe(true);
    expect(plan.units.every((unit) => unit.allowAlwaysEligible)).toBe(true);
  });

  it("plans POSIX shell wrapper payloads as reusable trust candidates", async () => {
    const plan = await planCommandForAuthorization({
      dialect: "posix-shell",
      command: 'sh -c "echo wrapped"',
    });

    expect(plan.kind).toBe("analyzable");
    if (plan.kind !== "analyzable") {
      throw new Error(`expected analyzable plan, got ${plan.kind}`);
    }
    expect(plan.tree).toEqual({ kind: "unit", unitId: "unit-0" });
    expect(plan.units).toEqual([
      expect.objectContaining({
        id: "unit-0",
        raw: "echo wrapped",
        argv: ["echo", "wrapped"],
        relationship: "wrapper-inline",
        allowlistEligible: true,
        allowAlwaysEligible: true,
        promptOnlyReasons: [],
        blockReasons: [],
      }),
    ]);
  });

  it("plans dispatch-wrapped POSIX shell payloads as reusable trust candidates", async () => {
    const plan = await planCommandForAuthorization({
      dialect: "posix-shell",
      command: "/usr/bin/nice /bin/zsh -c whoami",
    });

    expect(plan.kind).toBe("analyzable");
    if (plan.kind !== "analyzable") {
      throw new Error(`expected analyzable plan, got ${plan.kind}`);
    }
    expect(plan.units).toEqual([
      expect.objectContaining({
        raw: "whoami",
        argv: ["whoami"],
        relationship: "wrapper-inline",
        allowlistEligible: true,
        allowAlwaysEligible: true,
        promptOnlyReasons: [],
      }),
    ]);
  });

  it("makes shell wrapper payloads with evaluated outer arguments prompt-only", async () => {
    for (const command of ["sh -c 'echo safe' $(id)", `sh -c '$0 "$@"' tool $(id)`]) {
      const plan = await planCommandForAuthorization({
        dialect: "posix-shell",
        command,
      });

      expect(plan.kind).toBe("prompt-only");
      if (plan.kind !== "prompt-only") {
        throw new Error(`expected prompt-only plan for ${command}, got ${plan.kind}`);
      }
      expect(plan.promptOnlyReasons).toContain("command-substitution");
      expect(plan.units).toEqual([
        expect.objectContaining({
          allowlistEligible: false,
          allowAlwaysEligible: false,
          promptOnlyReasons: expect.arrayContaining(["command-substitution"]),
        }),
      ]);
    }
  });

  it.each([`sh -c 'echo "$HOME"'`, `sh -c 'echo "$1"' sh ignored dynamic`])(
    "makes dynamic shell wrapper payload arguments prompt-only: %s",
    async (command) => {
      const plan = await planCommandForAuthorization({
        dialect: "posix-shell",
        command,
      });

      expect(plan.kind).toBe("prompt-only");
      if (plan.kind !== "prompt-only") {
        throw new Error(`expected prompt-only plan for ${command}, got ${plan.kind}`);
      }
      expect(plan.promptOnlyReasons).toContain("unsupported-shell-syntax");
      expect(plan.units.every((unit) => !unit.allowlistEligible && !unit.allowAlwaysEligible)).toBe(
        true,
      );
      expect(plan.units).toEqual([
        expect.objectContaining({
          raw: command,
          relationship: "simple",
          promptOnlyReasons: expect.arrayContaining(["unsupported-shell-syntax"]),
        }),
      ]);
    },
  );

  it.each([
    {
      command: `pwsh -Command "Write-Output hi"`,
      reason: "unsupported-powershell-wrapper",
    },
    {
      command: "cmd /c dir",
      reason: "unsupported-cmd-wrapper",
    },
    {
      command: `sh -c 'pwsh -Command "Write-Output hi"'`,
      reason: "unsupported-powershell-wrapper",
    },
  ] as const)(
    "makes unsupported shell wrapper text prompt-only: $command",
    async ({ command, reason }) => {
      const plan = await planCommandForAuthorization({
        dialect: "posix-shell",
        command,
      });

      expect(plan.kind).toBe("prompt-only");
      if (plan.kind !== "prompt-only") {
        throw new Error(`expected prompt-only plan for ${command}, got ${plan.kind}`);
      }
      expect(plan.promptOnlyReasons).toContain(reason);
      expect(plan.units.every((unit) => !unit.allowlistEligible && !unit.allowAlwaysEligible)).toBe(
        true,
      );
    },
  );

  it("plans absolute-path POSIX shell wrapper payloads as reusable trust candidates", async () => {
    const plan = await planCommandForAuthorization({
      dialect: "posix-shell",
      command: "/bin/sh -c '/usr/bin/printf wrapped'",
    });

    expect(plan.kind).toBe("analyzable");
    if (plan.kind !== "analyzable") {
      throw new Error(`expected analyzable plan, got ${plan.kind}`);
    }
    expect(plan.tree).toEqual({ kind: "unit", unitId: "unit-0" });
    expect(plan.units).toEqual([
      expect.objectContaining({
        id: "unit-0",
        raw: "/usr/bin/printf wrapped",
        argv: ["/usr/bin/printf", "wrapped"],
        relationship: "wrapper-inline",
        allowlistEligible: true,
        allowAlwaysEligible: true,
        promptOnlyReasons: [],
        blockReasons: [],
      }),
    ]);
  });

  it.each(["/bin/sh -e -c 'false; rm marker'", "/bin/sh -o pipefail -c 'false; rm marker'"])(
    "preserves semantic shell options instead of planning payload units: %s",
    async (command) => {
      const plan = await planCommandForAuthorization({
        dialect: "posix-shell",
        command,
      });

      expect(plan.kind).toBe("analyzable");
      if (plan.kind !== "analyzable") {
        throw new Error(`expected analyzable plan, got ${plan.kind}`);
      }
      expect(plan.units).toEqual([
        expect.objectContaining({
          raw: command,
          relationship: "simple",
          argv: expect.arrayContaining(["-c", "false; rm marker"]),
          promptOnlyReasons: [],
        }),
      ]);
    },
  );

  it.each(["sh -c './tool'", "sh -c 'true; ./tool'", "sh -c 'env ./tool'"])(
    "makes relative shell wrapper payload executables prompt-only: %s",
    async (command) => {
      const plan = await planCommandForAuthorization({
        dialect: "posix-shell",
        command,
      });

      expect(plan.kind).toBe("prompt-only");
      if (plan.kind !== "prompt-only") {
        throw new Error(`expected prompt-only plan, got ${plan.kind}`);
      }
      expect(plan.promptOnlyReasons).toContain("unsupported-shell-syntax");
      expect(plan.units.every((unit) => !unit.allowAlwaysEligible)).toBe(true);
    },
  );

  it("keeps surrounding POSIX chain commands when planning shell wrapper payloads", async () => {
    const plan = await planCommandForAuthorization({
      dialect: "posix-shell",
      command: "git status && sh -c 'npm test'",
    });

    expect(plan.kind).toBe("analyzable");
    if (plan.kind !== "analyzable") {
      throw new Error(`expected analyzable plan, got ${plan.kind}`);
    }
    expect(plan.tree).toEqual({
      kind: "chain",
      operators: ["&&"],
      children: [
        { kind: "unit", unitId: "unit-0" },
        { kind: "unit", unitId: "unit-1" },
      ],
    });
    expect(plan.units).toEqual([
      expect.objectContaining({
        id: "unit-0",
        raw: "git status",
        argv: ["git", "status"],
        relationship: "simple",
        allowAlwaysEligible: true,
      }),
      expect.objectContaining({
        id: "unit-1",
        raw: "npm test",
        argv: ["npm", "test"],
        relationship: "and-conditional",
        allowAlwaysEligible: true,
      }),
    ]);
  });

  it.each([
    "false && sh -c 'echo inner || touch marker' && echo outer",
    "true || sh -c 'echo inner && touch marker'",
    "printf x | sh -c 'cmd1 || cmd2' && cmd3",
  ])("makes mixed outer chains with inner wrapper chains prompt-only: %s", async (command) => {
    const plan = await planCommandForAuthorization({
      dialect: "posix-shell",
      command,
    });

    expect(plan.kind).toBe("prompt-only");
    if (plan.kind !== "prompt-only") {
      throw new Error(`expected prompt-only plan, got ${plan.kind}`);
    }
    expect(plan.promptOnlyReasons).toContain("unsupported-shell-syntax");
    expect(plan.units.every((unit) => !unit.allowAlwaysEligible)).toBe(true);
  });

  it("makes interpreter inline eval prompt-only instead of reusable trust", async () => {
    const plan = await planCommandForAuthorization({
      dialect: "posix-shell",
      command: "python -c 'print(\"hi\")'",
    });

    expect(plan.kind).toBe("prompt-only");
    if (plan.kind !== "prompt-only") {
      throw new Error(`expected prompt-only plan, got ${plan.kind}`);
    }
    expect(plan.promptOnlyReasons).toEqual(["interpreter-inline-eval"]);
    expect(plan.units).toEqual([
      expect.objectContaining({
        argv: ["python", "-c", 'print("hi")'],
        allowlistEligible: false,
        allowAlwaysEligible: false,
        promptOnlyReasons: ["interpreter-inline-eval"],
      }),
    ]);
  });

  it("makes shell line continuation prompt-only instead of reusable trust", async () => {
    const plan = await planCommandForAuthorization({
      dialect: "posix-shell",
      command: "pnpm test \\\n --filter foo",
    });

    expect(plan.kind).toBe("prompt-only");
    if (plan.kind !== "prompt-only") {
      throw new Error(`expected prompt-only plan, got ${plan.kind}`);
    }
    expect(plan.promptOnlyReasons).toContain("unsupported-shell-syntax");
    expect(plan.units.every((unit) => !unit.allowAlwaysEligible)).toBe(true);
  });

  it.each([
    "if false; then git clean -fdx; else echo ok; fi",
    'for file in *.ts; do echo "$file"; done',
    "while true; do echo loop; break; done",
    'case "$x" in a) echo a ;; *) echo other ;; esac',
    "(cd /tmp; echo ok)",
    "{ echo one; echo two; }",
    "echo a & echo b",
  ])("makes unsupported compound shell syntax prompt-only: %s", async (command) => {
    const plan = await planCommandForAuthorization({
      dialect: "posix-shell",
      command,
    });

    expect(plan.kind).toBe("prompt-only");
    if (plan.kind !== "prompt-only") {
      throw new Error(`expected prompt-only plan, got ${plan.kind}`);
    }
    expect(plan.promptOnlyReasons).toContain("unsupported-shell-syntax");
    expect(plan.units.every((unit) => !unit.allowAlwaysEligible)).toBe(true);
  });

  it.each(["printf x > out.txt", "cat <<EOF\nhello\nEOF", "cat <<< hello"])(
    "makes redirection shell syntax prompt-only: %s",
    async (command) => {
      const plan = await planCommandForAuthorization({
        dialect: "posix-shell",
        command,
      });

      expect(plan.kind).toBe("prompt-only");
      if (plan.kind !== "prompt-only") {
        throw new Error(`expected prompt-only plan, got ${plan.kind}`);
      }
      expect(plan.promptOnlyReasons).toContain("unsupported-shell-syntax");
      expect(plan.units.every((unit) => !unit.allowAlwaysEligible)).toBe(true);
    },
  );

  it.each([
    "PATH=/tmp/evil:$PATH ls",
    "ls() { id > /tmp/pwned; }; ls /tmp",
    "alias ls='id > /tmp/pwned'; ls",
    ". ./profile; ls",
    "source ./profile; ls",
    "eval ls",
    "BASH_ENV=/tmp/payload bash -c 'echo ok'",
    "env BASH_ENV=/tmp/payload bash -c 'echo ok'",
    "cd /tmp; ./tool",
    "command cd /tmp; ./tool",
    "export BASH_ENV=/tmp/payload; bash -c 'echo ok'",
    "declare -x NODE_OPTIONS=--require=/tmp/payload.js; node safe.js",
    "readonly -x NODE_OPTIONS=--require=/tmp/payload.js; node safe.js",
    "typeset -x NODE_OPTIONS=--require=/tmp/payload.js; node safe.js",
    "unset PATH; ls",
    "set -a; SECRET=value; ./tool",
    "hash -p /tmp/evil ls; ls",
    "trap 'id > /tmp/pwned' EXIT; echo ok",
    "umask 000; touch file",
    "builtin umask 000; touch file",
    "ulimit -f 1; ./tool",
  ])("makes shell state mutation prompt-only: %s", async (command) => {
    const plan = await planCommandForAuthorization({
      dialect: "posix-shell",
      command,
    });

    expect(plan.kind).toBe("prompt-only");
    if (plan.kind !== "prompt-only") {
      throw new Error(`expected prompt-only plan, got ${plan.kind}`);
    }
    expect(plan.promptOnlyReasons).toContain("unsupported-shell-syntax");
    expect(plan.units.every((unit) => !unit.allowAlwaysEligible)).toBe(true);
  });

  it("makes command substitution prompt-only and flags dynamic executables", async () => {
    const plan = await planCommandForAuthorization({
      dialect: "posix-shell",
      command: "$(whoami) --help",
    });

    expect(plan.kind).toBe("prompt-only");
    if (plan.kind !== "prompt-only") {
      throw new Error(`expected prompt-only plan, got ${plan.kind}`);
    }
    expect(plan.promptOnlyReasons).toEqual(["command-substitution", "dynamic-executable"]);
    expect(plan.units[0]).toEqual(
      expect.objectContaining({
        argv: [],
        allowlistEligible: false,
        allowAlwaysEligible: false,
        promptOnlyReasons: ["command-substitution", "dynamic-executable"],
      }),
    );
  });

  it("marks malformed shell as unanalyzable", async () => {
    const plan = await planCommandForAuthorization({
      dialect: "posix-shell",
      command: "echo 'unterminated",
    });

    expect(plan).toEqual({
      kind: "unanalyzable",
      source: "echo 'unterminated",
      dialect: "posix-shell",
      reasons: ["malformed-shell"],
    });
  });

  it.each([
    {
      dialect: "powershell" as const,
      command: 'pwsh -Command "Get-ChildItem"',
      reason: "unsupported-powershell-wrapper",
    },
    {
      dialect: "windows-cmd" as const,
      command: "cmd /c dir",
      reason: "unsupported-cmd-wrapper",
    },
  ])("keeps $dialect commands prompt-only", async ({ dialect, command, reason }) => {
    const plan = await planCommandForAuthorization({ dialect, command });

    expect(plan.kind).toBe("prompt-only");
    if (plan.kind !== "prompt-only") {
      throw new Error(`expected prompt-only plan, got ${plan.kind}`);
    }
    expect(plan.dialect).toBe(dialect);
    expect(plan.promptOnlyReasons).toEqual([reason]);
    expect(plan.units[0]).toEqual(
      expect.objectContaining({
        relationship: "wrapper-inline",
        allowlistEligible: false,
        allowAlwaysEligible: false,
        promptOnlyReasons: [reason],
      }),
    );
  });
});
