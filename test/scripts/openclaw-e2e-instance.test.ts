import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const helperPath = path.resolve("scripts/lib/openclaw-e2e-instance.sh");

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function runHelper(payload: string) {
  return spawnSync(
    "bash",
    [
      "-lc",
      [
        "set -euo pipefail",
        `source ${shellQuote(helperPath)}`,
        `openclaw_e2e_eval_test_state_from_b64 ${shellQuote(payload)}`,
        'printf "value=%s" "${OPENCLAW_E2E_INSTANCE_TEST:-unset}"',
      ].join("; "),
    ],
    { encoding: "utf8" },
  );
}

function base64(script: string): string {
  return execFileSync("base64", { input: script, encoding: "utf8" }).replace(/\s+/gu, "");
}

describe("scripts/lib/openclaw-e2e-instance.sh", () => {
  it("sources decoded test-state scripts", () => {
    const result = runHelper(base64('export OPENCLAW_E2E_INSTANCE_TEST="ok"\n'));

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("value=ok");
  });

  it("fails when the test-state payload is not valid base64", () => {
    const result = runHelper("@@@");

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("value=");
    expect(result.stderr).toContain("Invalid OpenClaw test-state base64 payload");
  });

  it("fails when the test-state payload decodes to an empty script", () => {
    const result = runHelper(base64("\n"));

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("value=");
    expect(result.stderr).toContain("decoded to an empty script");
  });

  it("wraps package installs with the configured timeout", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-instance-"));
    try {
      const timeoutArgsPath = path.join(tempDir, "timeout-args.txt");
      const npmArgsPath = path.join(tempDir, "npm-args.txt");
      const logPath = path.join(tempDir, "install.log");
      const packagePath = path.join(tempDir, "openclaw.tgz");
      fs.writeFileSync(packagePath, "");
      fs.writeFileSync(
        path.join(tempDir, "timeout"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'printf "%s\\n" "$*" >"$OPENCLAW_TEST_TIMEOUT_ARGS"',
          'while [ "$#" -gt 0 ] && [ "$1" != "npm" ]; do shift; done',
          'exec "$@"',
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(tempDir, "npm"),
        ["#!/bin/sh", "set -eu", 'printf "%s\\n" "$*" >"$OPENCLAW_TEST_NPM_ARGS"', ""].join("\n"),
      );
      fs.chmodSync(path.join(tempDir, "timeout"), 0o755);
      fs.chmodSync(path.join(tempDir, "npm"), 0o755);

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            `source ${shellQuote(helperPath)}`,
            `openclaw_e2e_install_package ${shellQuote(logPath)} ${shellQuote("fixture package")}`,
          ].join("; "),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${tempDir}:${process.env.PATH ?? ""}`,
            OPENCLAW_CURRENT_PACKAGE_TGZ: packagePath,
            OPENCLAW_E2E_NPM_INSTALL_TIMEOUT: "42s",
            OPENCLAW_TEST_TIMEOUT_ARGS: timeoutArgsPath,
            OPENCLAW_TEST_NPM_ARGS: npmArgsPath,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Installing fixture package...");
      expect(fs.readFileSync(timeoutArgsPath, "utf8").trim()).toBe(
        `--kill-after=30s 42s npm install -g ${packagePath} --no-fund --no-audit`,
      );
      expect(fs.readFileSync(npmArgsPath, "utf8").trim()).toBe(
        `install -g ${packagePath} --no-fund --no-audit`,
      );
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("runs package installs without a wrapper when timeout is unavailable", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-instance-no-timeout-"));
    try {
      const npmArgsPath = path.join(tempDir, "npm-args.txt");
      const logPath = path.join(tempDir, "install.log");
      const packagePath = path.join(tempDir, "openclaw.tgz");
      fs.writeFileSync(packagePath, "");
      fs.writeFileSync(
        path.join(tempDir, "npm"),
        ["#!/bin/sh", "set -eu", 'printf "%s\\n" "$*" >"$OPENCLAW_TEST_NPM_ARGS"', ""].join("\n"),
      );
      fs.chmodSync(path.join(tempDir, "npm"), 0o755);

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            `source ${shellQuote(helperPath)}`,
            `openclaw_e2e_install_package ${shellQuote(logPath)} ${shellQuote("fixture package")}`,
          ].join("; "),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: tempDir,
            OPENCLAW_CURRENT_PACKAGE_TGZ: packagePath,
            OPENCLAW_E2E_NPM_INSTALL_TIMEOUT: "42s",
            OPENCLAW_TEST_NPM_ARGS: npmArgsPath,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(fs.readFileSync(logPath, "utf8")).toContain("timeout command not found");
      expect(fs.readFileSync(npmArgsPath, "utf8").trim()).toBe(
        `install -g ${packagePath} --no-fund --no-audit`,
      );
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
