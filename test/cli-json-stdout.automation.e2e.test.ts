import "../src/test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cliCase,
  expectCleanOutput,
  expectCliError,
  expectMissing,
  runIsolatedCli,
  withCliHome,
} from "./cli-json-stdout-contract.test-support.js";

describe("cli json stdout contract", () => {
  it.each([
    cliCase("cron edit job-1 --enable --disable", {}),
    cliCase("cron edit job-1 --enable --disable --json", {}),
    cliCase("automations edit job-1 --enable --disable", {}),
    cliCase(["cron", "edit", "job-1", "--command-cwd", "", "--json"], {
      message: "--command-cwd must not be blank",
    }),
    ...["", " --json"].map((suffix) =>
      cliCase(`cron edit job-1 --enable --port 29793 --token fixture-token${suffix}`, {
        gatewayRequest: true,
      }),
    ),
    cliCase("cron edit job-1 --enable --disable --json", {
      name: "forced Commander JSON",
      commander: true,
    }),
    cliCase("cron edit job-1 --enable --disable", {
      name: "dual-TTY implicit JSON",
      tty: true,
    }),
    cliCase("automations edit job-1 --enable --disable", {
      name: "dual-TTY automation alias implicit JSON",
      tty: true,
    }),
    cliCase("cron runs --id job-1 --limit invalid", {
      message: "Invalid --limit (must be a positive integer).",
      tty: true,
    }),
    cliCase("cron scratch job-1 --set updated --unset", {
      message: "choose only one of --set, --file, or --unset",
      tty: true,
    }),
    cliCase("cron edit job-1 --enable --disable --json", {
      name: "dual-TTY explicit JSON",
      tty: true,
    }),
    cliCase(["cron", "list", "--agent", ""], {
      message: "--agent must not be blank",
      human: true,
    }),
    cliCase(["cron", "list", "--agent", ""], {
      message: "--agent must not be blank",
      human: true,
      tty: true,
      name: "dual-TTY human-output sibling",
    }),
  ])("renders cron edit failures through the shared owner for $name", async (testCase) => {
    await withCliHome(async (tempHome) => {
      const configPath = path.join(tempHome, "missing-openclaw.json");
      const stateDir = path.join(tempHome, "isolated-state");
      const gatewayError = "AUTOQA_INJECTED_GATEWAY_FAILURE";
      const result = runIsolatedCli(tempHome, testCase.args, {
        commander: "commander" in testCase,
        tty: "tty" in testCase,
        source: [
          'import net from "node:net";',
          `net.Socket.prototype.connect = function () { throw new Error(${JSON.stringify(gatewayError)}); };`,
        ],
        env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      });
      const message =
        "gatewayRequest" in testCase
          ? gatewayError
          : "message" in testCase
            ? testCase.message
            : "Choose --enable or --disable, not both";

      expect(result.status, result.stderr).toBe(1);
      if ("human" in testCase) {
        if ("tty" in testCase) {
          expect(result.stdout).toContain("OpenClaw");
        } else {
          expect(result.stdout).toBe("");
        }
      } else {
        expectCleanOutput(result.stdout, result.stderr);
        expectCliError(result.stdout, message);
      }
      if ("gatewayRequest" in testCase) {
        expect(result.stderr).toContain("[openclaw] The CLI command failed.");
        expect(result.stderr).not.toContain(message);
        expect(result.stderr).not.toContain(gatewayError);
      } else {
        expect(result.stderr).toContain(message);
        expect(result.stderr).not.toContain(gatewayError);
        await expectMissing(stateDir);
      }
      if ("tty" in testCase && !("human" in testCase)) {
        expect(result.stderr).toContain("\u001B[?25h");
      }
      await expectMissing(configPath);
    });
  });
});
