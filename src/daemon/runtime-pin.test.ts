import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveDaemonInstallRuntimeInputs } from "../commands/daemon-install-plan.shared.js";
import { resolveGatewayDaemonRuntime } from "../commands/daemon-runtime.js";
import { resolvePinnedDaemonRuntimePath } from "./runtime-paths.js";
import { buildNodeServiceEnvironment, buildServiceEnvironment } from "./service-env.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

function runtimeFixture(script: string, name = "node"): string {
  const file = path.join(roots.make("runtime-pin-"), name);
  fs.writeFileSync(file, "#!" + process.execPath + "\n" + script, { mode: 0o700 });
  return file;
}

function runtimeOutput(nodeVersion = "26.12.1", sqliteVersion = "3.53.4") {
  const metadata = {
    nodeVersion,
    sqliteVersion,
    sqliteProbe: { available: true, version: sqliteVersion, text: true, blob: true, json: true },
  };
  return `process.stdout.write(${JSON.stringify(JSON.stringify(metadata))});`;
}
const probe = (file: string, env: NodeJS.ProcessEnv = {}) =>
  resolvePinnedDaemonRuntimePath(file, "node", env);

describe.skipIf(process.platform === "win32")("runtime pin executable boundary", () => {
  it("uses standalone identity even when the executable is named bun", async () => {
    const file = runtimeFixture(
      `
      const path = require("node:path");
      const root = path.join(path.dirname(process.argv[1]), "runtime");
      if (process.argv[2] !== path.join(root, "dist/infra/daemon-runtime-probe.entry.js") ||
          process.argv[3] !== "bun" || process.argv[4] !== root ||
          process.env.BUN_BE_BUN || process.env.NODE_OPTIONS || process.env.FIXTURE_SECRET) process.exit(9);
      process.stdout.write(JSON.stringify({
        bunVersion: "1.4.4", sqliteVersion: "3.53.4",
        sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true }
      }));
    `,
      "bun",
    );
    const root = path.dirname(file);
    fs.mkdirSync(path.join(root, "runtime"));
    fs.writeFileSync(
      path.join(root, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        mode: "aot",
        executable: { path: "bun" },
        runtime: { path: "runtime" },
        openclaw: { version: "2026.10.25" },
        bun: { version: "1.4.4" },
      }),
    );
    const env = {
      NODE_OPTIONS: "--require=/nonexistent/fixture.js",
      BUN_BE_BUN: "1",
      FIXTURE_SECRET: "synthetic",
    };
    expect(resolveGatewayDaemonRuntime([file, "gateway"])).toBe("standalone");
    await expect(resolvePinnedDaemonRuntimePath(file, "bun", env)).rejects.toThrow(
      /must name a bun/,
    );
    await expect(
      resolveDaemonInstallRuntimeInputs({
        runtime: "standalone",
        pinnedRuntimePath: file,
        devMode: true,
        env,
      }),
    ).resolves.toEqual({ devMode: false, runtime: "standalone", runtimePath: file });
    fs.rmdirSync(path.join(root, "runtime"));
    await expect(resolvePinnedDaemonRuntimePath(file, "standalone", env)).rejects.toThrow(
      /Restore the complete standalone artifact/,
    );
    fs.unlinkSync(path.join(root, "manifest.json"));
    await expect(resolvePinnedDaemonRuntimePath(file, "standalone", env)).rejects.toThrow(
      /must name a standalone/,
    );
  });

  it("uses a bounded sanitized probe without inheriting secrets or Node preloads", async () => {
    const file = runtimeFixture(
      "if (process.env.FIXTURE_SECRET || process.env.NODE_OPTIONS) process.exit(9);\n" +
        runtimeOutput(),
    );
    await expect(
      probe(file, {
        FIXTURE_SECRET: "synthetic-not-forwarded",
        NODE_OPTIONS: "--require=/nonexistent/fixture.js",
      }),
    ).resolves.toBe(file);
  });

  it.each([
    ["old Node", runtimeOutput("22.16.0"), /unsupported/],
    ["unsafe SQLite", runtimeOutput("26.12.1", "3.51.0"), /unsupported/],
    ["malformed output", 'process.stdout.write("{}");', /check failed/],
    ["oversized output", 'process.stdout.write("x".repeat(2 * 1024 * 1024));', /check failed/],
    ["mismatched family", 'throw new Error("must not execute");', /must name a node/, "bun"],
  ] as const)("refuses %s without replacement", async (_name, script, error, name?: string) => {
    const file = runtimeFixture(script, name ?? "node");
    await expect(probe(file)).rejects.toThrow(error);
  });

  it("terminates a hung runtime probe", async () => {
    const file = runtimeFixture("setInterval(() => {}, 1000);");
    await expect(probe(file)).rejects.toThrow(/check failed/);
  }, 15_000);

  it("rejects a removed pin and a directory", async () => {
    const file = runtimeFixture("");
    fs.unlinkSync(file);
    await expect(probe(file)).rejects.toThrow(/not executable/);
    fs.mkdirSync(file);
    await expect(probe(file)).rejects.toThrow(/not executable/);
  });
});

it.each([
  ["darwin", "/Users/example/Runtime Tools/bin/node"],
  ["linux", "/opt/runtime tools/bin/bun"],
  ["win32", "C:\\Runtime Tools\\node.exe"],
] as const)("omits runtime pin env for %s", (platform, pin) => {
  const stateDir = "/fixture/state";
  const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_DAEMON_RUNTIME_PATH: pin };
  for (const result of [
    buildServiceEnvironment({ env, port: 18789, platform }),
    buildNodeServiceEnvironment({ env, platform }),
  ]) {
    expect(result).not.toHaveProperty("OPENCLAW_DAEMON_RUNTIME_PATH");
    expect(result.OPENCLAW_STATE_DIR).toBe(stateDir);
  }
});
