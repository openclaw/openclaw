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
  mocks.resolveGatewayProgramArguments.mockResolvedValue({
    programArguments: ["node", "gateway"],
    workingDirectory: "/Users/me",
  });
  mocks.buildServiceEnvironment.mockReturnValue({
    HOME: "/from-service",
    OPENCLAW_PORT: "3000",
    PATH: "/managed/bin:/usr/bin",
    TMPDIR: "/tmp",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function buildPlan(params: Partial<Parameters<typeof buildGatewayInstallPlan>[0]>) {
  return buildGatewayInstallPlan({
    env: { HOME: tmpDir },
    port: 3000,
    runtime: "node",
    platform: "linux",
    ...params,
  });
}

describe("Gateway install PATH preservation", () => {
  it.skipIf(process.platform === "win32")(
    "derives a restored CLI plan from its retained package",
    async () => {
      const programArgs = await vi.importActual<typeof import("../daemon/program-args.js")>(
        "../daemon/program-args.js",
      );
      const serviceEnv = await vi.importActual<typeof import("../daemon/service-env.js")>(
        "../daemon/service-env.js",
      );
      mocks.resolveGatewayProgramArguments.mockImplementation(
        programArgs.resolveGatewayProgramArguments,
      );
      mocks.buildServiceEnvironment.mockImplementation(serviceEnv.buildServiceEnvironment);
      const root = fs.realpathSync(tmpDir);
      for (const name of ["installer", "retained"]) {
        const packageRoot = path.join(root, name);
        fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
        fs.mkdirSync(path.join(packageRoot, "bin"));
        fs.writeFileSync(path.join(packageRoot, "package.json"), '{"name":"openclaw"}');
        fs.writeFileSync(path.join(packageRoot, "openclaw.mjs"), "");
        fs.writeFileSync(path.join(packageRoot, "dist", "index.js"), "");
        fs.symlinkSync(
          path.join(packageRoot, "openclaw.mjs"),
          path.join(packageRoot, "bin", "openclaw"),
        );
      }
      const executable = path.join(root, "runtime", "node");
      const entrypoint = path.join(root, "retained", "openclaw.mjs");
      const originalArgv = process.argv;
      process.argv = [process.execPath, path.join(root, "installer", "src", "entry.ts")];
      try {
        const plan = await buildPlan({
          env: {
            HOME: root,
            PATH: [path.join(root, "installer", "bin"), path.join(root, "retained", "bin")].join(
              path.delimiter,
            ),
          },
          runtimePath: executable,
          serviceCli: { executable, entrypoint },
          platform: "darwin",
        });
        expect(plan.programArguments[0]).toBe(executable);
        expect(plan.programArguments).toContain(path.join(root, "retained", "dist", "index.js"));
        expect(plan.programArguments.join(" ")).not.toContain(path.join(root, "installer"));
        const pathDirs = plan.environment.PATH?.split(":");
        expect(pathDirs).toContain(path.join(root, "retained", "bin"));
        expect(pathDirs).toContain(path.dirname(executable));
        expect(pathDirs).not.toContain(path.join(root, "installer", "bin"));
      } finally {
        process.argv = originalArgv;
      }
    },
  );

  it.each([false, true])(
    "preserves custom vars excluding managed keys (tracked=%s)",
    async (managed) => {
      if (managed) {
        mocks.buildServiceEnvironment.mockReturnValue({
          HOME: "/from-service",
          OPENCLAW_PORT: "3000",
          PATH: "/managed/bin:/usr/bin",
        });
      }
      const plan = await buildPlan({
        existingEnvironment: {
          PATH: managed
            ? "/custom/go/bin:/usr/bin"
            : [
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
          GOPATH: "/Users/test/.local/gopath",
          ...(managed
            ? { OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "GOBIN,GOPATH" }
            : { NODE_OPTIONS: "--require /tmp/evil.js", OPENCLAW_SERVICE_MARKER: "openclaw" }),
        },
      });

      expect(plan.environment.PATH).toBe("/managed/bin:/custom/go/bin:/usr/bin");
      expect(plan.environment.GOBIN).toBe(managed ? undefined : "/Users/test/.local/gopath/bin");
      expect(plan.environment.BLOGWATCHER_HOME).toBe("/Users/test/.blogwatcher");
      expect(plan.environment.NODE_OPTIONS).toBeUndefined();
      expect(plan.environment.GOPATH).toBeUndefined();
      expect(plan.environment.OPENCLAW_SERVICE_MARKER).toBeUndefined();
      expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBeUndefined();
    },
  );

  it.each<{
    name: string;
    existingPath: string;
    nextPath: string;
    expectedPath: string;
    home?: string;
    platform?: NodeJS.Platform;
    setup?: () => void;
  }>([
    {
      name: "stale version-manager paths",
      nextPath: "/usr/local/bin:/usr/bin:/bin",
      existingPath: [
        ...[
          ".volta/bin",
          ".asdf/shims",
          ".nvm/current/bin",
          ".local/share/fnm/aliases/default/bin",
          ".local/share/fnm/current/bin",
          ".fnm/aliases/default/bin",
          ".fnm/current/bin",
          ".local/share/pnpm",
        ].map((suffix) => `/Users/testuser/${suffix}`),
        "/opt/pnpm/bin",
        "/custom/go/bin",
        "/usr/bin",
      ].join(path.delimiter),
      expectedPath: "/usr/local/bin:/bin:/custom/go/bin:/usr/bin",
    },
    {
      name: "symlinks into temporary directories",
      nextPath: "/managed/bin:/usr/bin",
      existingPath: "/opt/safe/bin:/opt/safe/missing-bin:/custom/go/bin:/usr/bin",
      expectedPath: "/managed/bin:/custom/go/bin:/usr/bin",
      setup: () => {
        vi.spyOn(fs.realpathSync, "native").mockImplementation((candidate) => {
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
      },
    },
    {
      name: "workspace paths when HOME equals the install cwd",
      home: process.cwd(),
      nextPath: "/managed/bin:/usr/bin",
      existingPath: `${process.cwd()}/evil-bin:/custom/go/bin:/usr/bin`,
      expectedPath: "/managed/bin:/custom/go/bin:/usr/bin",
    },
    {
      name: "existing paths for macOS LaunchAgents",
      platform: "darwin",
      nextPath: "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      existingPath: [
        "/Users/test/.volta/bin",
        "/Users/test/.asdf/shims",
        "/Users/test/Library/Application Support/fnm/aliases/default/bin",
        "/Users/test/Library/pnpm",
        "/custom/go/bin",
        "/usr/bin",
      ].join(path.delimiter),
      expectedPath:
        "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    },
  ])("drops $name", async ({ setup, home, platform, nextPath, existingPath, expectedPath }) => {
    setup?.();
    mocks.buildServiceEnvironment.mockReturnValue({
      HOME: home ?? "/from-service",
      OPENCLAW_PORT: "3000",
      PATH: nextPath,
      TMPDIR: "/tmp",
    });
    const plan = await buildPlan({
      env: { HOME: home ?? tmpDir },
      platform: platform ?? "linux",
      existingEnvironment: { PATH: existingPath },
    });
    expect(plan.environment.PATH).toBe(expectedPath);
  });

  it.each([
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
      name: "distinct POSIX directories containing backslashes",
      existingPath: "/custom/go/bin:/opt/a\\b:/opt/a/b",
      nextPath: "/opt/a\\b:/opt/a/b",
      expectedPath: "/custom/go/bin:/opt/a\\b:/opt/a/b",
    },
    {
      name: "generated path aliases retaining existing precedence",
      existingPath: "/custom/go/bin:/usr/bin",
      nextPath: "/usr//bin/:/usr/bin",
      expectedPath: "/custom/go/bin:/usr/bin",
    },
    {
      name: "existing trailing-slash spellings retained for the audit",
      existingPath: "/custom/go/bin:/usr/bin/:/usr/bin",
      nextPath: "/usr/bin",
      expectedPath: "/custom/go/bin:/usr/bin/:/usr/bin",
    },
  ])("preserves existing PATH order through install-plan audit: $name", async (testCase) => {
    mocks.buildServiceEnvironment.mockReturnValue({
      PATH: testCase.nextPath,
      TMPDIR: "/tmp",
    });
    mocks.resolveGatewayProgramArguments.mockResolvedValue({
      programArguments: ["/opt/node/bin/node", "/opt/openclaw-b/dist/index.js", "gateway"],
    });
    const existingCommand = {
      programArguments: ["/opt/node/bin/node", "/opt/openclaw-a/dist/index.js", "gateway"],
      environment: { PATH: testCase.existingPath },
    };
    const plan = await buildPlan({
      existingCommand,
      existingEnvironment: existingCommand.environment,
    });
    const findings: ServiceDefinitionDrift[] = [];
    auditGatewayInstallPreservation(existingCommand, plan, "linux", findings);

    expect(findings).toEqual([]);
    expect(plan.environment.PATH).toBe(testCase.expectedPath);
  });
});
