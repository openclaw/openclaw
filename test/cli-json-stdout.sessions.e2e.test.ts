import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

async function seedTrajectorySession(tempHome: string, sessionKey: string) {
  const stateDir = path.join(tempHome, "isolated-state");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
    OPENCLAW_STATE_DIR: stateDir,
  };
  delete env.OPENCLAW_HOME;
  const [{ upsertSessionEntryCore }, { closeOpenClawAgentDatabaseByPath }] = await Promise.all([
    import("../src/config/sessions/session-accessor.js"),
    import("../src/state/openclaw-agent-db.js"),
  ]);
  await upsertSessionEntryCore(
    { agentId: "main", env, sessionKey },
    { sessionId: "trajectory-process-session", updatedAt: 1 },
  );
  closeOpenClawAgentDatabaseByPath(
    path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
  );
}

describe("cli json stdout contract", () => {
  // Command-level suites own individual option validation. This matrix keeps
  // the distinct route-first, Commander, TTY, and operational finalizers.
  it.each([
    {
      name: "human route-first validation",
      args: ["sessions", "--active", "0"],
      message: "--active must be a positive number of minutes, for example --active 30.",
      human: true,
    },
    {
      name: "human Commander validation",
      args: ["sessions", "--limit", "0"],
      message: '--limit must be a positive integer or "all", for example --limit 25.',
      human: true,
      commander: true,
    },
    {
      name: "JSON route-first validation",
      args: ["sessions", "--json", "--active", "0"],
      message: "--active must be a positive number of minutes, for example --active 30.",
    },
    {
      name: "JSON Commander validation",
      args: ["sessions", "--json", "--limit", "0"],
      message: '--limit must be a positive integer or "all", for example --limit 25.',
      commander: true,
    },
    {
      name: "dual-TTY route-first finalization",
      args: ["sessions", "--json", "--active", "0"],
      message: "--active must be a positive number of minutes, for example --active 30.",
      tty: true,
    },
    {
      name: "trajectory exporter operational failure",
      args: [
        "sessions",
        "export-trajectory",
        "--session-key",
        "agent:main:trajectory-process",
        "--workspace",
        "$TRAJECTORY_WORKSPACE",
        "--json",
      ],
      message: "Failed to export trajectory: injected trajectory exporter failure",
      exporterFailure: true,
    },
    {
      name: "compact dual-TTY finalization",
      args: ["sessions", "compact", "agent:main:test", "--max-lines", "0", "--json"],
      message: "--max-lines must be a positive integer.",
      tty: true,
    },
  ])("renders sessions $name through the canonical failure owner", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        if ("exporterFailure" in testCase) {
          await seedTrajectorySession(tempHome, "agent:main:trajectory-process");
        }
        const preload = Buffer.from(
          [
            'import net from "node:net";',
            'net.Socket.prototype.connect = function () { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };',
            'globalThis.fetch = async () => { throw new Error("AUTOQA_NETWORK_FORBIDDEN"); };',
            ...("exporterFailure" in testCase
              ? [
                  'import fs from "node:fs/promises";',
                  "const originalRealpath = fs.realpath;",
                  `fs.realpath = async (target, ...args) => { if (target === ${JSON.stringify(tempHome)}) { throw new Error("injected trajectory exporter failure"); } return originalRealpath(target, ...args); };`,
                ]
              : []),
            ...("tty" in testCase
              ? [
                  'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });',
                  'Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });',
                ]
              : []),
          ].join("\n"),
        ).toString("base64");
        const args = testCase.args.map((arg) => (arg === "$TRAJECTORY_WORKSPACE" ? tempHome : arg));
        const result = runBuiltCli(
          tempHome,
          args,
          {
            OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
            OPENCLAW_GATEWAY_PORT: "29791",
            OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
            ...("commander" in testCase ? { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } : {}),
            ...("tty" in testCase ? { FORCE_COLOR: "1" } : {}),
          },
          { execArgv: [`--import=data:text/javascript;base64,${preload}`] },
        );

        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout, result.stderr).not.toContain("\u001B");
        expect(result.stdout, result.stderr).not.toContain("\u0007");
        if ("human" in testCase) {
          expect(result.stdout).toBe("");
        } else {
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: { type: "cli_error", message: testCase.message },
          });
        }
        expect(result.stderr).toContain(testCase.message);
        expect(result.stderr.split(testCase.message)).toHaveLength(2);
        expect(result.stderr).not.toContain("AUTOQA_NETWORK_FORBIDDEN");
        if ("tty" in testCase) {
          expect(result.stderr).toContain("\u001B[?25h");
        }
      },
      { prefix: "openclaw-sessions-registration-json-failure-e2e-" },
    );
  });

  it.each([
    { name: "direct JSON export", encoded: false, json: true },
    { name: "encoded request precedence with plain output", encoded: true, json: false },
  ])("preserves successful trajectory $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const sessionKey = "agent:main:trajectory-process";
        await seedTrajectorySession(tempHome, sessionKey);
        const output = testCase.encoded ? "encoded-export" : "direct-export";
        const args = [
          "sessions",
          "export-trajectory",
          "--session-key",
          testCase.encoded ? "agent:main:missing" : sessionKey,
          "--output",
          "direct-export",
          "--workspace",
          tempHome,
        ];
        if (testCase.encoded) {
          args.push(
            "--request-json-base64",
            Buffer.from(JSON.stringify({ sessionKey, output }), "utf8").toString("base64url"),
          );
        }
        if (testCase.json) {
          args.push("--json");
        }

        const result = runBuiltCli(tempHome, args, {
          OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
          OPENCLAW_GATEWAY_PORT: "29791",
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
        });

        expect(result.status, result.stderr).toBe(0);
        if (testCase.json) {
          expect(JSON.parse(result.stdout)).toMatchObject({
            displayPath: `.openclaw/trajectory-exports/${output}`,
            sessionId: "trajectory-process-session",
          });
        } else {
          expect(result.stdout).toContain("✅ Trajectory exported!");
          expect(result.stdout).toContain(`.openclaw/trajectory-exports/${output}`);
          expect(result.stdout).toContain("trajectory-process-session");
        }
        await expect(
          fs.access(
            path.join(tempHome, ".openclaw", "trajectory-exports", output, "manifest.json"),
          ),
        ).resolves.toBeUndefined();
      },
      { prefix: "openclaw-trajectory-success-e2e-" },
    );
  });
});
