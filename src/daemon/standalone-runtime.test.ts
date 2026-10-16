import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveDaemonInstallRuntimeInputs } from "../commands/daemon-install-plan.shared.js";
import { resolveGatewayDaemonRuntime } from "../commands/daemon-runtime.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { resolveGatewayProgramArguments, resolveNodeProgramArguments } from "./program-args.js";
import * as runtimePaths from "./runtime-paths.js";
import { resolveBunRuntimeInfo, resolvePinnedDaemonRuntimePath } from "./runtime-paths.js";
import { auditGatewayRuntime } from "./service-audit-runtime.js";
import type { ServiceConfigIssue } from "./service-audit-types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const version = "2026.10.14";

function standaloneFixture(options: { reportedVersion?: string; manifest?: unknown } = {}) {
  const root = tempDirs.make("standalone-service-");
  const executable = path.join(root, "custom-runtime");
  fs.writeFileSync(
    executable,
    `#!${process.execPath}\n` +
      'if (process.argv[2] !== "--version" || process.env.FIXTURE_SECRET || process.env.NODE_OPTIONS) process.exit(9);\n' +
      `console.log("OpenClaw ${options.reportedVersion ?? version} (1234567)");\n`,
    { mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(root, "manifest.json"),
    JSON.stringify(
      options.manifest ?? {
        schemaVersion: 1,
        mode: "jit",
        executable: { path: "custom-runtime" },
        runtime: { path: "runtime" },
        openclaw: { version },
        bun: { version: "1.4.3" },
      },
    ),
  );
  return executable;
}

describe.skipIf(process.platform === "win32")("standalone service runtime", () => {
  it("uses the embedded runtime identity when planning the current executable's service", async () => {
    const executable = standaloneFixture();
    const originalExecPath = process.execPath;
    process.execPath = executable;
    vi.stubGlobal(
      "__openclawStandaloneRootUrl",
      pathToFileURL(path.join(path.dirname(executable), "runtime")).href,
    );
    fs.unlinkSync(path.join(path.dirname(executable), "manifest.json"));
    try {
      expect(resolveGatewayDaemonRuntime([executable, "gateway"])).toBe("bun");
      await expect(
        resolveGatewayProgramArguments({
          runtime: "bun",
          runtimePath: executable,
          dev: true,
          port: 19523,
        }),
      ).resolves.toEqual({ programArguments: [executable, "gateway", "--port", "19523"] });
    } finally {
      process.execPath = originalExecPath;
      vi.unstubAllGlobals();
    }
  });

  it.each(["implicit", "explicit-node", "retained-path", "saved-pin"] as const)(
    "preserves %s runtime selection when a supported host Node is available",
    async (selection) => {
      const executable = standaloneFixture();
      const hostNode = resolveTestNodeExecPath();
      const discoverNode = vi
        .spyOn(runtimePaths, "resolvePreferredNodePath")
        .mockResolvedValue(hostNode);
      const originalExecPath = process.execPath;
      process.execPath = executable;
      try {
        await expect(
          resolveDaemonInstallRuntimeInputs({
            env: {},
            runtime: "node",
            runtimeExplicit: selection === "explicit-node",
            ...(selection === "retained-path" ? { runtimePath: hostNode } : {}),
            ...(selection === "saved-pin" ? { pinnedRuntimePath: hostNode } : {}),
            devMode: false,
          }),
        ).resolves.toEqual({
          devMode: false,
          runtime: selection === "implicit" ? "bun" : "node",
          runtimePath: selection === "implicit" ? executable : hostNode,
        });
      } finally {
        process.execPath = originalExecPath;
        discoverNode.mockRestore();
      }
    },
  );

  it("probes the manifest executable with --version using the sanitized environment", async () => {
    const executable = standaloneFixture();
    await expect(
      resolvePinnedDaemonRuntimePath(executable, "bun", {
        FIXTURE_SECRET: "synthetic-not-forwarded",
        NODE_OPTIONS: "--require=/nonexistent/fixture.js",
      }),
    ).resolves.toBe(executable);
    expect(resolveGatewayDaemonRuntime([executable, "gateway"])).toBe("bun");
    await expect(resolveBunRuntimeInfo(executable)).resolves.toMatchObject({
      status: "supported",
      version: "1.4.3",
    });
  });

  it("constructs direct Gateway and node service commands without a script entrypoint", async () => {
    const executable = standaloneFixture();
    await expect(
      resolveGatewayProgramArguments({
        runtime: "bun",
        runtimePath: executable,
        dev: true,
        port: 19523,
        allowUnconfigured: true,
      }),
    ).resolves.toEqual({
      programArguments: [executable, "gateway", "--port", "19523", "--allow-unconfigured"],
    });
    await expect(
      resolveNodeProgramArguments({
        runtime: "bun",
        runtimePath: executable,
        host: "127.0.0.1",
        port: 19523,
        tls: false,
      }),
    ).resolves.toEqual({
      programArguments: [
        executable,
        "node",
        "run",
        "--host",
        "127.0.0.1",
        "--port",
        "19523",
        "--no-tls",
      ],
    });
  });

  it("rejects a version mismatch without using an interpreter probe", async () => {
    const executable = standaloneFixture({ reportedVersion: "2026.9.1" });
    await expect(resolvePinnedDaemonRuntimePath(executable, "bun", {})).rejects.toThrow(
      /version.*manifest/i,
    );
    const issues: ServiceConfigIssue[] = [];
    await auditGatewayRuntime(
      {},
      { programArguments: [executable, "gateway"] },
      issues,
      process.platform,
    );
    expect(issues).toMatchObject([{ code: "gateway-runtime-probe-failed" }]);
  });

  it.each([
    {
      schemaVersion: 1,
      mode: "jit",
      executable: { path: "other" },
      runtime: { path: "runtime" },
      openclaw: { version },
      bun: { version: "1.4.3" },
    },
    { schemaVersion: 99 },
  ])("refuses an invalid adjacent manifest", async (manifest) => {
    const executable = standaloneFixture({ manifest });
    await expect(resolvePinnedDaemonRuntimePath(executable, "bun", {})).rejects.toThrow(
      /manifest/i,
    );
  });
});
