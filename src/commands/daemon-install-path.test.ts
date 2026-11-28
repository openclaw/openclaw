import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type * as ProgramArgs from "../daemon/program-args.js";
import { auditGatewayInstallPreservation } from "../daemon/service-audit-preservation.js";
import type { ServiceDefinitionDrift } from "../daemon/service-audit-types.js";
import { gitReleaseForwardingEntry } from "../infra/git-release-paths.js";
import { buildGatewayInstallPlan } from "./daemon-install-helpers.js";

const mocks = vi.hoisted(() => ({
  buildServiceEnvironment: vi.fn(),
  resolveGatewayProgramArguments: vi.fn(),
}));
// mock-isolation: Executable-path planning excludes host credentials and their service-env effects.
vi.mock("./daemon-install-auth-profiles-source.runtime.js", () => ({
  hasAnyAuthProfileStoreSourceAsync: async () => false,
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

describe("Gateway install resident entrypoint", () => {
  it.each(["release", "pending", "legacy", "orphan"] as const)(
    "selects the resident owner from the captured install environment (%s)",
    async (layout) => {
      const originalArgv = process.argv;
      const originalState = process.env.OPENCLAW_STATE_DIR;
      const { resolveGatewayProgramArguments } = await vi.importActual<typeof ProgramArgs>(
        "../daemon/program-args.js",
      );
      mocks.resolveGatewayProgramArguments.mockImplementation(resolveGatewayProgramArguments);
      try {
        const npmRoot = path.join(tmpDir, "npm", "lib", "node_modules", "openclaw");
        fs.mkdirSync(path.join(npmRoot, "dist"), { recursive: true });
        fs.writeFileSync(path.join(npmRoot, "dist", "index.js"), "");
        fs.writeFileSync(path.join(npmRoot, "openclaw.mjs"), "");
        process.argv = [process.execPath, path.join(npmRoot, "dist", "index.js")];
        for (const profile of ["first", "second"]) {
          const state = path.join(tmpDir, profile);
          const prefix = path.join(state, "git-install");
          const release = path.join(prefix, "releases", "active", "openclaw");
          const launcher = path.join(prefix, "openclaw-launcher.mjs");
          fs.mkdirSync(release, { recursive: true });
          if (layout !== "orphan") {
            fs.symlinkSync(
              layout === "release" ? release : npmRoot,
              path.join(prefix, "openclaw"),
              "junction",
            );
          }
          if (layout === "pending") {
            fs.writeFileSync(
              path.join(prefix, "releases", ".trial"),
              JSON.stringify({
                v: 2,
                runId: "first-conversion",
                phase: "pending",
                target: "releases/active/openclaw",
                previous: npmRoot,
                version: "1.2.3",
                createdAt: 0,
                attempts: 0,
              }),
            );
          }
          if (layout === "legacy") {
            fs.writeFileSync(
              path.join(npmRoot, "openclaw.mjs"),
              gitReleaseForwardingEntry(launcher),
            );
          }
          fs.writeFileSync(launcher, "");
          const plan = await buildPlan({
            env: { HOME: tmpDir, OPENCLAW_STATE_DIR: state, OPENCLAW_PROFILE: profile },
            devMode: false,
            runtimePath: process.execPath,
            config: {},
          });
          expect(plan.programArguments.at(-4)).toBe(
            layout === "orphan" ? path.join(npmRoot, "dist", "index.js") : launcher,
          );
          expect(process.env.OPENCLAW_STATE_DIR).toBe(originalState);
        }
      } finally {
        process.argv = originalArgv;
      }
    },
  );
});

describe("Gateway install PATH preservation", () => {
  it.skipIf(process.platform === "win32")(
    "keeps the installed macOS CLI directory ahead of an unchanged Homebrew Node through audit",
    async () => {
      const serviceEnv = await vi.importActual<typeof import("../daemon/service-env.js")>(
        "../daemon/service-env.js",
      );
      mocks.buildServiceEnvironment.mockImplementation(serviceEnv.buildServiceEnvironment);
      const executable = "/opt/homebrew/bin/node";
      const programArguments = [executable, "/opt/openclaw/dist/index.js", "gateway"];
      mocks.resolveGatewayProgramArguments.mockResolvedValue({ programArguments });

      const existingCommand = {
        programArguments,
        environment: {
          PATH: "/Users/test/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        },
      };
      const plan = await buildPlan({
        platform: "darwin",
        runtimePath: executable,
        serviceCli: { executable, entrypoint: "/Users/test/.local/bin/openclaw" },
        existingCommand,
        existingEnvironment: existingCommand.environment,
      });
      const findings: ServiceDefinitionDrift[] = [];
      auditGatewayInstallPreservation(existingCommand, plan, "darwin", findings);

      expect(findings).toEqual([]);
      expect(plan.environment.PATH).toBe(existingCommand.environment.PATH);
    },
  );

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

  it.skipIf(process.platform === "win32")(
    "keeps macOS PATH precedence through audit when the leading Node runtime directory moves",
    async () => {
      mocks.buildServiceEnvironment.mockReturnValue({
        PATH: "/opt/node-b/bin:/opt/homebrew/bin:/Users/test/.local/bin:/usr/bin",
        TMPDIR: "/tmp",
      });
      mocks.resolveGatewayProgramArguments.mockResolvedValue({
        programArguments: ["/opt/node-b/bin/node", "/opt/openclaw/dist/index.js", "gateway"],
      });
      const existingCommand = {
        programArguments: ["/opt/node-a/bin/node", "/opt/openclaw/dist/index.js", "gateway"],
        environment: { PATH: "/opt/node-a/bin:/Users/test/.local/bin:/opt/homebrew/bin:/usr/bin" },
      };
      const plan = await buildPlan({
        platform: "darwin",
        existingCommand,
        existingEnvironment: existingCommand.environment,
      });
      const findings: ServiceDefinitionDrift[] = [];
      auditGatewayInstallPreservation(existingCommand, plan, "darwin", findings);

      expect(findings).toEqual([]);
      expect(plan.environment.PATH).toBe(
        "/opt/node-b/bin:/Users/test/.local/bin:/opt/homebrew/bin:/usr/bin",
      );
    },
  );
});

describe("Gateway allocator startup environment", () => {
  it.each([
    ["linux", undefined, undefined, undefined, "2"],
    ["linux", "4", undefined, undefined, "4"],
    ["linux", "0", undefined, undefined, "0"],
    ["linux", "", undefined, undefined, ""],
    ["linux", undefined, "6", undefined, "6"],
    ["linux", undefined, "2", "8", "8"],
    ["darwin", undefined, undefined, undefined, undefined],
    ["win32", undefined, undefined, undefined, undefined],
  ] as const)(
    "preserves allocator choices on %s (shell=%s, installed=%s, config=%s)",
    async (platform, shell, installed, configured, expected) => {
      const plan = await buildPlan({
        env: { HOME: tmpDir, MALLOC_ARENA_MAX: shell },
        platform,
        existingEnvironment: { MALLOC_ARENA_MAX: installed },
        config: configured === undefined ? {} : { env: { MALLOC_ARENA_MAX: configured } },
      });
      expect(plan.environment.MALLOC_ARENA_MAX).toBe(expected);
    },
  );

  it("uses the durable dotenv allocator choice before the Linux default", async () => {
    const stateDir = path.join(tmpDir, ".openclaw");
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(stateDir, ".env"), "MALLOC_ARENA_MAX=6\n");
    const plan = await buildPlan({ env: { HOME: tmpDir }, platform: "linux" });
    expect(plan.environment.MALLOC_ARENA_MAX).toBe("6");
  });
});
