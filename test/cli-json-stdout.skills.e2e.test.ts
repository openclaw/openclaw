import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { assert, describe, expect, it } from "vitest";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

describe("cli json stdout contract", () => {
  // skills-cli suites own individual validation and fallback branches. Keep
  // representative built-process proofs for routing, Gateway, and debug output.
  it.each([
    {
      name: "search with a leaf JSON flag",
      args: ["skills", "search", "fixture", "--json"],
      message: "ClawHub /api/v1/search failed (400): offline fixture",
    },
    {
      name: "list with a parent JSON flag",
      args: ["skills", "--json", "list", "--agent", ""],
      message: "--agent must not be blank",
    },
    {
      name: "list with a configured remote Gateway missing its URL",
      args: ["skills", "list", "--json"],
      message: "gateway remote mode misconfigured: gateway.remote.url missing",
      remoteMissing: true,
    },
    {
      name: "curator status after an explicit environment Gateway fails",
      args: ["skills", "curator", "status", "--json"],
      message: "AUTOQA_SELECTED_GATEWAY_FAILURE",
      explicitGateway: true,
    },
    {
      name: "retired curator mutation",
      args: ["skills", "curator", "pin", "missing-skill", "--json"],
      message:
        "Skill lifecycle curation is retired. The weekly collection review manages the skill collection; pin, unpin, and restore no longer exist.",
    },
    {
      name: "workshop workspace validation with parent JSON",
      args: ["skills", "--json", "workshop", "list", "--agent", ""],
      message: "--agent must not be blank",
    },
    {
      name: "workshop mutation",
      args: ["skills", "workshop", "reject", "missing-proposal", "--json"],
      message: "Skill proposal not found: missing-proposal",
    },
  ])("returns one canonical JSON document when skills $name fails", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "missing-openclaw.json");
        if ("remoteMissing" in testCase) {
          await fs.writeFile(configPath, JSON.stringify({ gateway: { mode: "remote" } }));
        }
        const preload = `data:text/javascript,${encodeURIComponent(
          [
            'globalThis.fetch = async () => new Response("offline fixture", { status: 400 });',
            ...("explicitGateway" in testCase
              ? [
                  'import net from "node:net";',
                  'net.Socket.prototype.connect = function () { throw new Error("AUTOQA_SELECTED_GATEWAY_FAILURE"); };',
                ]
              : []),
          ].join("\n"),
        )}`;
        const result = runBuiltCli(
          tempHome,
          testCase.args,
          {
            OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_GATEWAY_PORT: "1",
            ...("explicitGateway" in testCase
              ? {
                  OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:9",
                  OPENCLAW_GATEWAY_TOKEN: "fixture-token",
                }
              : {}),
          },
          { execArgv: [`--import=${preload}`] },
        );
        const message =
          "remoteMissing" in testCase
            ? [
                testCase.message,
                `Config: ${configPath}`,
                "Fix: set gateway.remote.url, or set gateway.mode=local.",
              ].join("\n")
            : testCase.message;

        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message,
          },
        });
        expect(result.stderr).toContain(message);
        expect(result.stderr.length).toBeLessThan(2_048);
      },
      { prefix: "openclaw-skills-json-failure-e2e-" },
    );
  });

  it.each([
    { name: "off", debug: "0", includesCause: false },
    { name: "on", debug: "1", includesCause: true },
  ])("keeps skills search nested causes behind debug mode ($name)", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        // Match the selected runtime's SyntaxError for the same malformed response.
        let syntaxError: unknown;
        try {
          JSON.parse("not-json");
        } catch (error) {
          syntaxError = error;
        }
        assert(syntaxError instanceof SyntaxError);
        const preload = `data:text/javascript,${encodeURIComponent(
          'globalThis.fetch = async () => new Response("not-json", { status: 200 });',
        )}`;
        const result = runBuiltCli(
          tempHome,
          ["skills", "search", "fixture"],
          {
            OPENCLAW_DEBUG: testCase.debug,
            OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
            OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
          },
          { execArgv: [`--import=${preload}`] },
        );

        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("ClawHub /api/v1/search returned malformed JSON");
        expect(result.stderr.includes(syntaxError.message)).toBe(testCase.includesCause);
      },
      { prefix: "openclaw-skills-human-failure-e2e-" },
    );
  });
});
