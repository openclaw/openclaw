import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { auditGatewayInstallPreservation } from "../daemon/service-audit-preservation.js";
import type { ServiceDefinitionDrift } from "../daemon/service-audit-types.js";
import { buildGatewayInstallPlan } from "./daemon-install-helpers.js";

const mocks = vi.hoisted(() => ({
  buildServiceEnvironment: vi.fn(),
  resolveGatewayProgramArguments: vi.fn(),
}));
vi.mock("./daemon-install-auth-profiles-source.runtime.js", () => ({
  hasAnyAuthProfileStoreSource: () => false,
}));
vi.mock("../daemon/runtime-paths.js", () => ({
  resolvePreferredNodePath: async () => "/opt/node",
  resolvePreferredBunPath: async () => undefined,
  resolveSystemNodeInfo: async () => ({
    path: "/opt/node",
    version: "24.19.0",
    status: "supported",
  }),
  renderSystemNodeWarning: () => undefined,
}));
vi.mock("../daemon/program-args.js", () => ({
  OPENCLAW_WRAPPER_ENV_KEY: "OPENCLAW_WRAPPER",
  resolveGatewayProgramArguments: mocks.resolveGatewayProgramArguments,
  resolveOpenClawWrapperPath: async () => undefined,
}));
vi.mock("../daemon/service-env.js", () => ({
  buildServiceEnvironment: mocks.buildServiceEnvironment,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
let tmpDir: string;
beforeEach(() => {
  tmpDir = dirs.make("daemon-install-path-");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function mockNodeGatewayPlanFixture(params: { serviceEnvironment: Record<string, string> }) {
  mocks.resolveGatewayProgramArguments.mockResolvedValue({
    programArguments: ["node", "gateway"],
    workingDirectory: "/Users/me",
  });
  mocks.buildServiceEnvironment.mockReturnValue(params.serviceEnvironment);
}

describe("Gateway install PATH preservation", () => {
  it("preserves safe custom vars from an existing service env and merges PATH", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/from-service",
        OPENCLAW_PORT: "3000",
        PATH: "/managed/bin:/usr/bin",
        TMPDIR: "/tmp",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      port: 3000,
      runtime: "node",
      platform: "linux",
      existingEnvironment: {
        PATH: [
          ".",
          "/tmp/evil",
          "/proc/self/cwd/evil-bin",
          "/proc/thread-self/cwd/evil-bin",
          "/proc/12345/cwd/evil-bin",
          "/proc/self/root/evil-bin",
          `${process.cwd()}/evil-bin`,
          "/custom/go/bin",
          "/usr/bin",
        ].join(path.delimiter),
        GOBIN: "/Users/test/.local/gopath/bin",
        BLOGWATCHER_HOME: "/Users/test/.blogwatcher",
        NODE_OPTIONS: "--require /tmp/evil.js",
        GOPATH: "/Users/test/.local/gopath",
        OPENCLAW_SERVICE_MARKER: "openclaw",
      },
    });

    expect(plan.environment.PATH).toBe("/managed/bin:/custom/go/bin:/usr/bin");
    expect(plan.environment.GOBIN).toBe("/Users/test/.local/gopath/bin");
    expect(plan.environment.BLOGWATCHER_HOME).toBe("/Users/test/.blogwatcher");
    expect(plan.environment.NODE_OPTIONS).toBeUndefined();
    expect(plan.environment.GOPATH).toBeUndefined();
    expect(plan.environment.OPENCLAW_SERVICE_MARKER).toBeUndefined();
  });

  it("drops stale non-minimal PATH entries from an existing service env", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/from-service",
        OPENCLAW_PORT: "3000",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        TMPDIR: "/tmp",
      },
    });

    // Avoid macOS /home autofs lookups while exercising the same user-tool paths.
    const home = "/Users/testuser";
    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      port: 3000,
      runtime: "node",
      platform: "linux",
      existingEnvironment: {
        PATH: [
          `${home}/.volta/bin`,
          `${home}/.asdf/shims`,
          `${home}/.nvm/current/bin`,
          `${home}/.local/share/fnm/aliases/default/bin`,
          `${home}/.local/share/fnm/current/bin`,
          `${home}/.fnm/aliases/default/bin`,
          `${home}/.fnm/current/bin`,
          `${home}/.local/share/pnpm`,
          "/opt/pnpm/bin",
          "/custom/go/bin",
          "/usr/bin",
        ].join(path.delimiter),
      },
    });

    expect(plan.environment.PATH).toBe("/usr/local/bin:/bin:/custom/go/bin:/usr/bin");
  });

  it("drops existing PATH entries that resolve through symlinks into temp dirs", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/from-service",
        OPENCLAW_PORT: "3000",
        PATH: "/managed/bin:/usr/bin",
        TMPDIR: "/tmp",
      },
    });
    const realpathNative = vi.spyOn(fs.realpathSync, "native").mockImplementation((candidate) => {
      const value = String(candidate);
      if (value === "/opt/safe/bin") {
        return "/tmp/evil/bin";
      }
      if (value === "/opt/safe") {
        return "/tmp/evil";
      }
      if (value === "/opt/safe/missing-bin") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return value;
    });

    try {
      const plan = await buildGatewayInstallPlan({
        env: { HOME: tmpDir },
        port: 3000,
        runtime: "node",
        platform: "linux",
        existingEnvironment: {
          PATH: "/opt/safe/bin:/opt/safe/missing-bin:/custom/go/bin:/usr/bin",
        },
      });

      expect(plan.environment.PATH).toBe("/managed/bin:/custom/go/bin:/usr/bin");
    } finally {
      realpathNative.mockRestore();
    }
  });

  it("drops workspace-derived PATH entries even when HOME equals the install cwd", async () => {
    const cwd = process.cwd();
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: cwd,
        OPENCLAW_PORT: "3000",
        PATH: "/managed/bin:/usr/bin",
        TMPDIR: "/tmp",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: cwd },
      port: 3000,
      runtime: "node",
      platform: "linux",
      existingEnvironment: {
        PATH: `${cwd}/evil-bin:/custom/go/bin:/usr/bin`,
      },
    });

    expect(plan.environment.PATH).toBe("/managed/bin:/custom/go/bin:/usr/bin");
  });

  it("drops keys that were previously tracked as managed service env", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/from-service",
        OPENCLAW_PORT: "3000",
        PATH: "/managed/bin:/usr/bin",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      port: 3000,
      runtime: "node",
      platform: "linux",
      existingEnvironment: {
        PATH: "/custom/go/bin:/usr/bin",
        GOBIN: "/Users/test/.local/gopath/bin",
        BLOGWATCHER_HOME: "/Users/test/.blogwatcher",
        GOPATH: "/Users/test/.local/gopath",
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "GOBIN,GOPATH",
      },
    });

    expect(plan.environment.PATH).toBe("/managed/bin:/custom/go/bin:/usr/bin");
    expect(plan.environment.GOBIN).toBeUndefined();
    expect(plan.environment.BLOGWATCHER_HOME).toBe("/Users/test/.blogwatcher");
    expect(plan.environment.GOPATH).toBeUndefined();
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBeUndefined();
  });

  it.each([
    {
      name: "custom tools before shared system tools",
      existingPath: "/custom/go/bin:/usr/bin",
      nextPath: "/managed/bin:/usr/bin",
      expectedPath: "/managed/bin:/custom/go/bin:/usr/bin",
    },
    {
      name: "repeated safe entries",
      existingPath: "/custom/go/bin:/usr/bin:/custom/go/bin",
      nextPath: "/managed/bin:/usr/bin",
      expectedPath: "/managed/bin:/custom/go/bin:/usr/bin:/custom/go/bin",
    },
    {
      name: "a new installation with a shared runtime",
      existingPath: "/opt/node/bin:/opt/openclaw-a/bin:/usr/local/bin:/usr/bin:/bin",
      nextPath: "/opt/node/bin:/opt/openclaw-b/bin:/usr/local/bin:/usr/bin:/bin",
      expectedPath:
        "/opt/openclaw-b/bin:/opt/node/bin:/opt/openclaw-a/bin:/usr/local/bin:/usr/bin:/bin",
    },
    {
      name: "regenerated HOME tools beneath the service temporary root",
      existingPath: "/usr/bin:/tmp/service-home/.local/bin",
      nextPath: "/usr/bin:/tmp/service-home/.local/bin",
      expectedPath: "/usr/bin:/tmp/service-home/.local/bin",
    },
    {
      name: "equivalent regenerated entries retaining existing precedence",
      existingPath: "/custom/go/bin:/usr/bin",
      nextPath: "/usr//bin:/usr/bin",
      expectedPath: "/custom/go/bin:/usr/bin",
    },
    {
      name: "distinct POSIX directories containing backslashes",
      existingPath: "/custom/go/bin:/opt/a\\b:/opt/a/b",
      nextPath: "/opt/a\\b:/opt/a/b",
      expectedPath: "/custom/go/bin:/opt/a\\b:/opt/a/b",
    },
    {
      name: "generated trailing-slash aliases retaining existing precedence",
      existingPath: "/custom/go/bin:/usr/bin",
      nextPath: "/usr/bin/:/usr/bin",
      expectedPath: "/custom/go/bin:/usr/bin",
    },
    {
      name: "existing trailing-slash spellings retained for the audit",
      existingPath: "/custom/go/bin:/usr/bin/:/usr/bin",
      nextPath: "/usr/bin",
      expectedPath: "/custom/go/bin:/usr/bin/:/usr/bin",
    },
  ])("preserves existing PATH order through install-plan audit: $name", async (testCase) => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: { PATH: testCase.nextPath, TMPDIR: "/tmp" },
    });
    mocks.resolveGatewayProgramArguments.mockResolvedValue({
      programArguments: ["/opt/node/bin/node", "/opt/openclaw-b/dist/index.js", "gateway"],
    });
    const existingCommand = {
      programArguments: ["/opt/node/bin/node", "/opt/openclaw-a/dist/index.js", "gateway"],
      environment: { PATH: testCase.existingPath },
    };
    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      port: 3000,
      runtime: "node",
      platform: "linux",
      existingCommand,
      existingEnvironment: existingCommand.environment,
    });
    const findings: ServiceDefinitionDrift[] = [];
    auditGatewayInstallPreservation(existingCommand, plan, "linux", findings);

    expect(findings).toEqual([]);
    expect(plan.environment.PATH).toBe(testCase.expectedPath);
  });

  it("does not preserve existing PATH entries for macOS LaunchAgents", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/from-service",
        OPENCLAW_PORT: "3000",
        PATH: "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: "/tmp",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: { HOME: tmpDir },
      port: 3000,
      runtime: "node",
      platform: "darwin",
      existingEnvironment: {
        PATH: [
          "/Users/test/.volta/bin",
          "/Users/test/.asdf/shims",
          "/Users/test/Library/Application Support/fnm/aliases/default/bin",
          "/Users/test/Library/pnpm",
          "/custom/go/bin",
          "/usr/bin",
        ].join(path.delimiter),
      },
    });

    expect(plan.environment.PATH).toBe(
      "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
  });
});
