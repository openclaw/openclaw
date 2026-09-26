import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

describe("cli json stdout contract", () => {
  it.each([
    {
      name: "implicit JSON",
      args: ["cron", "edit", "job-1", "--enable", "--disable"],
    },
    {
      name: "explicit JSON",
      args: ["cron", "edit", "job-1", "--enable", "--disable", "--json"],
    },
    {
      name: "automation alias implicit JSON",
      args: ["automations", "edit", "job-1", "--enable", "--disable"],
    },
    {
      name: "ordinary local validation failure",
      args: ["cron", "edit", "job-1", "--command-cwd", "", "--json"],
      message: "--command-cwd must not be blank",
    },
    {
      name: "Gateway failure implicit JSON",
      args: ["cron", "edit", "job-1", "--enable", "--port", "29793", "--token", "fixture-token"],
      gatewayRequest: true,
    },
    {
      name: "Gateway failure explicit JSON",
      args: [
        "cron",
        "edit",
        "job-1",
        "--enable",
        "--port",
        "29793",
        "--token",
        "fixture-token",
        "--json",
      ],
      gatewayRequest: true,
    },
    {
      name: "forced Commander JSON",
      args: ["cron", "edit", "job-1", "--enable", "--disable", "--json"],
      commander: true,
    },
    {
      name: "dual-TTY implicit JSON",
      args: ["cron", "edit", "job-1", "--enable", "--disable"],
      tty: true,
    },
    {
      name: "dual-TTY automation alias implicit JSON",
      args: ["automations", "edit", "job-1", "--enable", "--disable"],
      tty: true,
    },
    {
      name: "dual-TTY implicit JSON command sibling",
      args: ["cron", "runs", "--id", "job-1", "--limit", "invalid"],
      message: "Invalid --limit (must be a positive integer).",
      tty: true,
    },
    {
      name: "dual-TTY raw-output command sibling",
      args: ["cron", "scratch", "job-1", "--set", "updated", "--unset"],
      message: "choose only one of --set, --file, or --unset",
      tty: true,
    },
    {
      name: "dual-TTY explicit JSON",
      args: ["cron", "edit", "job-1", "--enable", "--disable", "--json"],
      tty: true,
    },
    {
      name: "human-output sibling",
      args: ["cron", "list", "--agent", ""],
      message: "--agent must not be blank",
      human: true,
    },
    {
      name: "dual-TTY human-output sibling",
      args: ["cron", "list", "--agent", ""],
      message: "--agent must not be blank",
      human: true,
      tty: true,
    },
  ])("renders cron edit failures through the shared owner for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "missing-openclaw.json");
        const stateDir = path.join(tempHome, "isolated-state");
        const gatewayError = "AUTOQA_INJECTED_GATEWAY_FAILURE";
        const preload = Buffer.from(
          [
            'import net from "node:net";',
            `net.Socket.prototype.connect = function () { throw new Error(${JSON.stringify(gatewayError)}); };`,
            ...("tty" in testCase
              ? [
                  'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });',
                  'Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });',
                ]
              : []),
          ].join("\n"),
        ).toString("base64");
        const result = runBuiltCli(
          tempHome,
          testCase.args,
          {
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_STATE_DIR: stateDir,
            ...("commander" in testCase ? { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } : {}),
            ...("tty" in testCase ? { FORCE_COLOR: "1" } : {}),
          },
          { execArgv: [`--import=data:text/javascript;base64,${preload}`] },
        );
        const message =
          "gatewayRequest" in testCase
            ? gatewayError
            : (testCase.message ?? "Choose --enable or --disable, not both");

        expect(result.status, result.stderr).toBe(1);
        if ("human" in testCase) {
          if ("tty" in testCase) {
            expect(result.stdout).toContain("OpenClaw");
          } else {
            expect(result.stdout).toBe("");
          }
        } else {
          expect(result.stdout, result.stderr).not.toContain("\u001B");
          expect(result.stdout, result.stderr).not.toContain("\u0007");
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: { type: "cli_error", message },
          });
        }
        expect(result.stderr).toContain(message);
        if ("gatewayRequest" in testCase) {
          expect(result.stderr).toContain(gatewayError);
        } else {
          expect(result.stderr).not.toContain(gatewayError);
          await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
        }
        if ("tty" in testCase && !("human" in testCase)) {
          expect(result.stderr).toContain("\u001B[?25h");
        }
        await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
      },
      { prefix: "openclaw-cron-edit-json-failure-e2e-" },
    );
  });
});
