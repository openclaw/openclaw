import "../src/test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
import {
  withCliHome,
  expectFailure,
  runIsolatedCli,
} from "./cli-json-stdout-contract.test-support.js";

afterEach(() => clearRuntimeConfigSnapshot());

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
  setRuntimeConfigSnapshot({});
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
    await withCliHome(async (tempHome) => {
      if ("exporterFailure" in testCase) {
        await seedTrajectorySession(tempHome, "agent:main:trajectory-process");
      }
      const args = testCase.args.map((arg) => (arg === "$TRAJECTORY_WORKSPACE" ? tempHome : arg));
      const result = runIsolatedCli(tempHome, args, {
        ...testCase,
        env: { OPENCLAW_GATEWAY_PORT: "29791" },
        source: [
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
        ],
      });

      expectFailure(result, testCase.message, {
        ...testCase,
        cleanHuman: true,
        once: true,
        network: true,
      });
    });
  });

  it.each([
    { name: "direct JSON export", encoded: false, json: true },
    { name: "encoded request precedence with plain output", encoded: true, json: false },
  ])("preserves successful trajectory $name", async (testCase) => {
    await withCliHome(async (tempHome) => {
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

      const result = runIsolatedCli(tempHome, args, { env: { OPENCLAW_GATEWAY_PORT: "29791" } });

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
      await fs.access(
        path.join(tempHome, ".openclaw", "trajectory-exports", output, "manifest.json"),
      );
    });
  });
});
