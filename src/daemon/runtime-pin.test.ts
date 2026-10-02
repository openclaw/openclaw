import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePinnedDaemonRuntimePath } from "./runtime-paths.js";
import { buildNodeServiceEnvironment, buildServiceEnvironment } from "./service-env.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runtimeFixture(script: string, name = "node"): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runtime-pin-")));
  roots.push(root);
  const file = path.join(root, name);
  fs.writeFileSync(file, "#!" + process.execPath + "\n" + script, { mode: 0o700 });
  return file;
}

function runtimeMetadata(nodeVersion = "26.8.1", sqliteVersion = "3.53.4") {
  return {
    nodeVersion,
    bunVersion: null,
    sqliteVersion,
    sqliteProbe: { available: true, version: sqliteVersion, text: true, blob: true, json: true },
  };
}

describe.skipIf(process.platform === "win32")("runtime pin executable boundary", () => {
  it("uses a bounded sanitized probe without inheriting secrets or Node preloads", async () => {
    const file = runtimeFixture(
      "if (process.env.FIXTURE_SECRET || process.env.NODE_OPTIONS) process.exit(9);\n" +
        "process.stdout.write(" +
        JSON.stringify(JSON.stringify(runtimeMetadata())) +
        ");",
    );
    await expect(
      resolvePinnedDaemonRuntimePath(file, "node", {
        FIXTURE_SECRET: "synthetic-not-forwarded",
        NODE_OPTIONS: "--require=/nonexistent/fixture.js",
      }),
    ).resolves.toBe(file);
  });

  it.each([
    ["old Node", runtimeMetadata("22.16.0"), /unsupported/],
    ["unsafe SQLite", runtimeMetadata("26.8.1", "3.51.0"), /unsupported/],
    ["malformed output", {}, /probe failed/],
  ])("refuses %s without selecting a replacement", async (_name, metadata, error) => {
    const file = runtimeFixture(
      "process.stdout.write(" + JSON.stringify(JSON.stringify(metadata)) + ");",
    );
    await expect(resolvePinnedDaemonRuntimePath(file, "node", {})).rejects.toThrow(error);
  });

  it("terminates a hung runtime probe", async () => {
    const file = runtimeFixture("setInterval(() => {}, 1000);");
    await expect(resolvePinnedDaemonRuntimePath(file, "node", {})).rejects.toThrow(/probe failed/);
  }, 15_000);

  it("rejects output beyond the bounded probe buffer", async () => {
    const file = runtimeFixture('process.stdout.write("x".repeat(2 * 1024 * 1024));');
    await expect(resolvePinnedDaemonRuntimePath(file, "node", {})).rejects.toThrow(/probe failed/);
  });

  it("rejects a mismatched runtime family before executing it", async () => {
    const file = runtimeFixture('throw new Error("must not execute");', "bun");
    await expect(resolvePinnedDaemonRuntimePath(file, "node", {})).rejects.toThrow(
      /must name a node/,
    );
  });

  it("rejects a removed pin and a directory", async () => {
    const file = runtimeFixture("");
    fs.unlinkSync(file);
    await expect(resolvePinnedDaemonRuntimePath(file, "node", {})).rejects.toThrow(
      /not executable/,
    );
    fs.mkdirSync(file);
    await expect(resolvePinnedDaemonRuntimePath(file, "node", {})).rejects.toThrow(
      /not executable/,
    );
  });
});

describe("runtime pin service metadata", () => {
  it.each([
    ["darwin", "/Users/example/Runtime Tools/bin/node"],
    ["linux", "/opt/runtime tools/bin/bun"],
    ["win32", "C:\\Runtime Tools\\node.exe"],
  ] as const)(
    "does not export an unmerged runtime pin environment contract for %s",
    (platform, pin) => {
      const env = {
        HOME: "/fixture",
        OPENCLAW_STATE_DIR: "/fixture/state",
        OPENCLAW_DAEMON_RUNTIME_PATH: pin,
      };
      for (const result of [
        buildServiceEnvironment({ env, port: 18789, platform }),
        buildNodeServiceEnvironment({ env, platform }),
      ]) {
        expect(result).not.toHaveProperty("OPENCLAW_DAEMON_RUNTIME_PATH");
        expect(result.OPENCLAW_STATE_DIR).toBe("/fixture/state");
      }
    },
  );
});
