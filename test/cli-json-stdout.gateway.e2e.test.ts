import "../src/test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { expect, it } from "vitest";
import {
  withCliHome,
  isolatedEnv,
  expectCleanOutput,
  expectCliError,
  expectMissing,
  runIsolatedCli,
  cliCase,
} from "./cli-json-stdout-contract.test-support.js";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

function queryCases(
  name: string,
  args: string[],
  message: string,
  extra: { configReadFailure?: boolean } = {},
) {
  return [
    { name: "in JSON mode", flags: ["--json"] },
    { name: "in human mode", flags: [], human: true },
    { name: "through forced Commander", flags: ["--json"], commander: true },
    { name: "with dual TTYs", flags: ["--json"], tty: true },
  ].map(({ name: mode, flags, ...options }) =>
    Object.assign({ name: `${name} ${mode}`, args: [...args, ...flags], message }, options, extra),
  );
}

const invalidDuration = "Invalid --last-connected: Invalid duration";
const missingInvocation = "--node and --command required";

it.each([
  ...queryCases(
    "invalid call params",
    ["gateway", "call", "system-presence", "--params", "not-json"],
    "--params must be valid JSON.",
  ),
  ...queryCases(
    "contradictory usage options",
    ["gateway", "usage-cost", "--agent", "alpha", "--all-agents"],
    "Use --agent or --all-agents, not both",
  ),
  ...queryCases(
    "Gateway health config failure",
    ["gateway", "health", "--port", "29793"],
    "AUTOQA_ROUTE_CONFIG_READ_FAILURE",
    { configReadFailure: true },
  ),
  cliCase("gateway call system-presence --url ws://127.0.0.1:29793 --json", {
    specializedAuth: true,
  }),
])("renders Gateway query failures through the Gateway owner for $name", async (testCase) => {
  await withCliHome(async (tempHome) => {
    const configPath = path.join(tempHome, "missing-openclaw.json");
    const stateDir = path.join(tempHome, "isolated-state");
    const gatewayError = "AUTOQA_INJECTED_GATEWAY_FAILURE";
    const concurrentSparkplug = "AUTOQA_CONCURRENT_SPARKPLUG";
    const result = runIsolatedCli(tempHome, testCase.args, {
      ...testCase,
      source: [
        'import net from "node:net";',
        `net.Socket.prototype.connect = function () { throw new Error(${JSON.stringify(gatewayError)}); };`,
        `if (!process.versions.bun && !process.execArgv.includes("--no-concurrent-sparkplug")) process.stderr.write(${JSON.stringify(`${concurrentSparkplug}\n`)});`,
        ...("configReadFailure" in testCase
          ? [
              'import fs from "node:fs";',
              "Error.stackTraceLimit = 50;",
              "const originalReadFileSync = fs.readFileSync;",
              "fs.readFileSync = function (target, ...args) {",
              '  if (String(target) === process.env.OPENCLAW_CONFIG_PATH && new Error().stack?.includes("readNonObservingHealthConfig")) {',
              `    throw Object.assign(new Error(${JSON.stringify(testCase.message)}), { code: "EIO" });`,
              "  }",
              "  return originalReadFileSync.call(this, target, ...args);",
              "};",
            ]
          : []),
      ],
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        ...("tty" in testCase ? { NO_COLOR: undefined } : {}),
      },
    });

    // Concurrent Sparkplug can deadlock process.exit, so the child times out with status null.
    expect(result.stderr).not.toContain(concurrentSparkplug);
    expect(result.status, result.stderr).toBe(1);
    expectCleanOutput(result.stdout, result.stderr);
    expect(result.stdout).not.toContain(gatewayError);
    expect(result.stderr).not.toContain(gatewayError);
    if ("human" in testCase) {
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(testCase.message);
    } else if ("specializedAuth" in testCase) {
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        error: {
          type: "gateway_credentials_required",
          message: [
            "gateway url override requires explicit credentials",
            "Fix: pass --token or --password with --url (or gatewayToken in tools).",
            "For the default local or SSH-tunneled Gateway, remove --url to use the configured target.",
            `Config: ${configPath}`,
          ].join("\n"),
        },
      });
      expect(result.stderr).toBe("");
    } else {
      expectCliError(
        result.stdout,
        "configReadFailure" in testCase
          ? `Config could not be read at ${configPath}:\n- <root>: read failed at ${configPath}: Error: ${testCase.message}`
          : testCase.message,
      );
      if ("configReadFailure" in testCase && !("commander" in testCase)) {
        expect(result.stderr).toContain("[openclaw] The CLI command failed.");
      }
      expect(result.stderr).not.toContain(testCase.message);
    }
    if ("tty" in testCase) {
      expect(result.stderr).toContain("\u001B[?25h");
    }
    await expectMissing(stateDir, configPath);
  });
});

it.each([
  cliCase("status --json --timeout nope", {}),
  cliCase("health --timeout 0 --json", {}),
  cliCase("status --timeout nope --json", { commander: true }),
  cliCase("health --json --timeout 0", { commander: true }),
  cliCase("status --json --timeout nope", { tty: true }),
])("renders invalid status/health timeouts as canonical JSON for $name", async (testCase) => {
  await withCliHome(async (tempHome) => {
    const result = runIsolatedCli(tempHome, testCase.args, {
      ...testCase,
      env: { OPENCLAW_GATEWAY_PORT: "29791" },
    });
    const message = "--timeout must be a positive integer (milliseconds)";

    expect(result.status, result.stderr).toBe(1);
    expectCleanOutput(result.stdout, result.stderr);
    expectCliError(result.stdout, message);
    expect(result.stderr).toContain("[openclaw] The CLI command failed.");
    expect(result.stderr).not.toContain(message);
    if ("tty" in testCase) {
      expect(result.stderr).toContain("\u001B[?25h");
    }
  });
});

it.each([
  cliCase("nodes status --last-connected not-a-duration", {
    message: invalidDuration,
    human: true,
  }),
  cliCase("nodes status --json --last-connected not-a-duration", { message: invalidDuration }),
  cliCase("nodes status --last-connected not-a-duration --json", { message: invalidDuration }),
  cliCase("nodes list --last-connected not-a-duration", { message: invalidDuration, human: true }),
  cliCase("nodes list --json --last-connected not-a-duration", { message: invalidDuration }),
  cliCase("nodes list --last-connected not-a-duration --json", { message: invalidDuration }),
  cliCase(["nodes", "invoke", "--node", "   ", "--command", "canvas.eval", "--json"], {
    message: missingInvocation,
  }),
  cliCase(["nodes", "invoke", "--node", "   ", "--command", "canvas.eval"], {
    message: missingInvocation,
  }),
  cliCase(["nodes", "invoke", "--node", "mac-1", "--command", "   ", "--json"], {
    message: missingInvocation,
  }),
  cliCase(["nodes", "invoke", "--node", "mac-1", "--command", "   "], {
    message: missingInvocation,
  }),
  cliCase(["nodes", "rename", "--node", "mac-1", "--name", "   ", "--json"], {
    message: "--name must not be empty",
  }),
])("renders nodes $name through the shared validation owner", async (testCase) => {
  await withCliHome(async (tempHome) => {
    const denyNetwork = Buffer.from(
      `import net from "node:net";
           net.Socket.prototype.connect = function () { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };
           globalThis.fetch = async () => { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };`,
    ).toString("base64");
    const result = runBuiltCli(
      tempHome,
      testCase.args,
      {
        // Startup probes SQLite in a worker; filesystem writes remain denied in the CLI.
        NODE_OPTIONS: "--permission --allow-fs-read=* --allow-worker",
        NODE_DISABLE_COMPILE_CACHE: "1",
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_LOG_LEVEL: "silent",
        ...isolatedEnv(tempHome),
      },
      { execArgv: [`--import=data:text/javascript;base64,${denyNetwork}`] },
    );

    expect(result.status, result.stderr).toBe(1);
    if ("human" in testCase && testCase.human) {
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`nodes ${testCase.args[1]} failed:`);
      expect(result.stderr).toContain(testCase.message);
    } else {
      expectCliError(result.stdout, expect.stringContaining(testCase.message));
      expect(result.stderr).toContain("[openclaw] The CLI command failed.");
      expect(result.stderr).not.toContain(testCase.message);
    }
    expect(result.stderr).not.toContain("AUTOQA_NETWORK_FORBIDDEN");
  });
});
