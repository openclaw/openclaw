import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __test__ } from "./logger.js";

describe("shouldSkipMutatingLoggingConfigRead", () => {
  it("matches config schema and validate invocations", () => {
    expect(
      __test__.shouldSkipMutatingLoggingConfigRead(["node", "openclaw", "config", "schema"]),
    ).toBe(true);
    expect(
      __test__.shouldSkipMutatingLoggingConfigRead(["node", "openclaw", "config", "validate"]),
    ).toBe(true);
  });

  it("handles root flags before config validate", () => {
    expect(
      __test__.shouldSkipMutatingLoggingConfigRead([
        "node",
        "openclaw",
        "--profile",
        "work",
        "--no-color",
        "config",
        "validate",
        "--json",
      ]),
    ).toBe(true);
  });

  it("does not match other commands", () => {
    expect(
      __test__.shouldSkipMutatingLoggingConfigRead(["node", "openclaw", "config", "get", "foo"]),
    ).toBe(false);
    expect(__test__.shouldSkipMutatingLoggingConfigRead(["node", "openclaw", "status"])).toBe(
      false,
    );
  });
});

function effectiveHome(): string {
  // Mirror the resolution order used by `resolveEffectiveHomeDir` in
  // `infra/home-dir.ts` so this test stays correct under the per-suite
  // `OPENCLAW_HOME` / `HOME` overrides that the harness sets up.
  const explicit = process.env.OPENCLAW_HOME;
  if (explicit) {
    return path.resolve(explicit);
  }
  if (process.env.HOME) {
    return path.resolve(process.env.HOME);
  }
  if (process.env.USERPROFILE) {
    return path.resolve(process.env.USERPROFILE);
  }
  return path.resolve(os.homedir());
}

describe("resolveActiveLogFile (#73587)", () => {
  it("expands a leading tilde to the home directory", () => {
    // Regression for #73587: configured `logging.file` paths come straight from
    // `openclaw.json`, where `~/.openclaw/logs/gateway.log` is the natural way
    // to spell "the user's home". Before the fix, the literal string was
    // passed to `fs.mkdirSync`, which crashed the gateway with
    // `ENOENT: no such file or directory, mkdir '~/.openclaw/logs'` and
    // produced a launchd / systemd respawn loop.
    const home = effectiveHome();
    const resolved = __test__.resolveActiveLogFile("~/.openclaw/logs/gateway.log");
    expect(resolved).toBe(path.join(home, ".openclaw/logs/gateway.log"));
  });

  it("leaves absolute paths unchanged", () => {
    const resolved = __test__.resolveActiveLogFile("/var/log/openclaw/gateway.log");
    expect(resolved).toBe("/var/log/openclaw/gateway.log");
  });

  it("expands tildes inside rolling-path inputs and keeps the rolling pattern", () => {
    const home = effectiveHome();
    const resolved = __test__.resolveActiveLogFile("~/.openclaw/logs/openclaw-2026-04-28.log");
    // The rolling pattern matcher fires on the basename, so the tilde-expanded
    // directory becomes the rolling target while the dated filename is kept.
    expect(resolved.startsWith(path.join(home, ".openclaw/logs"))).toBe(true);
    expect(path.basename(resolved)).toMatch(/^openclaw-\d{4}-\d{2}-\d{2}\.log$/u);
  });
});
