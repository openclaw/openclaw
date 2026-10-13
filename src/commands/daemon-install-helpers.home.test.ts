import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { mergeInstallInvocationEnv } from "../cli/daemon-cli/install.js";
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

const accountHome = "C:\\Users\\Gateway Fixture";
const otherHome = "C:\\Users\\Other Account";

describe("Gateway install account home preservation", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => vi.restoreAllMocks());

  async function replan(
    options: {
      previous?: string;
      current?: string;
      previousKey?: string;
      platform?: NodeJS.Platform;
      runtime?: "node" | "bun";
      fresh?: boolean;
      unavailable?: "account" | "directory";
    } = {},
  ) {
    const root = tempDirs.make("oc-plan-home-");
    const profile = path.join(root, "profile");
    const other = path.join(root, "other-profile");
    fs.mkdirSync(profile);
    fs.mkdirSync(other);
    const entrypoint = path.join(root, "dist", "index.js");
    fs.mkdirSync(path.dirname(entrypoint));
    fs.writeFileSync(entrypoint, "");
    const nodePath = path.join(root, "node.exe");
    const account = os.userInfo();
    vi.spyOn(os, "userInfo").mockImplementation(() => {
      if (options.unavailable === "account") {
        throw new Error("Account profile unavailable");
      }
      return { ...account, homedir: accountHome };
    });
    const stat = fs.statSync;
    // Only synthetic Windows profiles are mapped; plan and audit I/O stay real.
    vi.spyOn(fs, "statSync").mockImplementation((...args: Parameters<typeof fs.statSync>) => {
      if (args[0] === accountHome || args[0] === otherHome) {
        if (options.unavailable === "directory") {
          throw Object.assign(new Error("Profile access denied"), { code: "EACCES" });
        }
        args[0] = args[0] === accountHome ? profile : other;
      }
      return stat(...args);
    });
    const platform = options.platform ?? "win32";
    const originalEnv = {
      HOME: options.previous ?? accountHome,
      USERPROFILE: options.previous ?? accountHome,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    };
    const common = {
      authStore: { version: 1 as const, profiles: {} },
      config: {},
      port: 18789,
      platform,
      serviceCli: { executable: nodePath, entrypoint },
      runtimeExplicit: true,
    };
    const previous = await buildGatewayInstallPlan({
      ...common,
      env: originalEnv,
      runtime: "node",
      runtimePath: nodePath,
    });
    const current = {
      programArguments: previous.programArguments,
      workingDirectory: previous.workingDirectory,
      environment: Object.fromEntries(
        Object.entries(previous.environment).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    };
    if (options.previousKey) {
      current.environment[options.previousKey] = current.environment.HOME!;
      delete current.environment.HOME;
    }
    const { HOME: _home, ...withoutHome } = originalEnv;
    const env = mergeInstallInvocationEnv({
      env: { ...withoutHome, ...(options.current !== undefined ? { HOME: options.current } : {}) },
      existingServiceEnv: options.fresh ? undefined : current.environment,
      platform,
    });
    expect(env.HOME).toBe(options.current);
    const runtime = options.runtime ?? "bun";
    const proposed = await buildGatewayInstallPlan({
      ...common,
      env,
      runtime,
      runtimePath: runtime === "node" ? nodePath : path.join(root, "bun.exe"),
      ...(options.fresh
        ? {}
        : { existingCommand: current, existingEnvironment: current.environment }),
    });
    const findings: ServiceDefinitionDrift[] = [];
    if (!options.fresh) {
      auditGatewayInstallPreservation(current, proposed, platform, findings);
    }
    return { proposed, findings, env };
  }

  it.each(["node", "bun"] as const)(
    "retains the canonical account HOME when elevation omits it while selecting %s",
    async (runtime) => {
      const { proposed, findings, env } = await replan({ runtime });
      expect(proposed.environment.HOME).toBe(accountHome);
      expect(proposed.environmentValueSources?.HOME).toBe("inline");
      expect(findings).toEqual([]);
      expect(env.HOME).toBeUndefined();
    },
  );

  it("reads the installed Windows HOME key case-insensitively", async () => {
    const { proposed, findings } = await replan({ previousKey: "Home" });
    expect(proposed.environment.HOME).toBe(accountHome);
    expect(findings).toEqual([]);
  });

  it.each(["", "  ", otherHome])("does not replace an explicit HOME value %j", async (current) => {
    const { proposed, findings } = await replan({ current });
    expect(proposed.environment.HOME).toBe(current);
    expect(findings.map(({ key }) => key)).toContain("Environment.HOME");
  });

  it("does not trust a saved HOME or USERPROFILE for another account", async () => {
    const { proposed, findings } = await replan({ previous: otherHome });
    expect(proposed.environment.HOME).toBeUndefined();
    expect(findings.map(({ key }) => key)).toContain("Environment.HOME");
  });

  it.each(["account", "directory"] as const)(
    "keeps the strict audit when the %s identity is unavailable",
    async (unavailable) => {
      const { proposed, findings } = await replan({ unavailable });
      expect(proposed.environment.HOME).toBeUndefined();
      expect(findings.map(({ key }) => key)).toContain("Environment.HOME");
    },
  );

  it("does not synthesize HOME for a fresh installation", async () => {
    const { proposed } = await replan({ fresh: true });
    expect(proposed.environment.HOME).toBeUndefined();
  });

  it.each(["linux", "darwin"] as const)("leaves %s regeneration unchanged", async (platform) => {
    const { proposed, findings } = await replan({ platform });
    expect(proposed.environment.HOME).toBeUndefined();
    expect(findings.map(({ key }) => key)).toContain("Environment.HOME");
  });
});
