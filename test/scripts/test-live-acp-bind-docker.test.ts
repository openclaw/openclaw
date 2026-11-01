import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const testNodeExecPath = resolveTestNodeExecPath();
const script = readFileSync("scripts/test-live-acp-bind-docker.sh", "utf8");
const setupStart = "read -r -d '' LIVE_TEST_CMD <<'EOF' || true\n";
const setupEnd = 'tmp_dir="$(mktemp -d)"';
const setupParts = script.split(setupStart);
expect(setupParts).toHaveLength(2);
const setupEndParts = setupParts[1]!.split(setupEnd);
expect(setupEndParts).toHaveLength(2);
const setup = setupEndParts[0]!;
const writeExecutable = (file: string, text: string) => writeFileSync(file, text, { mode: 0o755 });

it.each([
  ["claude", "9.1.0", "subscription", "unset", false],
  ["claude-real", "9.1.0", "api-key", "fixture-key", false],
  [undefined, undefined, "subscription", "unset", true],
  ["claude-real", "9.0.0", "api-key", "fixture-key", true],
] as const)(
  "prepares %s version %s with %s auth (%s, install=%s)",
  (existing, installedVersion, mode, key, shouldInstall) => {
    const home = createTempDir("openclaw-acp-claude-setup-");
    const bin = path.join(home, "bin");
    const prefix = path.join(home, "npm");
    const installedBin = path.join(prefix, "bin");
    const calls = path.join(home, "calls");
    const installs = path.join(home, "installs");
    const fixture = path.join(home, "claude-fixture");
    const acpxDir = path.join(home, "extensions", "acpx");
    const adapterDir = path.join(acpxDir, "node_modules/@agentclientprotocol/claude-agent-acp");
    const sdkDir = path.join(adapterDir, "node_modules", "@anthropic-ai", "claude-agent-sdk");
    for (const dir of [bin, installedBin, sdkDir]) {
      mkdirSync(dir, { recursive: true });
    }
    const manifest = (dir: string, data: object) =>
      writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(data)}\n`);
    manifest(acpxDir, {});
    manifest(adapterDir, {});
    manifest(sdkDir, {
      exports: { ".": "./sdk.mjs" },
      claudeCodeVersion: "9.1.0",
    });
    writeFileSync(path.join(sdkDir, "sdk.mjs"), "export {};\n");
    const executable =
      '#!/bin/sh\nprintf "%s:%s\\n" "$*" "${ANTHROPIC_API_KEY-unset}" >> "$TEST_CALLS"\nprintf "9.1.0 (Claude Code)\\n"\n';
    writeExecutable(fixture, executable);
    if (existing) {
      writeExecutable(path.join(installedBin, existing), executable);
    }
    if (installedVersion) {
      const packageDir = path.join(prefix, "lib", "node_modules", "@anthropic-ai", "claude-code");
      mkdirSync(packageDir, { recursive: true });
      manifest(packageDir, { version: installedVersion });
    }
    writeExecutable(
      path.join(bin, "npm"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_INSTALLS"\ncp "$TEST_CLAUDE_FIXTURE" "$NPM_CONFIG_PREFIX/bin/claude"\n',
    );
    writeExecutable(
      path.join(bin, "timeout"),
      '#!/bin/sh\ncase "$1" in --kill-after=*) shift;; esac\nshift\nexec "$@"\n',
    );
    const result = spawnSync("bash", ["-c", setup], {
      cwd: home,
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: `${bin}:${path.dirname(testNodeExecPath)}:/usr/bin:/bin`,
        NPM_CONFIG_PREFIX: prefix,
        OPENCLAW_LIVE_DOCKER_SCRIPTS_DIR: path.resolve("scripts"),
        OPENCLAW_DOCKER_AUTH_PRESTAGED: "1",
        OPENCLAW_LIVE_ACP_BIND_AGENT: "claude",
        OPENCLAW_LIVE_ACP_BIND_CLAUDE_AUTH: mode,
        OPENCLAW_LIVE_ACP_BIND_SETUP_TIMEOUT_SECONDS: "180",
        ANTHROPIC_API_KEY: "ambient-fixture-key",
        OPENCLAW_LIVE_ACP_BIND_ANTHROPIC_API_KEY: "fixture-key",
        TEST_CALLS: calls,
        TEST_INSTALLS: installs,
        TEST_CLAUDE_FIXTURE: fixture,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Using Claude Code 9.1.0 declared by the ACPX-owned Claude Agent SDK",
    );
    expect(readFileSync(calls, "utf8")).toBe(`--version:${key}\nauth status:${key}\n`);
    expect(readFileSync(path.join(installedBin, "claude-real"), "utf8")).toBe(executable);
    expect(existsSync(installs)).toBe(shouldInstall);
    if (shouldInstall) {
      expect(readFileSync(installs, "utf8")).toBe("install -g @anthropic-ai/claude-code@9.1.0\n");
    }
  },
);
