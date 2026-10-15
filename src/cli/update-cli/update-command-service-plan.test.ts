import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveBunRuntimeInfo,
  resolveNodeRuntimeInfo,
  resolvePinnedDaemonRuntimePath,
} from "../../daemon/runtime-paths.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import { quoteCliArg, quotePowerShellArg } from "../quote-cli-arg.js";
import { resolveTargetNodeRuntime } from "./update-command-node-runtime-resolution.js";
import { resolvePackageRuntimePreflight } from "./update-command-runtime-preflight.js";
import {
  expectedPlainRecovery,
  unsupportedServiceRuntimeFixture,
} from "./update-command-runtime-recovery.test-support.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";

const refreshableService: PreManagedServiceStop = {
  stopped: false,
  inspected: true,
  runtimeInspected: true,
  running: true,
  serviceUpdateVerdict: {
    kind: "owned",
    root: "/fixture",
    fingerprint: "fixture",
    refreshDefinition: true,
  },
};

const probeState = vi.hoisted(() => ({ text: true, container: false }));
vi.mock("../../infra/container-environment.js", () => ({
  isContainerEnvironment: () => probeState.container,
}));
vi.mock("../../daemon/runtime-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../daemon/runtime-paths.js")>();
  return {
    ...actual,
    resolveBunRuntimeInfo: vi.fn(),
    resolveNodeRuntimeInfo: vi.fn(),
    resolvePinnedDaemonRuntimePath: vi.fn(),
  };
});
vi.mock("../../infra/package-update-activation-paths.js", () => ({
  capturePackageActivationRuntime: vi.fn((kind, executable) => ({
    kind,
    path: executable,
    identity: `fixture:${executable}`,
  })),
}));
vi.mock("./update-command-node-runtime-resolution.js", () => ({
  resolveTargetNodeRuntime: vi.fn(),
}));
vi.mock("../../../node-sqlite.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../node-sqlite.mjs")>();
  return {
    ...actual,
    detectCurrentSqliteCapabilities: async () => ({
      available: true,
      version: "3.51.3",
      text: probeState.text,
      blob: true,
      json: true,
    }),
  };
});

describe("package runtime compatibility guidance", () => {
  beforeEach(() => {
    vi.mocked(resolveBunRuntimeInfo).mockResolvedValue({
      status: "supported",
      version: "1.4.3",
      sqliteVersion: "3.51.3",
      nodeSharedSqlite: false,
      sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
    });
    vi.stubGlobal("process", {
      ...process,
      execPath: path.resolve("/fixture/node"),
      versions: { ...process.versions, node: "24.16.0", bun: undefined },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    probeState.text = true;
    probeState.container = false;
    vi.mocked(resolveNodeRuntimeInfo).mockReset();
    vi.mocked(resolveBunRuntimeInfo).mockReset();
    vi.mocked(resolvePinnedDaemonRuntimePath).mockReset();
    vi.mocked(resolveTargetNodeRuntime).mockReset();
  });

  it.each([
    "implicit current",

    "service library",
    "service failure",
  ] as const)(
    "validates the selected Bun and retains only its runtime environment: %s",
    async (selection) => {
      const current = selection.endsWith("current");
      const supported = selection !== "service failure";
      const executable = current ? "/fixture/app-runtime" : "/service/bin/bun";
      const nodeRunner = selection === "implicit current" ? undefined : executable;
      const processEnv = {
        OPENCLAW_SQLITE_LIBRARY: "/process/sqlite.dylib",
        HOMEBREW_PREFIX: "/process/homebrew",
      };
      const runtimeEnv = current
        ? processEnv
        : { OPENCLAW_SQLITE_LIBRARY: "/service/sqlite.dylib" };
      const serviceEnv = {
        ...runtimeEnv,
        OPENCLAW_GATEWAY_TOKEN: "synthetic-unrelated-secret",
        NODE_OPTIONS: "--require /unrelated/preload.cjs",
      };
      vi.stubGlobal("process", {
        ...process,
        env: current ? serviceEnv : processEnv,
        execPath: path.resolve("/fixture/app-runtime"),
        versions: { ...process.versions, bun: "1.4.3", node: "24.3.0" },
      });
      if (!current) {
        vi.mocked(resolveNodeRuntimeInfo).mockResolvedValue({
          status: "supported",
          version: "24.3.0",
          sqliteVersion: "3.51.3",
          nodeSharedSqlite: false,
          sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
        });
      }
      if (!supported) {
        vi.mocked(resolveBunRuntimeInfo).mockResolvedValue({
          status: "probe-failed",
          error: new Error("Bun 1.4.3+ with WAL-reset-safe node:sqlite is required."),
        });
      }
      const result = await resolvePackageRuntimePreflight({
        target: { version: "2027.1.0", nodeEngine: ">=90.0.0" },
        nodeRunner,
        service: { ...refreshableService, ...(current ? {} : { serviceEnv }) },
        shouldRestart: true,
        runtimeRecovery: { env: {}, installCommand: vi.fn() },
      });
      expect(result).toEqual(
        supported
          ? {
              ok: true,
              value: {
                ...(nodeRunner ? { nodeRunner } : {}),
                targetVersion: "2027.1.0",
                activationRuntime: {
                  kind: "bun",
                  path: executable,
                  identity: `fixture:${executable}`,
                  env: runtimeEnv,
                },
              },
            }
          : { ok: false, error: "Bun 1.4.3+ with WAL-reset-safe node:sqlite is required." },
      );
      expect(resolveBunRuntimeInfo).toHaveBeenCalledWith(executable, undefined, runtimeEnv);
      expect(resolveNodeRuntimeInfo).not.toHaveBeenCalled();
      expect(resolveTargetNodeRuntime).not.toHaveBeenCalled();
    },
  );

  it("does not offer the current Bun as a fallback for a managed Node service", async () => {
    vi.stubGlobal("process", {
      ...process,
      execPath: path.resolve("/fixture/app-runtime"),
      versions: { ...process.versions, bun: "1.4.3" },
    });
    vi.mocked(resolveNodeRuntimeInfo).mockResolvedValue(unsupportedServiceRuntimeFixture);
    vi.mocked(resolveTargetNodeRuntime).mockResolvedValue("/recovered/node");
    const result = await resolvePackageRuntimePreflight({
      target: { version: "2027.1.0", nodeEngine: ">=24.16.0" },
      nodeRunner: "/old/node",
      shouldRestart: true,
      alreadyCurrent: true,
      service: refreshableService,
      runtimeRecovery: { env: {} },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        nodeRunner: "/recovered/node",
        activationRuntime: {
          kind: "node",
          path: "/recovered/node",
          identity: "fixture:/recovered/node",
        },
        replacedNodeRunner: "/old/node",
        targetVersion: "2027.1.0",
      },
    });
    expect(vi.mocked(resolveNodeRuntimeInfo).mock.calls.map(([runner]) => runner)).toEqual([
      "/old/node",
    ]);
  });

  it.each([
    [null, "unspecified", "2026.9.4", "2026.9.4"],

    [">=24.16.0", "24.16.0", "2026.9.4-private-customer", "[redacted-version]"],
  ] as const)(
    "records inspected runtime facts for public refusal reports: %s / %s / %s",
    async (nodeEngine, _floor, version, publicVersion) => {
      vi.mocked(resolveNodeRuntimeInfo).mockResolvedValue({
        status: "probe-failed",
        error: new Error("probe timed out"),
      });
      const runtime = await resolvePackageRuntimePreflight({
        target: { version, nodeEngine },
        nodeRunner: "/fixture/private/node",
        timeoutMs: 321,
      });
      expect(resolveNodeRuntimeInfo).toHaveBeenCalledWith(
        "/fixture/private/node",
        process.env,
        321,
      );
      expect(runtime).toMatchObject({
        ok: false,
        error: expect.stringContaining("probe timed out"),
      });
      expect(runtime).toMatchObject({
        ok: false,
        failureFacts: expect.arrayContaining([
          expect.objectContaining({ check: "node-runtime", code: "node-runtime-preflight" }),
        ]),
      });
      if (runtime.ok) {
        throw new Error("Expected runtime refusal");
      }
      expect(runtime.failureFacts?.[0]?.message).toContain(`Required: openclaw@${version}`);
      const report = await prepareUpdateFailureReport({
        attemptId: "runtime-refusal",
        result: {
          status: "error",
          mode: "npm",
          durationMs: 0,
          steps: [
            {
              name: "node-runtime-preflight",
              command: "",
              cwd: "",
              durationMs: 0,
              exitCode: 1,
              failureFacts: runtime.failureFacts,
            },
          ],
        },
      });
      expect(report.body).not.toContain("private-customer");
      expect(report.body).toContain(`Target package: openclaw@${publicVersion}`);
      expect(report.body).toContain(
        `Required runtime: ${nodeEngine ? `Node ${nodeEngine}` : "a working Node runtime"}`,
      );
      expect(report.body).not.toContain("/fixture/private");
    },
  );

  it.each([["/source/node", null, "/fixture"]])(
    "keeps the CLI and owned service reachable after switching %s",
    async (nodeRunner, command, sourceRoot?: string) => {
      vi.mocked(resolveNodeRuntimeInfo).mockResolvedValue({
        status: "unsupported",
        version: "22.23.2",
        sqliteVersion: "3.51.3",
        nodeSharedSqlite: false,
        sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
      });
      const result = await resolvePackageRuntimePreflight({
        target: { version: "2026.9.4", nodeEngine: ">=24.16.0" },
        nodeRunner,
        sourceRoot,
        root: sourceRoot ?? "/fixture",
        alreadyCurrent: Boolean(sourceRoot),
        service: {
          ...refreshableService,
          serviceEnv: { OPENCLAW_PROFILE: "work", NVM_DIR: "/custom/node-manager" },
        },
      });
      const prefix = command === "volta install node@24.16.0" ? "volta run --node 24.16.0 " : "";
      const sourceEntry = path.join(sourceRoot ?? "/fixture", "openclaw.mjs");
      const cli = sourceEntry
        ? `node ${process.platform === "win32" ? quotePowerShellArg(sourceEntry) : quoteCliArg(sourceEntry)}`
        : "openclaw";
      expect(result).toMatchObject({
        ok: false,
        failureFacts: expect.arrayContaining([
          expect.objectContaining({ check: "node-runtime", code: "node-runtime-preflight" }),
        ]),
        recoverySteps: [
          {
            kind: "preserve-context",
            instruction:
              "Use the same service account and keep the existing OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH overrides throughout recovery.",
          },
          {
            kind: "preserve-context",
            command:
              "export OPENCLAW_PROFILE=work; unset OPENCLAW_HOME OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH OPENCLAW_GATEWAY_PORT OPENCLAW_LAUNCHD_LABEL OPENCLAW_SYSTEMD_UNIT OPENCLAW_WINDOWS_TASK_NAME OPENCLAW_WORKSPACE_DIR",
          },
          {
            kind: "select-runtime",
            instruction:
              "Install and select Node 24.16.0 using your system package manager or https://nodejs.org/en/download.",
          },
          {
            kind: "continue-update",
            command: `${prefix}${cli} --profile work update${sourceRoot ? "" : " --tag 2026.9.4"}`,
          },
        ],
      });
    },
  );

  it.each([true])(
    "preserves recorded selectors and wrapper ownership (wrapper=%s)",
    async (wrapper) => {
      vi.mocked(resolveNodeRuntimeInfo).mockResolvedValue({
        status: "unsupported",
        version: "22.23.2",
        sqliteVersion: "3.51.3",
        nodeSharedSqlite: false,
        sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
      });
      const result = await resolvePackageRuntimePreflight({
        target: { version: "2026.9.4", nodeEngine: ">=24.16.0" },
        nodeRunner: "/usr/bin/node",
        invocationCwd: "/service-launch",
        service: {
          ...refreshableService,
          serviceEnv: {
            OPENCLAW_STATE_DIR: "/service state",
            OPENCLAW_CONFIG_PATH: "config.json",
            OPENCLAW_SYSTEMD_UNIT: "custom-gateway.service",
            ...(wrapper ? { OPENCLAW_WRAPPER: "/operator/wrapper" } : {}),
            OPENCLAW_GATEWAY_TOKEN: "fixture-sensitive-value",
          },
        },
      });
      expect(result.ok).toBe(false);
      expect(result.recoverySteps?.[1]).toEqual({
        kind: "preserve-context",
        command:
          "export OPENCLAW_STATE_DIR='/service state' OPENCLAW_CONFIG_PATH=/service-launch/config.json OPENCLAW_SYSTEMD_UNIT=custom-gateway.service; unset OPENCLAW_HOME OPENCLAW_PROFILE OPENCLAW_GATEWAY_PORT OPENCLAW_LAUNCHD_LABEL OPENCLAW_WINDOWS_TASK_NAME OPENCLAW_WORKSPACE_DIR",
      });
      expect(result.recoverySteps?.at(-1)).toEqual({
        kind: "continue-update",
        instruction:
          "Run this installation's absolute openclaw.mjs launcher with the selected Node and the update command to recheck package and service ownership before installation.",
      });
      expect(JSON.stringify(result)).not.toContain("fixture-sensitive-value");
    },
  );

  it.each(["nvm"] as const)(
    "renders %s recovery for PowerShell 5.1 without shell interpolation",
    async (manager) => {
      vi.stubGlobal("process", { ...process, platform: "win32" });
      vi.mocked(resolveNodeRuntimeInfo).mockResolvedValue(unsupportedServiceRuntimeFixture);
      const result = await resolvePackageRuntimePreflight({
        target: { version: "2026.9.4", nodeEngine: ">=90.0.0" },
        nodeRunner: `/fixture/.${manager}/versions/node/v22.18.0/bin/node`,
        service: {
          ...refreshableService,
          serviceEnv: {
            OPENCLAW_STATE_DIR: "C:/service 'state'",
            OPENCLAW_CONFIG_PATH: "C:/service/config.json",
          },
        },
      });
      expect(result.recoverySteps?.[2]).toEqual({
        kind: "select-runtime",
        command: `${manager} install 90.0.0; if ($LASTEXITCODE -eq 0) { ${manager} use 90.0.0 }`,
      });
      expect(result.recoverySteps?.[1]).toEqual({
        kind: "preserve-context",
        command:
          "Remove-Item Env:OPENCLAW_HOME -ErrorAction SilentlyContinue; $env:OPENCLAW_STATE_DIR = 'C:/service ''state'''; $env:OPENCLAW_CONFIG_PATH = 'C:/service/config.json'; Remove-Item Env:OPENCLAW_PROFILE -ErrorAction SilentlyContinue; Remove-Item Env:OPENCLAW_GATEWAY_PORT -ErrorAction SilentlyContinue; Remove-Item Env:OPENCLAW_LAUNCHD_LABEL -ErrorAction SilentlyContinue; Remove-Item Env:OPENCLAW_SYSTEMD_UNIT -ErrorAction SilentlyContinue; Remove-Item Env:OPENCLAW_WINDOWS_TASK_NAME -ErrorAction SilentlyContinue; Remove-Item Env:OPENCLAW_WORKSPACE_DIR -ErrorAction SilentlyContinue",
      });
    },
  );

  it.each([
    {
      version: "26.8.1",
      restart: true,
      oldNode: "22.23.1",
      runner: "/old/node",
      target: "2027.1.0",
      error: null,
    },
  ])(
    "admits only a lossless compatible fallback $version when restart=$restart",
    async ({ version, restart, oldNode, runner, target, error }) => {
      const sqliteProbe = {
        available: true,
        version: "3.51.3",
        text: true,
        blob: true,
        json: true,
      };
      vi.mocked(resolveNodeRuntimeInfo)
        .mockResolvedValueOnce({
          status: "unsupported",
          version: oldNode,
          sqliteVersion: "3.51.3",
          nodeSharedSqlite: false,
          sqliteProbe: { ...sqliteProbe, text: false },
          capabilityError: "broken TEXT decoder",
        })
        .mockResolvedValueOnce({
          status: "supported",
          version,
          sqliteVersion: "3.51.3",
          nodeSharedSqlite: false,
          sqliteProbe,
        });
      const result = await resolvePackageRuntimePreflight({
        target: { version: target, nodeEngine: ">=24.16.0 <25 || >=26.1.0" },
        nodeRunner: runner,
        shouldRestart: restart,
        alreadyCurrent: true,
        service: refreshableService,
      });
      expect(result).toEqual(
        error
          ? expect.objectContaining({
              ok: false,
              error: expect.stringContaining(error),
            })
          : {
              ok: true,
              value: {
                nodeRunner: process.execPath,
                activationRuntime: {
                  kind: "node",
                  path: process.execPath,
                  identity: `fixture:${process.execPath}`,
                },
                replacedNodeRunner: runner,
                targetVersion: target,
              },
            },
      );
    },
  );

  it("checks installed package engines when registry target metadata is absent", async () => {
    await withTempDir("openclaw-runtime-target-", async (root) => {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ version: "2027.1.0", engines: { node: ">=90.0.0" } }),
      );
      expect(await resolvePackageRuntimePreflight({ installedRoot: root })).toMatchObject({
        ok: false,
        error: expect.stringContaining("Node >=90.0.0"),
      });
    });
  });
  it.each(["22.23.2"])("renders the target engine range for unsupported Node %s", async (node) => {
    probeState.text = false;
    vi.stubGlobal("process", {
      ...process,
      execPath: path.resolve("/fixture/node"),
      versions: { ...process.versions, node },
    });
    const engine = ">=24.16.0 <25 || >=26.1.0";
    const result = await resolvePackageRuntimePreflight({
      target: { version: "2026.9.3", nodeEngine: engine },
      root: path.resolve("/fixture/cli"),
      service: refreshableService,
    });
    if (result.ok) {
      throw new Error("Expected runtime refusal");
    }
    expect(result.error).toContain(`Node ${node} at ${process.execPath}`);
    expect(result.error).toContain(`Update install root: ${path.resolve("/fixture/cli")}`);
    expect(result.error).toContain(path.resolve("/fixture/cli/openclaw.mjs"));
    expect(result.error).toContain(`Gateway install root: ${path.resolve("/fixture")}`);
    expect(result.error).toContain("differs from");
    expect(result.error).toContain("Failing check node-runtime");
    expect(result.failureFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: "node-runtime",
          message: expect.stringContaining(engine),
        }),
        expect.objectContaining({
          check: "node-runtime",
          message: expect.stringContaining(`detected: Node ${node} at [redacted-path]`),
        }),
      ]),
    );
    expect(result.failureFacts?.length).toBeLessThanOrEqual(5);
    expect(result).toMatchObject({
      ok: false,
      failureFacts: expect.arrayContaining([
        expect.objectContaining({
          check: "node-runtime",
          code: "node-runtime-preflight",
          affectedKey: "engines.node",
          message: `Required: openclaw@2026.9.3 Node ${engine}; detected: Node ${node} at [redacted-path]`,
        }),
      ]),
      error: expect.stringContaining(
        [
          `Node ${node}: node:sqlite truncates TEXT at embedded NUL (nodejs/node#61954); use 24.16+/26.1+ or a build with the fix`,
          expectedPlainRecovery("2026.9.3", "24.16.0", "refresh", "", path.resolve("/fixture/cli")),
        ].join("\n"),
      ),
    });
  });

  for (const { name, engine, minimum } of [
    {
      name: "reports incompatibility when Node exceeds an exclusive upper bound",
      engine: ">=22.22.3 <23",
      minimum: null,
    },
  ]) {
    it(name, async () => {
      const version = "2027.1.0";
      if (minimum) {
        vi.stubGlobal("process", { ...process, execPath: path.resolve("/fixture/node") });
      }
      const result = await resolvePackageRuntimePreflight({
        target: { version, nodeEngine: engine },
      });
      if (result.ok) {
        throw new Error("Expected an incompatible Node runtime to be refused");
      }
      expect(result.error, "Node compatibility guidance must describe the target range").toContain(
        `Required: openclaw@${version} Node ${engine}; detected: Node ${process.versions.node} at ${process.execPath}`,
      );
      expect(result.error).toContain(
        minimum
          ? expectedPlainRecovery(version, minimum)
          : "No Node version satisfies both this range and this updater's supported range (>=24.16.0 <25 || >=26.1.0).",
      );
    });
  }

  it.each([true, false])("preserves the selected target (present=%s)", async (present) => {
    const target = { version: "2027.1.0", nodeEngine: ">=20.0.0" };
    await expect(resolvePackageRuntimePreflight(present ? { target } : {})).resolves.toEqual({
      ok: true,
      value: present
        ? {
            targetVersion: target.version,
            activationRuntime: {
              kind: "node",
              path: process.execPath,
              identity: `fixture:${process.execPath}`,
            },
          }
        : {},
    });
  });
});
