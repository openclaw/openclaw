import fs from "node:fs/promises";
import path from "node:path";
import { satisfies } from "semver";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeRuntimeFailure } from "../../../node-sqlite.mjs";
import { isSupportedOpenClawNodeVersion } from "../../../node-version.mjs";
import { resolveNodeRuntimeInfo } from "../../daemon/runtime-paths.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import { quoteCliArg, quotePowerShellArg } from "../quote-cli-arg.js";
import {
  expectedPlainRecovery,
  expectedRuntimeSelectionCommand,
  unsupportedServiceRuntimeFixture,
} from "./update-command-runtime-recovery.test-support.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import { resolvePackageRuntimePreflight } from "./update-command-service-plan.js";

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
vi.mock("../../daemon/runtime-paths.js", () => ({ resolveNodeRuntimeInfo: vi.fn() }));
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
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    probeState.text = true;
    probeState.container = false;
    vi.mocked(resolveNodeRuntimeInfo).mockReset();
  });

  it.each([
    [">=24.16.0 <25 || >=26.1.0", "24.16.0", "2026.9.4", "2026.9.4"],
    [null, "unspecified", "2026.9.4", "2026.9.4"],
    ["invalid", "unspecified", "2026.9.4", "2026.9.4"],
    [">=24.16.0", "24.16.0", "2026.9.4-beta.1", "2026.9.4-beta.1"],
    [">=24.16.0", "24.16.0", "2026.9.4-private-customer", "[redacted-version]"],
  ] as const)(
    "records inspected runtime facts for public refusal reports: %s / %s / %s",
    async (nodeEngine, floor, version, publicVersion) => {
      vi.mocked(resolveNodeRuntimeInfo).mockResolvedValue({
        status: "probe-failed",
        error: new Error("probe timed out"),
      });
      const runtime = await resolvePackageRuntimePreflight({
        target: { version, nodeEngine },
        nodeRunner: "/fixture/private/node",
      });
      expect(runtime).toMatchObject({
        ok: false,
        failureFacts: [{ check: "node-runtime", code: "node-runtime-preflight" }],
      });
      if (runtime.ok) {
        throw new Error("Expected runtime refusal");
      }
      expect(runtime.failureFacts?.[0]?.message).toContain(`Target package: openclaw@${version}`);
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
      expect(report.body).toContain(`Minimum Node engine: ${floor}`);
      expect(report.body).not.toContain("/fixture/private");
    },
  );

  it.each([
    [
      "/home/operator/.nvm/versions/node/v22.23.2/bin/node",
      "nvm install 24.16.0 && nvm use 24.16.0",
    ],
    ["/usr/bin/node", null],
    ["/source/node", null, "/fixture"],
    ["/home/operator/.nvm/../system/bin/node", null],
    [
      "/home/operator/.local/share/fnm/node-versions/v22.23.2/installation/bin/node",
      "fnm install 24.16.0 && fnm use 24.16.0",
    ],
    ["/home/operator/.volta/tools/image/node/22.23.2/bin/node", "volta install node@24.16.0"],
    [
      "/custom/node-manager/versions/node/v22.23.2/bin/node",
      "nvm install 24.16.0 && nvm use 24.16.0",
    ],
  ])(
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
        failureFacts: [{ check: "node-runtime", code: "node-runtime-preflight" }],
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
          command
            ? {
                kind: "select-runtime",
                command: command.startsWith("nvm")
                  ? expectedRuntimeSelectionCommand("nvm", "24.16.0")
                  : command.startsWith("fnm")
                    ? expectedRuntimeSelectionCommand("fnm", "24.16.0")
                    : command,
              }
            : {
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

  it.each([false, true])(
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
      const result = await resolvePackageRuntimePreflight({
        target: { version: "2026.9.4", nodeEngine: ">=24.16.0" },
        nodeRunner: launcher,
      });
      expect(result.recoverySteps?.[1]).toEqual({
        kind: "select-runtime",
        command: expectedRuntimeSelectionCommand("fnm", "24.16.0"),
      });
    });
  });

  it("keeps container recovery on the image owner", async () => {
    probeState.container = true;
    const result = await resolvePackageRuntimePreflight({
      target: { version: "2026.9.4", nodeEngine: ">=90.0.0" },
    });
    expect(result).toMatchObject({
      ok: false,
      failureFacts: [{ code: "node-runtime-preflight" }],
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

  it.each([false, true])(
    "admits only a compatible explicit replacement (fallback=%s)",
    async (fallback) => {
      vi.mocked(resolveNodeRuntimeInfo).mockImplementation(async (nodePath) => ({
        status: nodePath === "/old/node" ? "unsupported" : "supported",
        version: nodePath === "/old/node" ? "22.23.1" : "26.8.1",
        sqliteVersion: "3.51.3",
        nodeSharedSqlite: false,
        sqliteProbe: {
          available: true,
          version: "3.51.3",
          text: nodePath !== "/old/node",
          blob: true,
          json: true,
        },
        ...(nodePath === "/old/node" ? { capabilityError: "broken TEXT decoder" } : {}),
      }));
      const result = await resolvePackageRuntimePreflight({
        target: { version: "2027.1.0", nodeEngine: ">=24.16.0 <25 || >=26.1.0" },
        nodeRunner: "/old/node",
        shouldRestart: fallback,
        alreadyCurrent: true,
        service: refreshableService,
      });
      if (fallback) {
        expect(result).toEqual({
          ok: true,
          value: {
            nodeRunner: process.execPath,
            replacedNodeRunner: "/old/node",
            targetVersion: "2027.1.0",
          },
        });
      } else {
        expect(result).toMatchObject({
          ok: false,
          error: expect.stringContaining("selected runtime is Node 22.23.1 at /old/node"),
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
        error: expect.stringContaining("requires Node >=90.0.0"),
      });
    });
  });
  it.each(["22.23.2", "24.15.0", "25.9.0", "26.0.0"])(
    "renders the target engine range for unsupported Node %s",
    async (node) => {
      probeState.text = false;
      vi.stubGlobal("process", { ...process, versions: { ...process.versions, node } });
      const engine = ">=24.16.0 <25 || >=26.1.0";
      const result = await resolvePackageRuntimePreflight({
        target: { version: "2026.9.3", nodeEngine: engine },
      });
      expect(result).toMatchObject({
        ok: false,
        failureFacts: [
          {
            check: "node-runtime",
            code: "node-runtime-preflight",
            affectedKey: "engines.node",
            message: `Target package: openclaw@2026.9.3; Minimum Node engine: 24.16.0; Running Node: ${node}`,
          },
        ],
        error: [
          `openclaw@2026.9.3 requires Node ${engine}; selected runtime is Node ${node}.`,
          `Node ${node}: node:sqlite truncates TEXT at embedded NUL (nodejs/node#61954); use 24.16+/26.1+ or a build with the fix`,
          expectedPlainRecovery("2026.9.3", "24.16.0"),
        ].join("\n"),
      });
    },
  );

  it.each([
    [">=22.19.0", "24.16.0"],
    [">=24.18.0 <25", "24.18.0"],
    ["^22 || >=25 <27", "26.1.0"],
    [">=26.2.0-rc.1 <27", "26.2.0"],
  ])("recommends a release usable by the updater and candidate %s", async (engine, minimum) => {
    const node = "22.23.2";
    vi.stubGlobal("process", { ...process, versions: { ...process.versions, node } });
    const result = await resolvePackageRuntimePreflight({
      target: { version: "2027.1.0", nodeEngine: engine },
    });
    expect(result).toMatchObject({
      ok: false,
      failureFacts: [{ check: "node-runtime", code: "node-runtime-preflight" }],
      error: [
        `openclaw@2027.1.0 requires Node ${engine}; selected runtime is Node ${node}.`,
        `Node ${node}: openclaw requires Node >=24.16.0 <25, or >=26.1.0.`,
        expectedPlainRecovery("2027.1.0", minimum),
      ].join("\n"),
    });
    expect(satisfies(minimum, engine)).toBe(true);
    expect(isSupportedOpenClawNodeVersion(minimum)).toBe(true);
    expect(
      nodeRuntimeFailure(minimum, {
        available: true,
        version: "3.51.3",
        text: true,
        blob: true,
        json: true,
      }),
    ).toBeNull();
  });

  for (const { name, engine, minimum } of [
    {
      name: "reports the full target range when Node is below its minimum",
      engine: ">=90.2.0 <91 || >=92.5.0",
      minimum: "90.2.0",
    },
    {
      name: "reports incompatibility when Node exceeds an exclusive upper bound",
      engine: ">=22.22.3 <23",
      minimum: null,
    },
    {
      name: "reports an unsupported release line with no common version",
      engine: ">=25.0.0 <26",
      minimum: null,
    },
  ]) {
    it(name, async () => {
      const version = "2027.1.0";
      const result = await resolvePackageRuntimePreflight({
        target: { version, nodeEngine: engine },
      });
      if (result.ok) {
        throw new Error("Expected an incompatible Node runtime to be refused");
      }
      expect(result.error, "Node compatibility guidance must describe the target range").toBe(
        `openclaw@${version} requires Node ${engine}; selected runtime is Node ${process.versions.node}.\n${
          minimum
            ? expectedPlainRecovery(version, minimum)
            : "No Node version satisfies both this range and this updater's supported range (>=24.16.0 <25 || >=26.1.0). This candidate version cannot be run by this updater with a supported Node release; install a supported Node and select a compatible OpenClaw target."
        }`,
      );
    });
  }

  it.each([
    ["24.16.0", false, "nodejs/node#61954"],
    ["24.15.0+vendor.1", true, "requires Node >=24.16.0 <25 || >=26.1.0"],
    ["24.19.0", true, null],
  ] as const)(
    "requires target engines and SQLite capabilities for Node %s",
    async (node, text, error) => {
      probeState.text = text;
      vi.stubGlobal("process", { ...process, versions: { ...process.versions, node } });
      const result = await resolvePackageRuntimePreflight({
        target: {
          version: "2026.9.3",
          nodeEngine: ">=24.16.0 <25 || >=26.1.0",
        },
      });
      expect(result.ok).toBe(error === null);
      if (!result.ok) {
        expect(result.error).toContain(error);
      }
    },
  );

  it("preserves a compatible target", async () => {
    await expect(
      resolvePackageRuntimePreflight({ target: { version: "2027.1.0", nodeEngine: ">=20.0.0" } }),
    ).resolves.toEqual({ ok: true, value: { targetVersion: "2027.1.0" } });
  });

  it("preserves an absent target", async () => {
    await expect(resolvePackageRuntimePreflight({})).resolves.toEqual({ ok: true, value: {} });
  });

  it.each([
    { timeoutMs: undefined, startupMs: 11_000, admitted: true },
    { timeoutMs: 1_500_000, startupMs: 1_300_000, admitted: true },
    { timeoutMs: 50, startupMs: 100, admitted: false },
  ])(
    "allows a slow selected Node within its owner budget $timeoutMs",
    async ({ timeoutMs, startupMs, admitted }) => {
      vi.useFakeTimers();
      vi.mocked(resolveNodeRuntimeInfo).mockImplementation(async (_node, _env, allowance) => {
        if (allowance === undefined) {
          throw new Error("Runtime probe requires a finite allowance");
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(startupMs, allowance));
        });
        return allowance < startupMs
          ? { status: "probe-failed", error: new Error("runtime startup timed out") }
          : {
              status: "supported",
              version: "24.19.0",
              sqliteVersion: "3.51.3",
              nodeSharedSqlite: false,
              sqliteProbe: {
                available: true,
                version: "3.51.3",
                text: true,
                blob: true,
                json: true,
              },
            };
      });
      const pending = resolvePackageRuntimePreflight({
        target: { version: "2026.9.4", nodeEngine: ">=24.16.0" },
        nodeRunner: "/fixture/bin/node",
        timeoutMs,
      });
      await vi.advanceTimersByTimeAsync(startupMs);
      const result = await pending;
      if (admitted) {
        expect(result).toEqual({
          ok: true,
          value: { nodeRunner: "/fixture/bin/node", targetVersion: "2026.9.4" },
        });
      } else {
        expect(result).toMatchObject({
          ok: false,
          error: expect.stringContaining("runtime startup timed out"),
        });
      }
    },
  );

  it("refuses a failed recorded-runtime probe even with an unknown target engine", async () => {
    vi.mocked(resolveNodeRuntimeInfo).mockResolvedValue({
      status: "probe-failed",
      error: new Error("probe timed out"),
    });
    const result = await resolvePackageRuntimePreflight({
      target: { version: "2026.9.3", nodeEngine: null },
      nodeRunner: "/fixture/bin/node",
      timeoutMs: 321,
    });
    expect(resolveNodeRuntimeInfo).toHaveBeenCalledWith("/fixture/bin/node", process.env, 321);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("probe timed out") });
  });

  it.each([
    ["24.15.0+vendor.1", false],
    ["24.19.0", true],
  ] as const)(
    "requires target engines for a lossless fallback Node %s",
    async (version, admitted) => {
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
          version: "24.16.0",
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
        target: { version: "2026.9.3", nodeEngine: ">=24.16.0 <25 || >=26.1.0" },
        nodeRunner: "/fixture/old/node",
        shouldRestart: true,
        alreadyCurrent: true,
        service: refreshableService,
      });
      if (admitted) {
        expect(result).toEqual({
          ok: true,
          value: {
            nodeRunner: process.execPath,
            replacedNodeRunner: "/fixture/old/node",
            targetVersion: "2026.9.3",
          },
        });
      } else {
        expect(result).toMatchObject({
          ok: false,
          error: expect.stringContaining("requires Node >=24.16.0 <25 || >=26.1.0"),
        });
      }
    },
  );
});
