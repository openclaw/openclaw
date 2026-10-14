import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness, writeNodeBackedJq } from "./test-helpers.ts";

const SCRIPT = "scripts/claude-auth-status.sh";

describe("claude-auth-status.sh", () => {
  const harness = createScriptTestHarness();

  function fixture({
    readiness,
    expiresAt,
    apiKeys = 0,
    statusExit = 0,
  }: {
    readiness?: "configured" | "unknown" | "missing";
    expiresAt?: number;
    apiKeys?: number;
    statusExit?: number;
  } = {}) {
    const root = harness.createTempDir("openclaw-claude-auth-status-");
    const bin = path.join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeNodeBackedJq(bin);
    const message = "Run claude auth login on the gateway host.";
    const status = {
      auth: {
        runtimeAuthRoutes: readiness
          ? [
              {
                status: readiness === "missing" ? "missing" : "usable",
                nativeAuth: { runtimeId: "claude-cli", mode: "oauth", readiness, message },
              },
            ]
          : [],
        oauth: {
          profiles:
            expiresAt === undefined
              ? []
              : [
                  {
                    provider: "anthropic",
                    type: "oauth",
                    profileId: "anthropic:test",
                    expiresAt,
                  },
                ],
        },
        providers: [{ provider: "anthropic", profiles: { apiKey: apiKeys } }],
      },
    };
    const openclaw = path.join(bin, "openclaw");
    writeFileSync(
      openclaw,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        '[ "$*" = "models status --json" ] || exit 2',
        `if [ "${statusExit}" -ne 0 ]; then exit ${statusExit}; fi`,
        "cat <<'JSON'",
        JSON.stringify(status),
        "JSON",
        "",
      ].join("\n"),
    );
    chmodSync(openclaw, 0o755);
    return {
      root,
      message,
      run(mode: "full" | "json" | "simple") {
        return spawnSync("bash", [SCRIPT, mode], {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH ?? ""}` },
        });
      },
    };
  }

  it("prints only managed expiry timestamps without GNU date errors", () => {
    const { run } = fixture({
      readiness: "configured",
      expiresAt: Date.now() + 2 * 60 * 60 * 1000,
    });
    const result = run("full");

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("date:");
    expect(result.stdout).toContain("Claude Code Auth Status");
    expect(result.stdout).toContain("CONFIGURED");
    expect(result.stdout.match(/Expires:/g)).toHaveLength(1);
    expect(result.stdout).not.toContain("setup-token");
    expect(result.stdout).not.toContain("doctor --yes");
  });

  it.each([
    ["configured", "OK:configured", "OK:native", "OK", 0, false],
    ["unknown", "UNKNOWN", "OK:native", "OK", 0, false],
    ["missing", "MISSING", "MISSING", "CLAUDE_EXPIRED", 1, true],
    [undefined, "UNKNOWN", "UNKNOWN", "UNKNOWN", 3, false],
  ] as const)(
    "uses native readiness %s with CLI-owned zero expiry, never inferred logout",
    (readiness, nativeStatus, managedStatus, simpleStatus, exit, needsReauth) => {
      const { run, message } = fixture({ readiness });
      const json = run("json");
      expect(json.status).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual({
        claude_code: {
          status: nativeStatus,
          expires_at_ms: 0,
          readiness: readiness ?? "unknown",
          message: readiness ? message : "",
        },
        openclaw: { status: managedStatus, expires_at_ms: 0 },
        needs_reauth: needsReauth,
      });
      const simple = run("simple");
      expect(simple.status).toBe(exit);
      expect(simple.stdout.trim()).toBe(simpleStatus);
      if (readiness === "missing") {
        expect(run("full").stdout).toContain(message);
      }
    },
  );

  it.each([
    [0, 0, "OPENCLAW_EXPIRED", 1],
    [-60_000, 0, "OPENCLAW_EXPIRED", 1],
    [30 * 60_000, 0, "OPENCLAW_EXPIRING", 2],
    [undefined, 1, "OK", 0],
    [0, 1, "OK", 0],
  ] as const)(
    "preserves managed auth expiry %s and API keys %s",
    (remaining, apiKeys, output, exit) => {
      const { run } = fixture({
        readiness: "configured",
        expiresAt:
          remaining === undefined ? undefined : remaining === 0 ? 0 : Date.now() + remaining,
        apiKeys,
      });
      const result = run("simple");
      expect(result.status).toBe(exit);
      expect(result.stdout.trim()).toBe(output);
    },
  );

  it("reports command failure as unknown without reading credential file fallbacks", () => {
    const { root, run } = fixture({ statusExit: 1 });
    mkdirSync(path.join(root, ".claude"), { recursive: true });
    mkdirSync(path.join(root, ".openclaw/agents/main/agent"), { recursive: true });
    writeFileSync(
      path.join(root, ".claude/.credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 86_400_000 } }),
    );
    writeFileSync(
      path.join(root, ".openclaw/agents/main/agent/auth-profiles.json"),
      JSON.stringify({
        profiles: {
          "anthropic:default": { provider: "anthropic", expires: Date.now() + 86_400_000 },
        },
      }),
    );
    const simple = run("simple");
    expect(simple.status).toBe(3);
    expect(simple.stdout.trim()).toBe("UNKNOWN");
    const json = run("json");
    expect(json.status).toBe(3);
    expect(JSON.parse(json.stdout)).toMatchObject({
      claude_code: { status: "UNKNOWN", expires_at_ms: 0 },
      openclaw: { status: "UNKNOWN", expires_at_ms: 0 },
      needs_reauth: false,
    });
    const full = run("full");
    expect(full.status).toBe(3);
    expect(full.stdout).toContain("Unable to read authentication status");
  });
});
