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
import { updateResult, updateStep } from "./update-command-maintenance-fixtures.test-support.js";
import { resolveTargetNodeRuntime } from "./update-command-node-runtime-resolution.js";
import { resolvePackageRuntimePreflight } from "./update-command-runtime-preflight.js";
import {
  expectedPlainRecovery,
  expectedRuntimeRecoverySteps,
  expectedRuntimeSelectionCommand,
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
const sqliteProbe = { available: true, version: "3.51.3", text: true, blob: true, json: true };
function runtimeInfo(version = "24.22.1") {
  return {
    status: "supported" as const,
    version,
    sqliteVersion: sqliteProbe.version,
    nodeSharedSqlite: false,
    sqliteProbe,
  };
}
const activationRuntime = (executable: string) => ({
  kind: "node",
  path: executable,
  identity: `fixture:${executable}`,
});
const runtimeFailure = expect.arrayContaining([
  expect.objectContaining({ check: "node-runtime", code: "node-runtime-preflight" }),
]);
type PreflightOptions = Parameters<typeof resolvePackageRuntimePreflight>[0];
const preflight = (options: PreflightOptions = {}) =>
  resolvePackageRuntimePreflight({
    target: { version: "2026.9.4", nodeEngine: ">=24.22.1" },
    ...options,
  });
const expectSelected = (result: unknown, executable: string, extra = {}) =>
  expect(result).toEqual({
    ok: true,
    value: {
      targetVersion: "2026.9.4",
      activationRuntime: activationRuntime(executable),
      ...extra,
    },
  });
function stubRuntime(
  versions: Partial<NodeJS.ProcessVersions>,
  overrides: Partial<NodeJS.Process> = {},
) {
  vi.stubGlobal("process", {
    ...process,
    ...overrides,
    versions: { ...process.versions, ...versions },
  });
}
function mockUnsupportedNode() {
  vi.mocked(resolveNodeRuntimeInfo).mockResolvedValue({
    ...runtimeInfo("22.23.2"),
    status: "unsupported",
  });
}
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
    detectCurrentSqliteCapabilities: async () => ({ ...sqliteProbe, text: probeState.text }),
  };
});

describe("package runtime compatibility guidance", () => {
  beforeEach(() => {
    vi.mocked(resolveBunRuntimeInfo).mockResolvedValue(runtimeInfo("1.4.4"));
    stubRuntime({ node: "24.22.1", bun: undefined }, { execPath: path.resolve("/fixture/node") });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    probeState.text = true;
    probeState.container = false;
    vi.mocked(resolveNodeRuntimeInfo).mockReset();
    vi.mocked(resolveBunRuntimeInfo).mockReset();
    vi.mocked(resolvePinnedDaemonRuntimePath).mockReset();
    vi.mocked(resolveTargetNodeRuntime).mockReset();
  });

  it("reports the patched Bun minimum when the selected runtime is unsupported", async () => {
    stubRuntime({ bun: "1.4.3" });
    vi.mocked(resolveBunRuntimeInfo).mockResolvedValue({
      ...runtimeInfo("1.4.3"),
      status: "unsupported",
    });
    expect(await preflight()).toEqual({
      ok: false,
      error: "Bun 1.4.4+ with WAL-reset-safe node:sqlite is required.",
    });
  });

  const processEnv = {
    OPENCLAW_SQLITE_LIBRARY: "/process/sqlite.dylib",
    HOMEBREW_PREFIX: "/process/homebrew",
  };
  const libraryEnv = { OPENCLAW_SQLITE_LIBRARY: "/service/sqlite.dylib" };
  const homebrewEnv = { HOMEBREW_PREFIX: "/service/custom-homebrew" };
  it.each([
    [undefined, processEnv, false],
    ["/fixture/app-runtime", processEnv, false],
    ["/service/bin/bun", libraryEnv, false],
    ["/service/bin/bun", libraryEnv, true],
    ["/service/bin/bun", homebrewEnv, false],
  ] as const)(
    "validates Bun %s with runtime environment %j (probe failed=%s)",
    async (nodeRunner, runtimeEnv, failed) => {
      const current = runtimeEnv === processEnv;
      const homebrew = runtimeEnv === homebrewEnv;
      const executable = nodeRunner ?? "/fixture/app-runtime";
      const serviceEnv: NodeJS.ProcessEnv = {
        ...runtimeEnv,
        OPENCLAW_GATEWAY_TOKEN: "synthetic-unrelated-secret",
        NODE_OPTIONS: "--require /unrelated/preload.cjs",
      };
      stubRuntime(
        { bun: "1.4.4", node: "24.3.0" },
        {
          env: current ? serviceEnv : processEnv,
          execPath: path.resolve("/fixture/app-runtime"),
        },
      );
      if (failed) {
        vi.mocked(resolveBunRuntimeInfo).mockResolvedValue({
          status: "probe-failed",
          error: new Error("Bun 1.4.4+ with WAL-reset-safe node:sqlite is required."),
        });
      }
      const result = await preflight({
        target: { version: "2027.1.0", nodeEngine: ">=90.0.0" },
        nodeRunner,
        service: { ...refreshableService, ...(current ? {} : { serviceEnv }) },
        ...(!homebrew
          ? { shouldRestart: true, runtimeRecovery: { env: {}, installCommand: vi.fn() } }
          : {}),
      });
      expect(result).toEqual(
        !failed
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
          : { ok: false, error: "Bun 1.4.4+ with WAL-reset-safe node:sqlite is required." },
      );
      expect(resolveBunRuntimeInfo).toHaveBeenCalledWith(executable, runtimeEnv);
      if (homebrew) {
        serviceEnv.HOMEBREW_PREFIX = "/changed/after-preflight";
        expect(result.ok && result.value.activationRuntime?.env).toEqual(runtimeEnv);
      }
    },
  );

  it("does not offer the current Bun as a fallback for a managed Node service", async () => {
    stubRuntime({ bun: "1.4.4" }, { execPath: path.resolve("/fixture/app-runtime") });
    vi.mocked(resolveNodeRuntimeInfo).mockResolvedValue(unsupportedServiceRuntimeFixture);
    vi.mocked(resolveTargetNodeRuntime).mockResolvedValue("/recovered/node");
    const result = await preflight({
      nodeRunner: "/old/node",
      shouldRestart: true,
      alreadyCurrent: true,
      service: refreshableService,
      runtimeRecovery: { env: {} },
    });
    expectSelected(result, "/recovered/node", {
      nodeRunner: "/recovered/node",
      replacedNodeRunner: "/old/node",
    });
  });

  it.each([
    [">=24.22.1 <25 || >=26.12.1", "2026.9.4", "2026.9.4"],
    [null, "2026.9.4", "2026.9.4"],
    ["invalid", "2026.9.4", "2026.9.4"],
    [">=24.22.1", "2026.9.4-beta.1", "2026.9.4-beta.1"],
    [">=24.22.1", "2026.9.4-private-customer", "[redacted-version]"],
  ] as const)(
    "records inspected runtime facts for public refusal reports: %s / %s",
    async (nodeEngine, version, publicVersion) => {
      vi.mocked(resolveNodeRuntimeInfo).mockResolvedValue({
        status: "probe-failed",
        error: new Error("probe timed out"),
      });
      const runtime = await preflight({
        target: { version, nodeEngine },
        nodeRunner: "/fixture/private/node",
        timeoutMs: 321,
      });
      expect(runtime).toMatchObject({
        ok: false,
        error: expect.stringContaining("probe timed out"),
        failureFacts: runtimeFailure,
      });
      if (runtime.ok) {
        throw new Error("Expected runtime refusal");
      }
      expect(runtime.failureFacts?.[0]?.message).toContain(`Required: openclaw@${version}`);
      const report = await prepareUpdateFailureReport({
        attemptId: "runtime-refusal",
        result: updateResult({
          status: "error",
          steps: [
            updateStep("node-runtime-preflight", {
              failureFacts: runtime.failureFacts,
            }),
          ],
        }),
      });
      expect(report.body).not.toContain("private-customer");
      expect(report.body).toContain(`Target package: openclaw@${publicVersion}`);
      expect(report.body).toContain(
        `Required runtime: ${nodeEngine === "invalid" ? "[redacted-requirement]" : nodeEngine ? `Node ${nodeEngine}` : "a working Node runtime"}`,
      );
      expect(report.body).not.toContain("/fixture/private");
    },
  );

  it.each([
    [
      "/home/operator/.nvm/versions/node/v22.23.2/bin/node",
      "nvm install 24.22.1 && nvm use 24.22.1",
    ],
    ["/usr/bin/node", null],
    ["/source/node", null, "/fixture"],
    ["/home/operator/.nvm/../system/bin/node", null],
    [
      "/home/operator/.local/share/fnm/node-versions/v22.23.2/installation/bin/node",
      "fnm install 24.22.1 && fnm use 24.22.1",
    ],
    ["/home/operator/.volta/tools/image/node/22.23.2/bin/node", "volta install node@24.22.1"],
    [
      "/custom/node-manager/versions/node/v22.23.2/bin/node",
      "nvm install 24.22.1 && nvm use 24.22.1",
    ],
  ])(
    "keeps the CLI and owned service reachable after switching %s",
    async (nodeRunner, command, sourceRoot?: string) => {
      mockUnsupportedNode();
      const result = await preflight({
        nodeRunner,
        sourceRoot,
        root: sourceRoot ?? "/fixture",
        alreadyCurrent: Boolean(sourceRoot),
        service: {
          ...refreshableService,
          serviceEnv: { OPENCLAW_PROFILE: "work", NVM_DIR: "/custom/node-manager" },
        },
      });
      const prefix = command === "volta install node@24.22.1" ? "volta run --node 24.22.1 " : "";
      const sourceEntry = path.join(sourceRoot ?? "/fixture", "openclaw.mjs");
      const cli = `node ${process.platform === "win32" ? quotePowerShellArg(sourceEntry) : quoteCliArg(sourceEntry)}`;
      expect(result).toMatchObject({ ok: false, failureFacts: runtimeFailure });
      expect(result.recoverySteps?.[1]).toEqual({
        kind: "preserve-context",
        command:
          "export OPENCLAW_PROFILE=work; unset OPENCLAW_HOME OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH OPENCLAW_GATEWAY_PORT OPENCLAW_LAUNCHD_LABEL OPENCLAW_SYSTEMD_UNIT OPENCLAW_WINDOWS_TASK_NAME OPENCLAW_WORKSPACE_DIR",
      });
      expect(result.recoverySteps?.[2]).toEqual(
        command
          ? {
              kind: "select-runtime",
              command: command.startsWith("nvm")
                ? expectedRuntimeSelectionCommand("nvm", "24.22.1")
                : command.startsWith("fnm")
                  ? expectedRuntimeSelectionCommand("fnm", "24.22.1")
                  : command,
            }
          : expectedRuntimeRecoverySteps("24.22.1")[1],
      );
      expect(result.recoverySteps?.at(-1)).toEqual({
        kind: "continue-update",
        command: `${prefix}${cli} --profile work update${sourceRoot ? "" : " --tag 2026.9.4"}`,
      });
    },
  );

  it("preserves recorded selectors and wrapper ownership", async () => {
    mockUnsupportedNode();
    const result = await preflight({
      nodeRunner: "/usr/bin/node",
      invocationCwd: "/service-launch",
      service: {
        ...refreshableService,
        serviceEnv: {
          OPENCLAW_STATE_DIR: "/service state",
          OPENCLAW_CONFIG_PATH: "config.json",
          OPENCLAW_SYSTEMD_UNIT: "custom-gateway.service",
          OPENCLAW_WRAPPER: "/operator/wrapper",
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
    expect(result.recoverySteps?.at(-1)).toEqual(expectedRuntimeRecoverySteps("24.22.1").at(-1));
    expect(JSON.stringify(result)).not.toContain("fixture-sensitive-value");
  });

  it("detects a version manager behind the selected runtime symlink", async () => {
    await withTempDir("openclaw-node-manager-", async (root) => {
      const node = path.join(root, ".fnm", "node-versions", "v22.18.0", "bin", "node");
      await fs.mkdir(path.dirname(node), { recursive: true });
      await fs.writeFile(node, "fixture");
      const alias = path.join(root, "node-alias");
      await fs.symlink(
        path.dirname(node),
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      const launcher = path.join(alias, "node");
      vi.mocked(resolveNodeRuntimeInfo).mockResolvedValue(unsupportedServiceRuntimeFixture);
      const result = await preflight({
        nodeRunner: launcher,
      });
      expect(result.recoverySteps?.[1]).toEqual({
        kind: "select-runtime",
        command: expectedRuntimeSelectionCommand("fnm", "24.22.1"),
      });
    });
  });

  it("keeps container recovery on the image owner", async () => {
    probeState.container = true;
    const result = await preflight({
      target: { version: "2026.9.4", nodeEngine: ">=90.0.0" },
    });
    expect(result).toMatchObject({
      ok: false,
      failureFacts: expect.arrayContaining([
        expect.objectContaining({ code: "node-runtime-preflight" }),
      ]),
      recoverySteps: [
        {
          kind: "deployment",
          instruction:
            "Pull or build an OpenClaw image with version 2026.9.4 and Node 90.0.0, then recreate or redeploy the container with the same state/config mounts. In-container package changes are not durable.",
        },
      ],
    });
  });

  it.each(["nvm", "fnm"] as const)(
    "renders %s recovery for PowerShell 5.1 without shell interpolation",
    async (manager) => {
      vi.stubGlobal("process", { ...process, platform: "win32" });
      vi.mocked(resolveNodeRuntimeInfo).mockResolvedValue(unsupportedServiceRuntimeFixture);
      const result = await preflight({
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
    ["26.12.1", false, "detected: Node 24.22.1 at /old/node"],
    ["26.12.1", true, null],
    ["24.15.0+vendor.1", true, "Node >=24.22.1 <25 || >=26.12.1"],
  ] as const)(
    "admits only a lossless compatible fallback %s when restart=%s",
    async (version, restart, error) => {
      vi.mocked(resolveNodeRuntimeInfo)
        .mockResolvedValueOnce({
          ...runtimeInfo(),
          status: "unsupported",
          sqliteProbe: { ...sqliteProbe, text: false },
          capabilityError: "broken TEXT decoder",
        })
        .mockResolvedValueOnce(runtimeInfo(version));
      const result = await preflight({
        target: { version: "2026.9.4", nodeEngine: ">=24.22.1 <25 || >=26.12.1" },
        nodeRunner: "/old/node",
        shouldRestart: restart,
        alreadyCurrent: true,
        service: refreshableService,
      });
      if (error) {
        expect(result).toMatchObject({ ok: false, error: expect.stringContaining(error) });
      } else {
        expectSelected(result, process.execPath, {
          nodeRunner: process.execPath,
          replacedNodeRunner: "/old/node",
        });
      }
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
  it("renders the target engine range for unsupported Node", async () => {
    const node = "22.23.2";
    probeState.text = false;
    stubRuntime({ node });
    const engine = ">=24.22.1 <25 || >=26.12.1";
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
          `Node ${node}: node:sqlite truncates TEXT at embedded NUL (nodejs/node#61954); use 24.22.1+/26.12.1+ or a build with the fix`,
          expectedPlainRecovery("2026.9.3", "24.22.1", "refresh", "", path.resolve("/fixture/cli")),
        ].join("\n"),
      ),
    });
  });

  it.each([
    [">=22.19.0", "24.22.1"],
    [">=24.18.0 <25", "24.22.1"],
    ["^22 || >=25 <27", "26.12.1"],
    [">=26.2.0-rc.1 <27", "26.12.1"],
    [">=90.2.0 <91 || >=92.5.0", "90.2.0"],
    [">=22.22.3 <23", null],
    [">=25.0.0 <26", null],
  ] as const)("reports compatible recovery for target range %s", async (engine, minimum) => {
    const node = minimum === "90.2.0" || !minimum ? "24.22.1" : "22.23.2";
    stubRuntime({ node });
    const result = await preflight({
      target: { version: "2027.1.0", nodeEngine: engine },
    });
    expect(result).toMatchObject({
      ok: false,
      failureFacts: runtimeFailure,
      error: expect.stringContaining(
        `Required: openclaw@2027.1.0 Node ${engine}; detected: Node ${node} at ${process.execPath}`,
      ),
    });
    if (result.ok) {
      throw new Error("Expected incompatible runtime refusal");
    }
    expect(result.error).toContain(
      minimum
        ? expectedPlainRecovery("2027.1.0", minimum)
        : "No Node version satisfies both this range and this updater's supported range (>=24.22.1 <25 || >=26.12.1).",
    );
    if (minimum !== "90.2.0" && minimum) {
      expect(result.error).toContain(
        `Node ${node}: openclaw requires Node >=24.22.1 <25, or >=26.12.1.`,
      );
    }
  });

  it("leaves the runtime unchanged without a target", async () => {
    await expect(resolvePackageRuntimePreflight({})).resolves.toEqual({ ok: true, value: {} });
  });

  it.each([
    { timeoutMs: undefined, startupMs: 11_000, admitted: true },
    { timeoutMs: 1_500_000, startupMs: 1_300_000, admitted: true },
    { timeoutMs: 50, startupMs: 100, admitted: false },
  ])(
    "passes the selected Node owner budget $timeoutMs and preserves probe refusal",
    async ({ timeoutMs, startupMs, admitted }) => {
      vi.mocked(resolveNodeRuntimeInfo).mockImplementation(async (_node, _env, allowance) => {
        if (allowance === undefined) {
          throw new Error("Runtime probe requires a finite allowance");
        }
        return allowance < startupMs
          ? { status: "probe-failed", error: new Error("runtime startup timed out") }
          : runtimeInfo();
      });
      const result = await preflight({
        nodeRunner: "/fixture/bin/node",
        timeoutMs,
      });
      if (admitted) {
        expectSelected(result, "/fixture/bin/node", { nodeRunner: "/fixture/bin/node" });
      } else {
        expect(result).toMatchObject({
          ok: false,
          error: expect.stringContaining("runtime startup timed out"),
        });
      }
    },
  );
});
