import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderAuthorizationShellCommand } from "./command-authorization/index.js";
import {
  evaluateExecAllowlist,
  evaluateShellAllowlist,
  normalizeSafeBins,
} from "./exec-approvals-allowlist.js";
import {
  analyzeArgvCommand,
  analyzeShellCommand,
  buildEnforcedShellCommand,
  resolvePlannedSegmentArgv,
  windowsEscapeArg,
} from "./exec-approvals-analysis.js";
import { makePathEnv, makeTempDir } from "./exec-approvals-test-helpers.js";
import type { ExecAllowlistEntry } from "./exec-approvals.js";
import { matchAllowlist } from "./exec-command-resolution.js";
import { buildTrustedSafeBinDirs } from "./exec-safe-bin-trust.js";

function createSkillPreludeFixture(options: { withWrapper?: boolean } = {}) {
  const skillRoot = makeTempDir();
  const skillDir = path.join(skillRoot, "skills", "gog");
  const skillPath = path.join(skillDir, "SKILL.md");
  const wrapperPath = path.join(skillRoot, "bin", "gog-wrapper");

  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(skillPath, "# gog\n");

  if (options.withWrapper) {
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.writeFileSync(wrapperPath, "#!/bin/sh\n", { mode: 0o755 });
  }

  return { skillRoot, skillPath, wrapperPath };
}

describe("exec approvals shell analysis", () => {
  describe("planned argv", () => {
    it("keeps shell multiplexer rebuilds as coherent execution argv", () => {
      if (process.platform === "win32") {
        return;
      }
      const dir = makeTempDir();
      const busybox = path.join(dir, "busybox");
      fs.writeFileSync(busybox, "");
      fs.chmodSync(busybox, 0o755);

      const analysis = analyzeArgvCommand({
        argv: [busybox, "sh", "-lc", "echo hi"],
        cwd: dir,
        env: { PATH: `/bin:/usr/bin${path.delimiter}${process.env.PATH ?? ""}` },
      });
      expect(analysis.ok).toBe(true);
      const segment = analysis.segments[0];
      if (!segment) {
        throw new Error("expected first segment");
      }

      const planned = resolvePlannedSegmentArgv(segment);
      expect(planned).toEqual([
        segment.resolution?.execution.resolvedRealPath ??
          segment.resolution?.execution.resolvedPath,
        "-lc",
        "echo hi",
      ]);
      expect(planned?.[0]).not.toBe(busybox);
    });
  });

  describe("shell parsing", () => {
    it("parses argv commands", () => {
      const res = analyzeArgvCommand({ argv: ["/bin/echo", "ok"] });
      expect(res.ok).toBe(true);
      expect(res.segments[0]?.argv).toEqual(["/bin/echo", "ok"]);
    });

    it("rejects empty argv commands", () => {
      expect(analyzeArgvCommand({ argv: ["", "   "] })).toEqual({
        ok: false,
        reason: "empty argv",
        segments: [],
      });
    });

    it("rejects unsupported Windows shell constructs", () => {
      const res = analyzeShellCommand({
        command: "ping 127.0.0.1 -n 1 & whoami",
        platform: "win32",
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("unsupported windows shell token: &");
    });

    it("accepts shell metacharacters inside double-quoted arguments on Windows", () => {
      const cases = [
        // parentheses in a date/title argument
        'node add_lifelog.js "2026-03-28" "2026-03-28 (土) - LifeLog" --markdown',
        // pipe, redirection, ampersand inside quotes
        'node tool.js "--filter=a|b" "--label=x>y" "--name=foo & bar"',
        // caret inside quotes
        'node tool.js "--pattern=a^b"',
        // exclamation inside quotes
        'node tool.js "--msg=Hello!"',
      ];
      for (const command of cases) {
        const res = analyzeShellCommand({ command, platform: "win32" });
        expect(res.ok).toBe(true);
        expect(res.segments[0]?.argv[0]).toBe("node");
      }
    });

    it("still rejects unquoted metacharacters on Windows", () => {
      const cases = [
        "ping 127.0.0.1 -n 1 & whoami",
        "node allowed.js; unlisted.exe",
        "echo hello | clip",
        "node tool.js > output.txt",
        "for /f %i in (file.txt) do echo %i",
      ];
      for (const command of cases) {
        const res = analyzeShellCommand({ command, platform: "win32" });
        expect(res.ok).toBe(false);
      }
    });

    it("still rejects % inside double quotes on Windows", () => {
      const res = analyzeShellCommand({
        command: 'node tool.js "--user=%USERNAME%"',
        platform: "win32",
      });
      expect(res.ok).toBe(false);
    });

    it("rejects PowerShell $ expansions in Windows commands", () => {
      // $ followed by identifier-start, { or ( is always unsafe — PowerShell
      // expands these even inside double-quoted strings, matching windowsEscapeArg.
      const cases = [
        'node app.js "$env:USERPROFILE"',
        "node app.js ${var}",
        "node app.js $(whoami)",
      ];
      for (const command of cases) {
        const res = analyzeShellCommand({ command, platform: "win32" });
        expect(res.ok).toBe(false);
      }
    });

    it("rejects $? and $$ (PowerShell automatic variables) in Windows commands", () => {
      // $? (last exit status) and $$ (PID) are expanded by PowerShell inside
      // double-quoted strings and must be blocked to prevent unexpected expansion.
      const cases = ['node app.js "$?"', 'node app.js "$$"', "node app.js $?", "node app.js $$"];
      for (const command of cases) {
        const res = analyzeShellCommand({ command, platform: "win32" });
        expect(res.ok).toBe(false);
      }
    });

    it("allows bare $ not followed by identifier on Windows (e.g. UNC paths)", () => {
      const res = analyzeShellCommand({
        command: 'net use "\\\\host\\C$"',
        platform: "win32",
      });
      expect(res.ok).toBe(true);
    });

    it("rejects metacharacters inside single-quoted arguments on Windows", () => {
      // Single quotes are NOT quoting characters in cmd.exe (the Windows execution
      // shell).  Shell metacharacters inside single quotes remain active and unsafe.
      const cases = [
        "node tool.js '--name=foo & bar'",
        "node tool.js '--filter=a|b'",
        "node tool.js '--msg=Hello!'",
        "node tool.js '--pattern=(x)'",
      ];
      for (const command of cases) {
        const res = analyzeShellCommand({ command, platform: "win32" });
        expect(res.ok).toBe(false);
      }
    });

    it("rejects % in single-quoted arguments on Windows", () => {
      // Single quotes are literal in cmd.exe, so % is treated as unquoted and
      // can be used for variable-expansion injection.
      const res = analyzeShellCommand({
        command: "node tool.js '--label=%USERNAME%'",
        platform: "win32",
      });
      expect(res.ok).toBe(false);
    });

    it("tokenizer strips single quotes and treats content as one token on Windows", () => {
      // tokenizeWindowsSegment recognises PowerShell single-quote quoting so that
      // 'hello world' is correctly parsed as a single argument during enforcement.
      const res = analyzeShellCommand({
        command: "node tool.js 'hello world'",
        platform: "win32",
      });
      expect(res.ok).toBe(true);
      expect(res.segments[0]?.argv).toEqual(["node", "tool.js", "hello world"]);
    });

    it("parses '' as escaped apostrophe in Windows single-quoted args", () => {
      const res = analyzeShellCommand({
        command: "node tool.js 'O''Brien'",
        platform: "win32",
      });
      expect(res.ok).toBe(true);
      expect(res.segments[0]?.argv).toEqual(["node", "tool.js", "O'Brien"]);
    });

    it("preserves empty double-quoted args on Windows", () => {
      // tokenizeWindowsSegment must not drop "" — empty quoted args are intentional
      // (e.g. node tool.js "" passes an explicit empty string to the child process).
      const res = analyzeShellCommand({
        command: 'node tool.js ""',
        platform: "win32",
      });
      expect(res.ok).toBe(true);
      expect(res.segments[0]?.argv).toEqual(["node", "tool.js", ""]);
    });

    it("preserves empty single-quoted args on Windows", () => {
      const res = analyzeShellCommand({
        command: "node tool.js ''",
        platform: "win32",
      });
      expect(res.ok).toBe(true);
      expect(res.segments[0]?.argv).toEqual(["node", "tool.js", ""]);
    });

    it("parses windows quoted executables", () => {
      const res = analyzeShellCommand({
        command: '"C:\\Program Files\\Tool\\tool.exe" --version',
        platform: "win32",
      });
      expect(res.ok).toBe(true);
      expect(res.segments[0]?.argv).toEqual(["C:\\Program Files\\Tool\\tool.exe", "--version"]);
    });

    it('unescapes "" inside powershell -Command double-quoted payload', () => {
      // powershell -Command "node a.js ""hello world""" uses "" to encode a
      // literal " inside the outer double-quoted shell argument.  After stripping
      // the wrapper the payload must be unescaped so the tokenizer sees the
      // correct double-quote boundaries.
      const res = analyzeShellCommand({
        command: 'powershell -Command "node a.js ""hello world"""',
        platform: "win32",
      });
      expect(res.ok).toBe(true);
      expect(res.segments[0]?.argv).toEqual(["node", "a.js", "hello world"]);
    });

    it("unescapes '' inside powershell -Command single-quoted payload", () => {
      // In a PowerShell single-quoted string '' encodes a literal apostrophe.
      // 'node a.js ''hello world''' has outer ' delimiters and '' acts as
      // the escape for the space-containing argument — after unescaping the
      // payload becomes "node a.js 'hello world'" which the tokenizer parses
      // as a single argv token.
      const res = analyzeShellCommand({
        command: "powershell -Command 'node a.js ''hello world'''",
        platform: "win32",
      });
      expect(res.ok).toBe(true);
      expect(res.segments[0]?.argv).toEqual(["node", "a.js", "hello world"]);
    });

    it("unwraps powershell -Command with value-taking flags", () => {
      const cases = [
        'powershell -NoProfile -ExecutionPolicy Bypass -Command "node a.js"',
        'powershell -NonInteractive -ExecutionPolicy RemoteSigned -Command "node a.js"',
        'pwsh -NoLogo -WindowStyle Hidden -Command "node a.js"',
        // single-quoted payload
        "powershell -NoProfile -Command 'node a.js'",
        "pwsh -ExecutionPolicy Bypass -Command 'node a.js'",
      ];
      for (const command of cases) {
        const res = analyzeShellCommand({ command, platform: "win32" });
        expect(res.ok).toBe(true);
        expect(res.segments[0]?.argv[0]).toBe("node");
      }
    });

    it("unwraps powershell -Command when a flag value contains spaces (quoted)", () => {
      // psFlags previously used \S+ for flag values, which cannot match
      // quoted values containing spaces such as "C:\Users\Jane Doe\proj".
      // The wrapper was therefore not stripped, leaving powershell as the
      // executable and breaking allow-always matching for the inner command.
      const cases = [
        'powershell -WorkingDirectory "C:\\Users\\Jane Doe\\proj" -Command "node a.js"',
        "powershell -WorkingDirectory 'C:\\Users\\Jane Doe\\proj' -Command \"node a.js\"",
        'pwsh -ExecutionPolicy Bypass -WorkingDirectory "C:\\My Projects\\app" -Command "node a.js"',
      ];
      for (const command of cases) {
        const res = analyzeShellCommand({ command, platform: "win32" });
        expect(res.ok).toBe(true);
        expect(res.segments[0]?.argv[0]).toBe("node");
      }
    });

    it("unwraps powershell -c alias and --command alias", () => {
      // stripWindowsShellWrapperOnce previously only matched -Command, so
      // `pwsh -c "inner"` was left as-is.  The allow-always path persists the
      // inner executable via extractShellWrapperInlineCommand (which treats -c
      // as a command flag), but later evaluations would see `pwsh` as the
      // executable, causing repeated approval prompts for the same command.
      const cases = [
        ['pwsh -c "node a.js"', "node"],
        ['pwsh -NoLogo -c "node a.js"', "node"],
        ['powershell -c "node a.js"', "node"],
        ['pwsh --command "node a.js"', "node"],
        ["pwsh -c 'node a.js'", "node"],
        ["pwsh -c node a.js", "node"],
      ];
      for (const [command, expected] of cases) {
        const res = analyzeShellCommand({ command, platform: "win32" });
        expect(res.ok).toBe(true);
        expect(res.segments[0]?.argv[0]).toBe(expected);
      }
    });
  });

  describe("shell allowlist (chained commands)", () => {
    it.each([
      {
        allowlist: [{ pattern: "/usr/bin/obsidian-cli" }, { pattern: "/usr/bin/head" }],
        command:
          "/usr/bin/obsidian-cli print-default && /usr/bin/obsidian-cli search foo | /usr/bin/head",
        expectedAnalysisOk: true,
        expectedAllowlistSatisfied: true,
      },
      {
        allowlist: [{ pattern: "/usr/bin/obsidian-cli" }],
        command: "/usr/bin/obsidian-cli print-default && /usr/bin/rm -rf /",
        expectedAnalysisOk: true,
        expectedAllowlistSatisfied: false,
      },
      {
        allowlist: [{ pattern: "/usr/bin/echo" }],
        command: "/usr/bin/echo ok &&",
        expectedAnalysisOk: false,
        expectedAllowlistSatisfied: false,
      },
      {
        allowlist: [{ pattern: "/usr/bin/grep" }, { pattern: "/usr/bin/cat" }],
        command: "/usr/bin/grep needle missing-file |& /usr/bin/cat",
        expectedAnalysisOk: false,
        expectedAllowlistSatisfied: false,
      },
      {
        allowlist: [{ pattern: "/usr/bin/grep" }, { pattern: "/usr/bin/echo" }],
        command: "! /usr/bin/grep needle file && /usr/bin/echo missing",
        expectedAnalysisOk: false,
        expectedAllowlistSatisfied: false,
      },
      {
        allowlist: [{ pattern: "/usr/bin/ping" }],
        command: "ping 127.0.0.1 -n 1 & whoami",
        expectedAnalysisOk: false,
        expectedAllowlistSatisfied: false,
        platform: "win32" as const,
      },
    ] satisfies ReadonlyArray<{
      allowlist: ExecAllowlistEntry[];
      command: string;
      expectedAnalysisOk: boolean;
      expectedAllowlistSatisfied: boolean;
      platform?: NodeJS.Platform;
    }>)("evaluates chained command allowlist scenario %j", async (testCase) => {
      const result = await evaluateShellAllowlist({
        command: testCase.command,
        allowlist: testCase.allowlist,
        safeBins: new Set(),
        cwd: "/tmp",
        platform: testCase.platform,
      });
      expect(result.analysisOk).toBe(testCase.expectedAnalysisOk);
      expect(result.allowlistSatisfied).toBe(testCase.expectedAllowlistSatisfied);
    });

    it.each([
      { binary: "read", command: "read X; tool" },
      { binary: "shift", command: "shift; tool" },
      { binary: "unalias", command: "unalias ll; tool" },
    ])("does not allowlist shell state builtin $binary via PATH executables", async (testCase) => {
      if (process.platform === "win32") {
        return;
      }
      const dir = makeTempDir();
      const builtinPath = path.join(dir, testCase.binary);
      const toolPath = path.join(dir, "tool");
      fs.writeFileSync(builtinPath, "#!/bin/sh\n", { mode: 0o755 });
      fs.writeFileSync(toolPath, "#!/bin/sh\n", { mode: 0o755 });
      const env = makePathEnv(dir);
      try {
        const result = await evaluateShellAllowlist({
          command: testCase.command,
          allowlist: [{ pattern: builtinPath }, { pattern: toolPath }],
          safeBins: new Set(),
          cwd: dir,
          env,
        });
        expect(result.analysisOk).toBe(false);
        expect(result.allowlistSatisfied).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("allows the skill display prelude when a later skill wrapper is allowlisted", async () => {
      if (process.platform === "win32") {
        return;
      }
      const { skillRoot, skillPath, wrapperPath } = createSkillPreludeFixture({
        withWrapper: true,
      });

      const result = await evaluateShellAllowlist({
        command: `cat ${skillPath} && printf '\\n---CMD---\\n' && ${wrapperPath} calendar events primary --today --json`,
        allowlist: [{ pattern: wrapperPath }],
        safeBins: new Set(),
        cwd: skillRoot,
      });

      expect(result.analysisOk).toBe(true);
      expect(result.allowlistSatisfied).toBe(true);
      expect(result.segmentSatisfiedBy).toEqual(["skillPrelude", "skillPrelude", "allowlist"]);
    });

    it("does not treat arbitrary allowlisted binaries as trusted skill wrappers", async () => {
      if (process.platform === "win32") {
        return;
      }
      const { skillRoot, skillPath } = createSkillPreludeFixture();

      const result = await evaluateShellAllowlist({
        command: `cat ${skillPath} && printf '\\n---CMD---\\n' && /bin/echo calendar events primary --today --json`,
        allowlist: [{ pattern: "/bin/echo" }],
        safeBins: new Set(),
        cwd: skillRoot,
      });

      expect(result.analysisOk).toBe(true);
      expect(result.allowlistSatisfied).toBe(false);
      expect(result.segmentSatisfiedBy).toEqual([null, null, null]);
    });

    it("still rejects the skill display prelude when no trusted skill command follows", async () => {
      if (process.platform === "win32") {
        return;
      }
      const { skillRoot, skillPath } = createSkillPreludeFixture();

      const result = await evaluateShellAllowlist({
        command: `cat ${skillPath} && printf '\\n---CMD---\\n'`,
        allowlist: [],
        safeBins: new Set(),
        cwd: skillRoot,
      });

      expect(result.analysisOk).toBe(true);
      expect(result.allowlistSatisfied).toBe(false);
      expect(result.segmentSatisfiedBy).toEqual([null, null]);
    });

    it("rejects the skill display prelude when a trusted wrapper is not reachable", async () => {
      if (process.platform === "win32") {
        return;
      }
      const { skillRoot, skillPath, wrapperPath } = createSkillPreludeFixture({
        withWrapper: true,
      });

      const result = await evaluateShellAllowlist({
        command: `cat ${skillPath} && printf '\\n---CMD---\\n' && false && ${wrapperPath} calendar events primary --today --json`,
        allowlist: [{ pattern: wrapperPath }],
        safeBins: new Set(),
        cwd: skillRoot,
      });

      expect(result.analysisOk).toBe(true);
      expect(result.allowlistSatisfied).toBe(false);
      expect(result.segmentSatisfiedBy).toEqual([null, null, null, null]);
    });

    it.each(['/usr/bin/echo "foo && bar"', '/usr/bin/echo "foo\\" && bar"'])(
      "respects quoted chain separator for %s",
      async (command) => {
        const result = await evaluateShellAllowlist({
          command,
          allowlist: [{ pattern: "/usr/bin/echo" }],
          safeBins: new Set(),
          cwd: "/tmp",
        });
        expect(result.analysisOk).toBe(true);
        expect(result.allowlistSatisfied).toBe(true);
      },
    );

    it("fails allowlist analysis for shell line continuations", async () => {
      const result = await evaluateShellAllowlist({
        command: 'echo "ok $\\\n(id -u)"',
        allowlist: [{ pattern: "/usr/bin/echo" }],
        safeBins: new Set(),
        cwd: "/tmp",
      });
      expect(result.analysisOk).toBe(false);
      expect(result.allowlistSatisfied).toBe(false);
    });

    it("does not satisfy bare wrapper allowlist entries for inline cmd payloads", async () => {
      const dir = makeTempDir();
      const cmdPath = path.join(dir, "cmd.exe");
      fs.writeFileSync(cmdPath, "");
      fs.chmodSync(cmdPath, 0o755);
      try {
        const result = await evaluateShellAllowlist({
          command: "cmd.exe -c echo sample",
          allowlist: [{ pattern: cmdPath }],
          safeBins: new Set(),
          cwd: dir,
          env: makePathEnv(dir),
          platform: "win32",
        });
        expect(result.analysisOk).toBe(true);
        expect(result.allowlistSatisfied).toBe(false);
        expect(result.segmentAllowlistEntries).toEqual([null]);
        expect(result.segmentSatisfiedBy).toEqual([null]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("evaluates inline cmd payloads against the inner executable", async () => {
      const dir = makeTempDir();
      const cmdPath = path.join(dir, "cmd.exe");
      const nodePath = path.join(dir, "node.exe");
      for (const file of [cmdPath, nodePath]) {
        fs.writeFileSync(file, "");
        fs.chmodSync(file, 0o755);
      }
      try {
        const result = await evaluateShellAllowlist({
          command: "cmd.exe -c node.exe app.js",
          allowlist: [{ pattern: nodePath }],
          safeBins: new Set(),
          cwd: dir,
          env: makePathEnv(dir),
          platform: "win32",
        });
        expect(result.analysisOk).toBe(true);
        expect(result.allowlistSatisfied).toBe(true);
        expect(result.allowlistMatches.map((entry) => entry.pattern)).toEqual([nodePath]);
        expect(result.segmentAllowlistEntries).toEqual([null]);
        expect(result.segmentSatisfiedBy).toEqual(["allowlist"]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rejects Windows inline cmd payloads with PowerShell command separators", () => {
      const dir = makeTempDir();
      const cmdPath = path.join(dir, "cmd.exe");
      const allowedPath = path.join(dir, "allowed.exe");
      for (const file of [cmdPath, allowedPath]) {
        fs.writeFileSync(file, "");
        fs.chmodSync(file, 0o755);
      }
      try {
        const env = makePathEnv(dir);
        const analysis = analyzeArgvCommand({
          argv: ["cmd.exe", "/c", "pwsh", "-Command", "allowed.exe;", "unlisted.exe"],
          cwd: dir,
          env,
        });
        expect(analysis.ok).toBe(true);
        const result = evaluateExecAllowlist({
          analysis,
          allowlist: [{ pattern: allowedPath }],
          safeBins: new Set(),
          cwd: dir,
          env,
          platform: "win32",
        });
        expect(result.allowlistSatisfied).toBe(false);
        expect(result.segmentAllowlistEntries).toEqual([null]);
        expect(result.segmentSatisfiedBy).toEqual([null]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rejects PowerShell inline argv payloads with trailing command tokens", () => {
      const dir = makeTempDir();
      const allowedPath = path.join(dir, "allowed.exe");
      fs.writeFileSync(allowedPath, "");
      fs.chmodSync(allowedPath, 0o755);
      try {
        const env = makePathEnv(dir);
        const analysis = analyzeArgvCommand({
          argv: ["pwsh", "-Command", "allowed.exe", ";", "unlisted.exe"],
          cwd: dir,
          env,
        });
        expect(analysis.ok).toBe(true);
        const result = evaluateExecAllowlist({
          analysis,
          allowlist: [{ pattern: allowedPath }],
          safeBins: new Set(),
          cwd: dir,
          env,
          platform: "win32",
        });
        expect(result.allowlistSatisfied).toBe(false);
        expect(result.segmentAllowlistEntries).toEqual([null]);
        expect(result.segmentSatisfiedBy).toEqual([null]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each([
      {
        name: "extra script argument",
        scriptArgs: ["-ExtraArg"],
        argPattern: "^\x00\x00$",
        expected: false,
      },
      {
        name: "empty script argument",
        scriptArgs: [""],
        argPattern: "^\x00\x00$",
        expected: false,
      },
      {
        name: "empty script argument after dispatch unwrap",
        wrapperPrefix: ["env"],
        scriptArgs: [""],
        argPattern: "^\x00\x00$",
        expected: false,
      },
      {
        name: "semicolon data argument",
        scriptArgs: ["literal;data"],
        argPattern: "^literal;data\x00$",
        expected: true,
      },
    ])(
      "preserves PowerShell file argv for $name",
      ({ wrapperPrefix = [], scriptArgs, argPattern, expected }) => {
        const dir = makeTempDir();
        const pwshPath = path.join(dir, "pwsh");
        const scriptPath = path.join(dir, "script.ps1");
        for (const file of [pwshPath, scriptPath]) {
          fs.writeFileSync(file, "");
          fs.chmodSync(file, 0o755);
        }
        try {
          const env = makePathEnv(dir);
          const analysis = analyzeArgvCommand({
            argv: [...wrapperPrefix, "pwsh", "-File", scriptPath, ...scriptArgs],
            cwd: dir,
            env,
          });
          expect(analysis.ok).toBe(true);
          const result = evaluateExecAllowlist({
            analysis,
            allowlist: [{ pattern: scriptPath, argPattern }],
            safeBins: new Set(),
            cwd: dir,
            env,
            platform: "win32",
          });
          expect(result.allowlistSatisfied).toBe(expected);
          if (!expected) {
            expect(result.segmentAllowlistEntries).toEqual([null]);
            expect(result.segmentSatisfiedBy).toEqual([null]);
          }
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    it.each([
      { name: "slash encoded-command alias", argv: ["pwsh", "/ec", "ZQBjAGgAbwA="] },
      { name: "encoded-command prefix abbreviation", argv: ["pwsh", "-en", "ZQBjAGgAbwA="] },
      {
        name: "error action alias before command",
        argv: ["pwsh", "-ea", "stop", "-Command", "inline_payload"],
      },
      {
        name: "execution policy alias before command",
        argv: ["pwsh", "-ep", "Bypass", "-Command", "inline_payload"],
      },
      {
        name: "custom pipe name before encoded-command alias",
        argv: ["pwsh", "-cus", "pipe-name", "-ec", "ZQBjAGgAbwA="],
      },
      {
        name: "token alias before command",
        argv: ["pwsh", "-to", "token-value", "-Command", "inline_payload"],
      },
      {
        name: "utc timestamp alias before command",
        argv: ["pwsh", "-utc", "1234", "-Command", "inline_payload"],
      },
      {
        name: "encoded arguments prefix before command",
        argv: ["pwsh", "-encodeda", "YQByAGcA", "-Command", "inline_payload"],
      },
      {
        name: "command with args full form",
        argv: ["pwsh", "-CommandWithArgs", "inline_payload"],
      },
      {
        name: "unrecognized shell wrapper argv",
        argv: ["pwsh", "-UnrecognizedCommandForm", "inline_payload"],
      },
    ])("does not satisfy bare wrapper allowlist entries for PowerShell $name", ({ argv }) => {
      const dir = makeTempDir();
      const pwshPath = path.join(dir, "pwsh");
      fs.writeFileSync(pwshPath, "");
      fs.chmodSync(pwshPath, 0o755);
      try {
        const env = makePathEnv(dir);
        const analysis = analyzeArgvCommand({ argv, cwd: dir, env });
        expect(analysis.ok).toBe(true);
        const result = evaluateExecAllowlist({
          analysis,
          allowlist: [{ pattern: pwshPath }],
          safeBins: new Set(),
          cwd: dir,
          env,
          platform: "win32",
        });
        expect(result.allowlistSatisfied).toBe(false);
        expect(result.segmentAllowlistEntries).toEqual([null]);
        expect(result.segmentSatisfiedBy).toEqual([null]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("satisfies allowlist when bare * wildcard is present", async () => {
      const dir = makeTempDir();
      const binPath = path.join(dir, "mybin");
      fs.writeFileSync(binPath, "#!/bin/sh\n", { mode: 0o755 });
      const env = makePathEnv(dir);
      try {
        const result = await evaluateShellAllowlist({
          command: "mybin --flag",
          allowlist: [{ pattern: "*" }],
          safeBins: new Set(),
          cwd: dir,
          env,
        });
        expect(result.analysisOk).toBe(true);
        expect(result.allowlistSatisfied).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("normalizes safe bin names", () => {
      expect([...normalizeSafeBins([" jq ", "", "JQ", " sort "])]).toEqual(["jq", "sort"]);
    });

    describe("shell wrapper inline compound allowlist", () => {
      const commonShells = ["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"] as const;
      type ShellFixture = {
        dir: string;
        env: NodeJS.ProcessEnv;
        binPath: (name: string) => string;
      };

      function writeExecutable(filePath: string) {
        fs.writeFileSync(filePath, "#!/bin/sh\n", { mode: 0o755 });
      }

      function withShellFixture(
        binaries: readonly string[],
        run: (fixture: ShellFixture) => Promise<void>,
      ): Promise<void> {
        const dir = makeTempDir();
        const binPath = (name: string): string => path.join(dir, name);
        for (const binary of binaries) {
          writeExecutable(binPath(binary));
        }
        const env = makePathEnv(dir);
        return Promise.resolve()
          .then(() => run({ dir, env, binPath }))
          .finally(() => {
            fs.rmSync(dir, { recursive: true, force: true });
          });
      }

      it.each(commonShells)(
        "evaluates inner chain commands for %s -c wrappers",
        async (shellBinary) => {
          if (process.platform === "win32") {
            return;
          }
          await withShellFixture(
            [shellBinary, "cat", "printf", "gog-wrapper"],
            async ({ binPath, dir, env }) => {
              const shellPath = binPath(shellBinary);
              const catPath = binPath("cat");
              const printfPath = binPath("printf");
              const gogPath = binPath("gog-wrapper");
              const result = await evaluateShellAllowlist({
                command: `${shellPath} -c "cat SKILL.md && printf '---CMD---' && gog-wrapper calendar events"`,
                allowlist: [{ pattern: catPath }, { pattern: printfPath }, { pattern: gogPath }],
                safeBins: new Set(),
                cwd: dir,
                env,
              });
              expect(result.analysisOk).toBe(true);
              expect(result.allowlistSatisfied).toBe(true);
              expect(result.allowlistMatches.length).toBe(3);
              expect(result.segmentSatisfiedBy).toEqual(["allowlist", "allowlist", "allowlist"]);
              expect(result.segmentAllowlistEntries.every((entry) => entry !== null)).toBe(true);
              expect(result.segmentSatisfiedBy.length).toBe(result.segments.length);
              expect(result.segmentAllowlistEntries.length).toBe(result.segments.length);
            },
          );
        },
      );

      it("rejects wrapper chain when any inner command misses the allowlist", async () => {
        if (process.platform === "win32") {
          return;
        }
        await withShellFixture(
          ["sh", "cat", "rm", "gog-wrapper"],
          async ({ binPath, dir, env }) => {
            const shellPath = binPath("sh");
            const catPath = binPath("cat");
            const gogPath = binPath("gog-wrapper");
            const result = await evaluateShellAllowlist({
              command: `${shellPath} -c "cat SKILL.md && rm -rf / && gog-wrapper calendar events"`,
              allowlist: [{ pattern: catPath }, { pattern: gogPath }],
              safeBins: new Set(),
              cwd: dir,
              env,
            });
            expect(result.analysisOk).toBe(true);
            expect(result.allowlistSatisfied).toBe(false);
          },
        );
      });

      it("evaluates single-command wrapper payloads through the planner", async () => {
        if (process.platform === "win32") {
          return;
        }
        await withShellFixture(["sh", "gog-wrapper"], async ({ binPath, dir, env }) => {
          const shellPath = binPath("sh");
          const gogPath = binPath("gog-wrapper");
          const result = await evaluateShellAllowlist({
            command: `${shellPath} -c "gog-wrapper calendar events"`,
            allowlist: [{ pattern: gogPath }],
            safeBins: new Set(),
            cwd: dir,
            env,
          });
          expect(result.analysisOk).toBe(true);
          expect(result.allowlistSatisfied).toBe(true);
          expect(result.segmentSatisfiedBy).toEqual(["allowlist"]);
        });
      });

      it("pins allowlisted positional carrier executables when rendering shell commands", async () => {
        if (process.platform === "win32") {
          return;
        }
        await withShellFixture(["sh", "printf"], async ({ binPath, dir, env }) => {
          const shellPath = binPath("sh");
          const shellRealPath = fs.realpathSync(shellPath);
          const printfPath = binPath("printf");
          const printfRealPath = fs.realpathSync(printfPath);
          for (const testCase of [
            {
              command: `sh -c '$0 "$@"' printf hi`,
              expectedTokenIndex: 3,
              expectedCommand: `'${shellRealPath}' -c '$0 "$@"' '${printfRealPath}' hi`,
            },
            {
              command: `env sh -c '$0 "$@"' printf hi`,
              expectedTokenIndex: 4,
              expectedCommand: `'${shellRealPath}' '-c' '$0 "$@"' '${printfRealPath}' 'hi'`,
            },
            {
              command: `nice sh -c '$0 "$@"' printf hi`,
              expectedTokenIndex: 4,
              expectedCommand: `'${shellRealPath}' '-c' '$0 "$@"' '${printfRealPath}' 'hi'`,
            },
          ]) {
            const result = await evaluateShellAllowlist({
              command: testCase.command,
              allowlist: [{ pattern: printfPath }],
              safeBins: new Set(),
              trustedSafeBinDirs: buildTrustedSafeBinDirs({ extraDirs: [dir] }),
              cwd: dir,
              env,
            });
            expect(result.analysisOk, testCase.command).toBe(true);
            expect(result.allowlistSatisfied, testCase.command).toBe(true);
            expect(result.segmentPinnedArgvTokens, testCase.command).toEqual([
              { tokenIndex: testCase.expectedTokenIndex, replacement: printfRealPath },
            ]);
            expect(result.authorizationPlan, testCase.command).toBeDefined();
            if (!result.authorizationPlan) {
              throw new Error("expected authorization plan");
            }

            const rendered = renderAuthorizationShellCommand({
              plan: result.authorizationPlan,
              segments: result.segments,
              segmentPinnedArgvTokens: result.segmentPinnedArgvTokens,
              platform: process.platform,
              mode: "enforced",
            });
            expect(rendered, testCase.command).toEqual({
              ok: true,
              command: testCase.expectedCommand,
            });
          }
        });
      });

      it("does not allowlist wrapper payloads when outer arguments are evaluated", async () => {
        if (process.platform === "win32") {
          return;
        }
        await withShellFixture(["sh", "echo", "id"], async ({ binPath, dir, env }) => {
          const shellPath = binPath("sh");
          const echoPath = binPath("echo");
          const result = await evaluateShellAllowlist({
            command: `${shellPath} -c 'echo safe' $(id)`,
            allowlist: [{ pattern: echoPath }],
            safeBins: new Set(),
            cwd: dir,
            env,
          });
          expect(result.analysisOk).toBe(false);
          expect(result.allowlistSatisfied).toBe(false);
          expect(result.segmentSatisfiedBy).toEqual([]);
        });
      });
    });
  });
});

describe("windowsEscapeArg", () => {
  it("returns empty string quoted", () => {
    expect(windowsEscapeArg("")).toEqual({ ok: true, escaped: '""' });
  });

  it("returns safe values as-is", () => {
    expect(windowsEscapeArg("foo.exe")).toEqual({ ok: true, escaped: "foo.exe" });
    expect(windowsEscapeArg("C:/Program/bin")).toEqual({ ok: true, escaped: "C:/Program/bin" });
  });

  it("double-quotes values with spaces", () => {
    expect(windowsEscapeArg("hello world")).toEqual({ ok: true, escaped: '"hello world"' });
  });

  it("escapes embedded double quotes", () => {
    expect(windowsEscapeArg('say "hi"')).toEqual({ ok: true, escaped: '"say ""hi"""' });
  });

  it("rejects tokens with % meta character", () => {
    expect(windowsEscapeArg("%PATH%")).toEqual({ ok: false });
  });

  it("allows ! in double-quoted args (PowerShell does not treat ! as special)", () => {
    expect(windowsEscapeArg("hello!")).toEqual({ ok: true, escaped: '"hello!"' });
  });

  it("rejects $ followed by identifier (PowerShell variable expansion)", () => {
    expect(windowsEscapeArg("$env:SECRET")).toEqual({ ok: false });
    expect(windowsEscapeArg("$var")).toEqual({ ok: false });
    expect(windowsEscapeArg("${var}")).toEqual({ ok: false });
  });

  it("rejects $( subexpressions (PowerShell subexpression operator)", () => {
    // PowerShell evaluates $(expression) inside double-quoted strings, so
    // a token like "$(whoami)" would execute whoami even when double-quoted.
    expect(windowsEscapeArg("$(whoami)")).toEqual({ ok: false });
    expect(windowsEscapeArg("$(Get-Date)")).toEqual({ ok: false });
  });

  it("rejects $? and $$ (PowerShell automatic variables)", () => {
    expect(windowsEscapeArg("$?")).toEqual({ ok: false });
    expect(windowsEscapeArg("$$")).toEqual({ ok: false });
  });

  it("allows $ not followed by identifier (e.g. UNC admin share C$)", () => {
    expect(windowsEscapeArg("\\\\host\\C$")).toEqual({ ok: true, escaped: '"\\\\host\\C$"' });
    expect(windowsEscapeArg("trailing$")).toEqual({ ok: true, escaped: '"trailing$"' });
  });
});

describe("matchAllowlist with argPattern", () => {
  const resolution = {
    rawExecutable: "python3",
    resolvedPath: "/usr/bin/python3",
    executableName: "python3",
  };

  it("matches path-only entry regardless of argv", () => {
    const entry = { pattern: "/usr/bin/python3" };
    const entries: ExecAllowlistEntry[] = [entry];
    expect(matchAllowlist(entries, resolution, ["python3", "a.py"])).toBe(entry);
    expect(matchAllowlist(entries, resolution, ["python3", "b.py"])).toBe(entry);
    expect(matchAllowlist(entries, resolution, ["python3"])).toBe(entry);
  });

  it("matches argPattern with regex", () => {
    const entry = { pattern: "/usr/bin/python3", argPattern: "^a\\.py$" };
    const entries: ExecAllowlistEntry[] = [entry];
    expect(matchAllowlist(entries, resolution, ["python3", "a.py"])).toBe(entry);
    expect(matchAllowlist(entries, resolution, ["python3", "b.py"])).toBeNull();
    expect(matchAllowlist(entries, resolution, ["python3", "a.py", "--verbose"])).toBeNull();
  });

  it.each(["linux", "darwin"])("enforces argPattern on %s", (platform) => {
    const entry = { pattern: "/usr/bin/python3", argPattern: "^safe\\.py$" };
    const entries: ExecAllowlistEntry[] = [entry];
    expect(matchAllowlist(entries, resolution, ["python3", "safe.py"], platform)).toBe(entry);
    expect(matchAllowlist(entries, resolution, ["python3", "-c", "print(1)"], platform)).toBeNull();
  });

  it.each(["linux", "darwin", "win32"])(
    "prefers argPattern match over path-only match on %s",
    (platform) => {
      const pathOnlyEntry = { pattern: "/usr/bin/python3" };
      const argPatternEntry = { pattern: "/usr/bin/python3", argPattern: "^a\\.py$" };
      const entries: ExecAllowlistEntry[] = [pathOnlyEntry, argPatternEntry];
      const match = matchAllowlist(entries, resolution, ["python3", "a.py"], platform);
      expect(match).toBe(argPatternEntry);
    },
  );

  it.each(["linux", "darwin", "win32"])(
    "falls back to path-only match when argPattern does not match on %s",
    (platform) => {
      const pathOnlyEntry = { pattern: "/usr/bin/python3" };
      const argPatternEntry = { pattern: "/usr/bin/python3", argPattern: "^a\\.py$" };
      const entries: ExecAllowlistEntry[] = [pathOnlyEntry, argPatternEntry];
      const match = matchAllowlist(entries, resolution, ["python3", "b.py"], platform);
      expect(match).toBe(pathOnlyEntry);
    },
  );

  it.each(["linux", "darwin", "win32"])(
    "requires argv before matching argPattern entries on %s",
    (platform) => {
      const restrictedEntries: ExecAllowlistEntry[] = [
        { pattern: "/usr/bin/python3", argPattern: "^a\\.py$" },
      ];
      expect(matchAllowlist(restrictedEntries, resolution, undefined, platform)).toBeNull();

      const mixedEntries: ExecAllowlistEntry[] = [
        { pattern: "/usr/bin/python3", argPattern: "^a\\.py$" },
        { pattern: "/usr/bin/python3" },
      ];
      const fallback = matchAllowlist(mixedEntries, resolution, undefined, platform);
      expect(fallback).toBe(mixedEntries[1]);
    },
  );

  it("handles invalid regex gracefully", () => {
    const entries: ExecAllowlistEntry[] = [{ pattern: "/usr/bin/python3", argPattern: "[invalid" }];
    expect(matchAllowlist(entries, resolution, ["python3", "a.py"])).toBeNull();
  });

  it("rejects split-arg bypass against single-arg auto-generated argPattern", () => {
    // buildArgPatternFromArgv always appends a trailing \x00 sentinel so that
    // matchArgPattern can detect \x00-join style via .includes("\x00") even for
    // single-arg patterns.  "^hello world\x00$" is the auto-generated form for
    // argv ["python3", "hello world"].
    const entry = { pattern: "/usr/bin/python3", argPattern: "^hello world\x00$" };
    const entries: ExecAllowlistEntry[] = [entry];
    // Original approved single-arg must still match (argsString = "hello world\x00").
    expect(matchAllowlist(entries, resolution, ["python3", "hello world"])).toBe(entry);
    // Split-arg bypass must be rejected (argsString = "hello\x00world\x00").
    expect(matchAllowlist(entries, resolution, ["python3", "hello", "world"])).toBeNull();
  });

  it("supports regex alternation in argPattern", () => {
    const entry = { pattern: "/usr/bin/python3", argPattern: "^(a|b)\\.py$" };
    const entries: ExecAllowlistEntry[] = [entry];
    expect(matchAllowlist(entries, resolution, ["python3", "a.py"])).toBe(entry);
    expect(matchAllowlist(entries, resolution, ["python3", "b.py"])).toBe(entry);
    expect(matchAllowlist(entries, resolution, ["python3", "c.py"])).toBeNull();
  });

  it("distinguishes zero-arg pattern from one-empty-string-arg pattern", () => {
    // buildArgPatternFromArgv encodes [] as "^\x00\x00$" (double sentinel) and
    // [""] as "^\x00$" (single sentinel) so the two cannot cross-match.
    const zeroArgEntry = { pattern: "/usr/bin/python3", argPattern: "^\x00\x00$" };
    const emptyArgEntry = { pattern: "/usr/bin/python3", argPattern: "^\x00$" };
    const zeroArgEntries: ExecAllowlistEntry[] = [zeroArgEntry];
    const emptyArgEntries: ExecAllowlistEntry[] = [emptyArgEntry];
    // Zero-arg command must match zero-arg pattern but not empty-string-arg pattern.
    expect(matchAllowlist(zeroArgEntries, resolution, ["python3"])).toBe(zeroArgEntry);
    expect(matchAllowlist(emptyArgEntries, resolution, ["python3"])).toBeNull();
    // One-empty-string-arg command must match empty-string-arg pattern but not zero-arg pattern.
    expect(matchAllowlist(emptyArgEntries, resolution, ["python3", ""])).toBe(emptyArgEntry);
    expect(matchAllowlist(zeroArgEntries, resolution, ["python3", ""])).toBeNull();
  });
});

describe("Windows enforced shell command builder", () => {
  it("builds enforced command for simple Windows command", () => {
    const analysis = analyzeShellCommand({
      command: "python3 a.py",
      platform: "win32",
    });
    expect(analysis.ok).toBe(true);
    const result = buildEnforcedShellCommand({
      command: "python3 a.py",
      segments: analysis.segments,
      platform: "win32",
    });
    expect(result.ok).toBe(true);
    expect(typeof result.command).toBe("string");
    expect(result.command?.trim().length).toBeGreaterThan(0);
  });

  it("rejects Windows commands with unsafe tokens", () => {
    const result = buildEnforcedShellCommand({
      command: "echo ok & del file",
      segments: [],
      platform: "win32",
    });
    expect(result.ok).toBe(false);
  });
});
