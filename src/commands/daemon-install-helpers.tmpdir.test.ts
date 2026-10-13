import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { auditGatewayInstallPreservation } from "../daemon/service-audit-preservation.js";
import type { ServiceDefinitionDrift } from "../daemon/service-audit-types.js";

vi.mock("../daemon/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/runtime-paths.js")>()),
  resolveSystemNodeInfo: async () => ({
    path: "/opt/node",
    version: "24.21.0",
    status: "supported",
  }),
}));

import { buildGatewayInstallPlan } from "./daemon-install-helpers.js";

const longTemp = "C:\\Users\\Gateway Fixture\\AppData\\Local\\Temp";
const shortTemp = "C:\\Users\\GATEWA~1\\AppData\\Local\\Temp";
const otherTemp = "C:\\Other\\Temp";
type TempCase = {
  name: string;
  previous?: string;
  proposed?: string;
  runtime?: "node" | "bun";
  previousKey?: string;
  unavailable?: "previous" | "proposed" | "stat";
  file?: boolean;
  identity?: "zero-inode" | "other-device" | "unsafe-number";
  retain?: boolean;
};

describe("Gateway install temporary directory preservation", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => vi.restoreAllMocks());

  async function replan(params: {
    home: string;
    previous: string;
    proposed: string;
    runtime?: "node" | "bun";
    previousKey?: string;
    platform?: "win32" | "linux";
  }) {
    const entrypoint = path.join(params.home, "dist", "index.js");
    fs.mkdirSync(path.dirname(entrypoint));
    fs.writeFileSync(entrypoint, "");
    const nodePath = path.join(params.home, "node.exe");
    const options = {
      env: { HOME: params.home },
      authStore: { version: 1 as const, profiles: {} },
      port: 18789,
      platform: params.platform ?? "win32",
      serviceCli: { executable: nodePath, entrypoint },
      runtimeExplicit: true,
    };
    const tmpdir = vi.spyOn(os, "tmpdir").mockReturnValue(params.previous);
    const previous = await buildGatewayInstallPlan({
      ...options,
      runtime: "node",
      runtimePath: nodePath,
    });
    const current = {
      programArguments: previous.programArguments,
      environment: Object.fromEntries(
        Object.entries(previous.environment).filter(
          (item): item is [string, string] => typeof item[1] === "string",
        ),
      ),
    };
    if (params.previousKey) {
      const tmpDir = current.environment.TMPDIR;
      if (tmpDir === undefined) {
        throw new Error("Expected the installed plan to contain TMPDIR");
      }
      current.environment[params.previousKey] = tmpDir;
      delete current.environment.TMPDIR;
    }
    tmpdir.mockReturnValue(params.proposed);
    const runtime = params.runtime ?? "bun";
    const proposed = await buildGatewayInstallPlan({
      ...options,
      runtime,
      runtimePath: runtime === "node" ? nodePath : path.join(params.home, "bun.exe"),
      existingCommand: current,
      existingEnvironment: current.environment,
    });
    const findings: ServiceDefinitionDrift[] = [];
    auditGatewayInstallPreservation(current, proposed, options.platform, findings);
    return { proposed, findings };
  }

  it.each<TempCase>([
    { name: "long to short when adopting Bun", retain: true },
    { name: "long to short when reinstalling Node", runtime: "node", retain: true },
    { name: "short to long", previous: shortTemp, proposed: longTemp, retain: true },
    { name: "case-insensitive installed environment key", previousKey: "TmpDir", retain: true },
    { name: "extended-length proposed spelling", proposed: `\\\\?\\${shortTemp}`, retain: true },
    { name: "different directory", proposed: otherTemp },
    { name: "missing installed directory", unavailable: "previous" },
    { name: "missing proposed directory", unavailable: "proposed" },
    { name: "uninspectable directory metadata", unavailable: "stat" },
    { name: "resolved regular file", file: true },
    { name: "unavailable inode identity", identity: "zero-inode" },
    { name: "same inode on different devices", identity: "other-device" },
    { name: "distinct inode identities beyond number precision", identity: "unsafe-number" },
    { name: "relative installed value", previous: "relative-temp" },
    { name: "drive-relative installed value", previous: "C:Temp" },
    { name: "rooted value without a drive", previous: "\\Temp" },
    { name: "relative proposed value", proposed: "relative-temp" },
    { name: "empty installed value", previous: "" },
  ])("retains only a verified equivalent Windows directory: $name", async (testCase) => {
    const home = tempDirs.make("oc-plan-tmpdir-");
    const directory = path.join(home, "real-temp");
    fs.mkdirSync(directory);
    const differentDirectory = path.join(home, "different-temp");
    fs.mkdirSync(differentDirectory);
    const file = path.join(home, "not-a-directory");
    fs.writeFileSync(file, "");
    const previous = testCase.previous ?? longTemp;
    const proposed = testCase.proposed ?? shortTemp;
    const stat = fs.statSync;
    // Only the synthetic Windows aliases use fixture observations; ordinary I/O stays real.
    vi.spyOn(fs, "statSync").mockImplementation((...args: Parameters<typeof fs.statSync>) => {
      const candidate = String(args[0]);
      if (candidate === previous || candidate === proposed) {
        if (
          (testCase.unavailable === "previous" && candidate === previous) ||
          (testCase.unavailable === "proposed" && candidate === proposed)
        ) {
          throw Object.assign(new Error("fixture directory missing"), { code: "ENOENT" });
        }
        if (testCase.unavailable === "stat") {
          throw Object.assign(new Error("fixture access denied"), { code: "EACCES" });
        }
        args[0] = testCase.file ? file : candidate === otherTemp ? differentDirectory : directory;
        const observed = stat(...args);
        if (observed && testCase.identity === "zero-inode") {
          observed.ino = typeof observed.ino === "bigint" ? 0n : 0;
        }
        if (observed && testCase.identity === "other-device" && candidate === proposed) {
          observed.dev = typeof observed.dev === "bigint" ? observed.dev + 1n : observed.dev + 1;
        }
        if (observed && testCase.identity === "unsafe-number") {
          const inode = 9_007_199_254_740_992n + (candidate === proposed ? 1n : 0n);
          observed.ino = typeof observed.ino === "bigint" ? inode : Number(inode);
        }
        return observed;
      }
      return stat(...args);
    });
    const result = await replan({ home, previous, proposed, ...testCase });
    expect(result.proposed.environment.TMPDIR).toBe(testCase.retain ? previous : proposed);
    expect(result.findings.map(({ key }) => key)).toEqual(
      testCase.retain ? [] : [`Environment.${testCase.previousKey ?? "TMPDIR"}`],
    );
    expect(result.proposed.environmentValueSources?.TMPDIR).toBe("inline");
  });

  it("keeps Linux regeneration and the strict audit unchanged for equivalent paths", async () => {
    const home = tempDirs.make("oc-plan-tmpdir-linux-");
    const previous = path.join(home, "real-temp");
    fs.mkdirSync(previous);
    const proposed = `${previous}${path.sep}.`;
    const result = await replan({ home, previous, proposed, runtime: "node", platform: "linux" });
    expect(result.proposed.environment.TMPDIR).toBe(proposed);
    expect(result.findings.map(({ key }) => key)).toEqual(["Environment.TMPDIR"]);
  });
});
