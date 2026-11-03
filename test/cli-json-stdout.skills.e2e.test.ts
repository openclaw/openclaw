import "../src/test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { assert, describe, expect, it } from "vitest";
import {
  cliCase,
  expectCliError,
  runIsolatedCli,
  withCliHome,
  writeJson,
} from "./cli-json-stdout-contract.test-support.js";

describe("cli json stdout contract", () => {
  it.each([
    ...["skills search fixture --json", "skills --json search fixture"].map((command) =>
      cliCase(command, { message: "ClawHub /api/v1/search failed (400): offline fixture" }),
    ),
    ...[
      ["skills", "list", "--agent", "", "--json"],
      ["skills", "--json", "list", "--agent", ""],
      ["skills", "info", "fixture", "--agent", "", "--json"],
      ["skills", "--json", "info", "fixture", "--agent", ""],
      ["skills", "check", "--agent", "", "--json"],
      ["skills", "--json", "check", "--agent", ""],
      ["skills", "--agent", "", "--json"],
      ["skills", "--json", "--agent", ""],
      ["skills", "--json", "workshop", "list", "--agent", ""],
    ].map((args) => cliCase(args, { message: "--agent must not be blank" })),
    cliCase("skills list --json", {
      message: "gateway remote mode misconfigured: gateway.remote.url missing",
      remoteMissing: true,
    }),
    ...[
      "skills --json",
      "skills list --json",
      "skills info fixture --json",
      "skills check --json",
      "skills workshop list --json",
      "skills workshop archive fixture --json",
    ].map((command) =>
      cliCase(command, {
        name: `${command} after an explicit environment Gateway fails`,
        message: "AUTOQA_SELECTED_GATEWAY_FAILURE",
        explicitGateway: true,
      }),
    ),
    cliCase("skills workshop show missing-skill --version v1 --json", {
      message: 'Skill "missing-skill" has no version "v1". Versions: none.',
    }),
  ])("returns one canonical JSON document when skills $name fails", async (testCase) => {
    await withCliHome(async (tempHome) => {
      const configPath = path.join(tempHome, "missing-openclaw.json");
      if ("remoteMissing" in testCase) {
        await writeJson(configPath, { gateway: { mode: "remote" } });
      }
      const source = [
        'globalThis.fetch = async () => new Response("offline fixture", { status: 400 });',
        ...("explicitGateway" in testCase
          ? [
              'import net from "node:net";',
              'net.Socket.prototype.connect = function () { throw new Error("AUTOQA_SELECTED_GATEWAY_FAILURE"); };',
            ]
          : []),
      ];
      const result = runIsolatedCli(tempHome, testCase.args, {
        source,
        env: {
          OPENCLAW_GATEWAY_PORT: "1",
          ...("explicitGateway" in testCase
            ? {
                OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:9",
                OPENCLAW_GATEWAY_TOKEN: "fixture-token",
              }
            : {}),
        },
      });
      const message =
        "remoteMissing" in testCase
          ? [
              testCase.message,
              `Config: ${configPath}`,
              "Fix: set gateway.remote.url, or set gateway.mode=local.",
            ].join("\n")
          : testCase.message;

      expect(result.status, result.stderr).toBe(1);
      expectCliError(result.stdout, message);
      expect(result.stderr).toContain("[openclaw] The CLI command failed.");
      expect(result.stderr).not.toContain(message);
      expect(result.stderr.length).toBeLessThan(2_048);
    });
  });

  it.each([
    { name: "off", debug: "0", includesCause: false },
    { name: "on", debug: "1", includesCause: true },
  ])("keeps skills search nested causes behind debug mode ($name)", async (testCase) => {
    await withCliHome(async (tempHome) => {
      // Match the selected runtime's SyntaxError for the same malformed response.
      let syntaxError: unknown;
      try {
        JSON.parse("not-json");
      } catch (error) {
        syntaxError = error;
      }
      assert(syntaxError instanceof SyntaxError);
      const result = runIsolatedCli(tempHome, ["skills", "search", "fixture"], {
        env: { OPENCLAW_DEBUG: testCase.debug },
        source: ['globalThis.fetch = async () => new Response("not-json", { status: 200 });'],
      });

      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("ClawHub /api/v1/search returned malformed JSON");
      expect(result.stderr.includes(syntaxError.message)).toBe(testCase.includesCause);
    });
  });
});
