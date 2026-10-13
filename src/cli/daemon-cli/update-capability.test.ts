import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tryRunGatewayServiceUpdateCapabilityProbe } from "./update-capability.js";

afterEach(() => vi.restoreAllMocks());

describe("early service capability routing", () => {
  it.each([
    ["gateway", "install", "--update-executor", "check", "--json"],
    ["gateway", "restart", "--json", "--update-executor=check"],
    ["daemon", "stop", "--update-executor", "check"],
  ])("keeps the capability child alive until input admission: %j", async (...args) => {
    const entry = new URL("./update-capability.ts", import.meta.url).href;
    const script = `import {tryRunGatewayServiceUpdateCapabilityProbe} from ${JSON.stringify(entry)};
      await tryRunGatewayServiceUpdateCapabilityProbe(${JSON.stringify(["node", "openclaw", ...args])});
      process.stdout.write("\\nprobe returned");`;
    const child = spawn(
      process.execPath,
      ["--import", path.resolve("scripts/tsx.mjs"), "--input-type=module", "-e", script],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 },
    );
    const exited = once(child, "exit");
    const closed = once(child, "close");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    try {
      await Promise.race([
        once(child.stdout, "data"),
        exited.then(() => {
          throw new Error(`Capability probe exited before responding: ${stderr}`);
        }),
      ]);
      // The parent can still be resolving the spawned PID's start identity.
      await setTimeout(100);
      expect(stdout).not.toContain("probe returned");
      expect(child.exitCode, "Capability child exited before input admission").toBeNull();
      child.stdin.end();
      expect(await closed, stderr).toEqual([0, null]);
      expect(stdout).toBe(
        JSON.stringify({
          updateExecutor: "root-spawner-v1",
          targetRootBinding: true,
          definitionBackup: true,
          retainedOwnerBinding: true,
          originalDefinitionBinding: true,
          originalRuntimePinBinding: true,
        }) + "\nprobe returned",
      );
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  });

  it.each([
    ["gateway", "install"],
    ["gateway", "install", "--update-executor", "run"],
    ["gateway", "install", "--update-executor", "--json", "check"],
    ["gateway", "install", "--update-executor", "check", "--update-executor", "run"],
    ["gateway", "install", "--token", "--update-executor", "check"],
    ["gateway", "install", "--", "--update-executor", "check"],
    ["gateway", "install", "--update-executor", "check", "--unknown"],
    ["gateway", "status", "--update-executor", "check"],
    ["plugin", "install", "--update-executor", "check"],
  ])("leaves non-probes and validation to Commander: %j", async (...args) => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await tryRunGatewayServiceUpdateCapabilityProbe(["node", "openclaw", ...args])).toBe(
      false,
    );
    expect(output).not.toHaveBeenCalled();
  });
});
