import "../src/test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  withCliHome,
  expectCleanOutput,
  expectMissing,
  writeJson,
  runIsolatedCli,
  cliCase,
} from "./cli-json-stdout-contract.test-support.js";

it.each([
  cliCase("hooks --agent retired --json", {}),
  cliCase("hooks list --agent retired --json", {}),
  cliCase("hooks --json list --agent retired", {}),
  cliCase("hooks info demo --agent retired --json", {}),
  cliCase("hooks --json info demo --agent retired", {}),
  cliCase("hooks check --agent retired --json", {}),
  cliCase("hooks --json check --agent retired", {}),
  cliCase(["hooks", "list", "--agent", "", "--json"], { message: "--agent must not be blank" }),
  cliCase(["hooks", "--agent", "", "--json", "list"], {
    message: "--agent must not be blank",
    genericStderr: true,
  }),
  cliCase("hooks list --agent retired", { human: true }),
  cliCase("hooks list --agent retired --json", { commander: true }),
  cliCase("hooks check --agent retired --json", { tty: true }),
  cliCase("hooks list --json", {
    message: "gateway remote mode misconfigured: gateway.remote.url missing",
    remoteMissing: true,
  }),
  ...[
    cliCase("hooks --json", {}),
    cliCase("hooks list --json", {}),
    cliCase("hooks info demo --json", {}),
    cliCase("hooks check --json", {}),
  ].map(({ name, args }) => ({
    name: `${name} after an explicit environment Gateway fails`,
    args,
    message: "AUTOQA_SELECTED_GATEWAY_FAILURE",
    explicitGateway: true,
  })),
  cliCase("hooks list --json", {
    message: "injected hook report loading failure",
    reportFailure: true,
  }),
  cliCase("hooks info missing-hook --json", {
    message: 'Hook "missing-hook" not found.',
    missingHook: true,
  }),
  cliCase("hooks --json info missing-hook", {
    message: 'Hook "missing-hook" not found.',
    missingHook: true,
  }),
  cliCase("hooks info missing-hook --json", {
    message: 'Hook "missing-hook" not found.',
    missingHook: true,
    tty: true,
  }),
  cliCase("hooks info missing-hook", {
    message: 'Hook "missing-hook" not found. Run `openclaw hooks list` to see available hooks.',
    missingHook: true,
    human: true,
  }),
])("renders hooks read failures through their canonical owner for $name", async (testCase) => {
  await withCliHome(async (tempHome) => {
    const stateDir = path.join(tempHome, "isolated-state");
    const configPath = path.join(tempHome, "missing-openclaw.json");
    const workspaceHooksDir = path.join(stateDir, "workspace", "hooks");
    if ("remoteMissing" in testCase) {
      await writeJson(configPath, { gateway: { mode: "remote" } });
    }
    if ("reportFailure" in testCase) {
      await fs.mkdir(workspaceHooksDir, { recursive: true });
    }
    const socketError =
      "explicitGateway" in testCase
        ? "AUTOQA_SELECTED_GATEWAY_FAILURE"
        : "AUTOQA_NETWORK_FORBIDDEN";
    const socketErrorDetails = "explicitGateway" in testCase ? "{}" : '{ code: "ECONNREFUSED" }';
    const result = runIsolatedCli(tempHome, testCase.args, {
      ...testCase,
      source: [
        'import net from "node:net";',
        `net.Socket.prototype.connect = function () { throw Object.assign(new Error(${JSON.stringify(socketError)}), ${socketErrorDetails}); };`,
        'globalThis.fetch = async () => { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };',
        ...("reportFailure" in testCase
          ? [
              'import fs from "node:fs";',
              "const originalReadDir = fs.readdirSync;",
              `fs.readdirSync = (target, ...args) => { if (String(target) === ${JSON.stringify(workspaceHooksDir)}) { throw new Error("injected hook report loading failure"); } return originalReadDir(target, ...args); };`,
            ]
          : []),
      ],
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_GATEWAY_PORT: "29791",
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
        : (testCase.message ??
          'Unknown agent id "retired". Run openclaw agents list to see configured agents.');

    expect(result.status, result.stderr).toBe(1);
    expectCleanOutput(result.stdout, result.stderr);
    if ("human" in testCase) {
      if ("missingHook" in testCase) {
        expect(result.stdout.trim()).toBe(message);
      } else {
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(`Error: ${message}`);
      }
    } else {
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        error: { type: "cli_error", message },
        ...("missingHook" in testCase ? { hook: "missing-hook" } : {}),
      });
      if (!("missingHook" in testCase)) {
        if ("genericStderr" in testCase) {
          expect(result.stderr).toContain("[openclaw] The CLI command failed.");
          expect(result.stderr).not.toContain(message);
        } else {
          expect(result.stderr).toContain(message);
        }
      }
    }
    expect(result.stderr).not.toContain("AUTOQA_NETWORK_FORBIDDEN");
    if ("tty" in testCase) {
      expect(result.stderr).toContain("\u001B[?25h");
    }
    if ("remoteMissing" in testCase) {
      await expect(fs.readFile(configPath, "utf8")).resolves.toBe(
        JSON.stringify({ gateway: { mode: "remote" } }),
      );
    } else {
      await expectMissing(configPath);
    }
  });
});

it("preserves successful hooks report JSON and offline discovery", async () => {
  await withCliHome(async (tempHome) => {
    const result = runIsolatedCli(tempHome, ["hooks", "--json", "list"], {
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_GATEWAY_PORT: "1" },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({ hooks: expect.any(Array) }),
    );
    expect(result.stderr).toBe("");
  });
});
