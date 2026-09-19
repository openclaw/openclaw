// Status service-summary tests cover managed gateway service status parsing and log path reporting.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as gatewayServiceLayout from "../daemon/service-layout.js";
import type { GatewayServiceEnvArgs } from "../daemon/service-types.js";
import { resolveGatewayService, type GatewayService } from "../daemon/service.js";
import { createMockGatewayService } from "../daemon/service.test-helpers.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { readServiceStatusSummary } from "./status.service-summary.js";
import { getStatusOverviewRowValue } from "./status.test-support.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createService(overrides: Partial<GatewayService>): GatewayService {
  return createMockGatewayService({
    label: "systemd",
    loadedText: "enabled",
    notLoadedText: "disabled",
    ...overrides,
  });
}

function requireMockArg(mock: { mock: { calls: unknown[][] } }, label: string): unknown {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

describe("readServiceStatusSummary", () => {
  it.each([
    { serviceVersion: "2026.9.4" },
    { serviceVersion: "2026.9.17" },
    { serviceVersion: "2026.9.4", refusal: "Nix mode detected", nix: true },
    { serviceVersion: "2026.9.4", refusal: "managed by an external supervisor", external: true },
  ])(
    "reports installation facts with usable guidance ($serviceVersion, $refusal)",
    async ({ serviceVersion, refusal, nix, external }) => {
      const root = await fs.realpath(tempDirs.make("openclaw-status-prefix-drift-"));
      const serviceRoot = path.join(root, "prefix-a", "lib", "node_modules", "openclaw");
      const activeRoot = path.join(root, "prefix-b", "lib", "node_modules", "openclaw");
      for (const [packageRoot, version] of [
        [serviceRoot, serviceVersion],
        [activeRoot, "2026.9.17"],
      ] as const) {
        await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
        await fs.writeFile(
          path.join(packageRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version }),
        );
        await fs.writeFile(path.join(packageRoot, "dist", "index.js"), "export {};\n");
      }
      const service = createService({
        isLoaded: vi.fn(async () => true),
        readCommand: vi.fn(async () => ({
          programArguments: [
            process.execPath,
            path.join(serviceRoot, "dist", "index.js"),
            "gateway",
          ],
        })),
        readRuntime: vi.fn(async () => ({ status: "running" })),
      });
      const accountHome = os.userInfo().homedir;
      const summary = await withEnvAsync(
        {
          HOME: accountHome,
          USERPROFILE: accountHome,
          OPENCLAW_HOME: undefined,
          OPENCLAW_STATE_DIR: undefined,
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_PROFILE: undefined,
          OPENCLAW_CONTAINER_HINT: undefined,
          OPENCLAW_NIX_MODE: nix ? "1" : undefined,
          OPENCLAW_SUPERVISOR_MODE: external ? "external" : undefined,
          OPENCLAW_LAUNCHD_LABEL: undefined,
          OPENCLAW_SYSTEMD_UNIT: undefined,
          OPENCLAW_WINDOWS_TASK_NAME: undefined,
        },
        () => readServiceStatusSummary(service, "Daemon", undefined, activeRoot),
      );
      const output = getStatusOverviewRowValue("Gateway service", {
        gatewayService: summary,
        gatewayReachable: false,
        gatewayProbe: { error: "protocol mismatch" },
        gatewaySelf: null,
      });
      expect(output).toContain(`${serviceRoot} (${serviceVersion})`);
      expect(output).toContain(`${activeRoot} (2026.9.17)`);
      expect(typeof summary.installationDrift).toBe("string");
      if (refusal) {
        expect(output).toContain(refusal);
        expect(output).not.toContain("openclaw doctor --fix");
        expect(output).not.toContain("openclaw gateway install --force");
      } else {
        expect(output).toContain("openclaw doctor --fix");
        expect(output).toContain("openclaw gateway install --force");
      }

      const alias = path.join(root, "active-package");
      await fs.symlink(serviceRoot, alias, "dir");
      const aligned = await readServiceStatusSummary(service, "Daemon", undefined, alias);
      expect(aligned.installationDrift).toBeUndefined();
      expect(
        getStatusOverviewRowValue("Gateway service", { gatewayService: aligned }),
      ).not.toContain("different OpenClaw install");
    },
  );
  it.each(["user", "system"] as const)("labels the observed %s manager", async (scope) => {
    const summary = await readServiceStatusSummary(
      createService({
        readRuntime: vi.fn(async () => ({ status: "running", systemd: { scope } })),
      }),
      "Daemon",
    );
    expect(summary.label).toBe(`systemd ${scope}`);
  });
  it("marks OpenClaw-managed services as installed", async () => {
    const summary = await readServiceStatusSummary(
      createService({
        isLoaded: vi.fn(async () => true),
        readCommand: vi.fn(async () => ({ programArguments: ["openclaw", "gateway", "run"] })),
        readRuntime: vi.fn(async () => ({ status: "running" })),
      }),
      "Daemon",
    );

    expect(summary.installed).toBe(true);
    expect(summary.managedByOpenClaw).toBe(true);
    expect(summary.externallyManaged).toBe(false);
    expect(summary.loadedText).toBe("enabled");
  });

  it("marks running unmanaged services as externally managed", async () => {
    const summary = await readServiceStatusSummary(
      createService({
        readRuntime: vi.fn(async () => ({ status: "running" })),
      }),
      "Daemon",
    );

    expect(summary.installed).toBe(true);
    expect(summary.managedByOpenClaw).toBe(false);
    expect(summary.externallyManaged).toBe(true);
    expect(summary.loadedText).toBe("running (externally managed)");
  });

  it.each([{ status: "stopped" }, { status: "unknown", missingUnit: true }])(
    "keeps missing services as not installed with runtime $status",
    async (runtime) => {
      const summary = await readServiceStatusSummary(
        createService({ readRuntime: vi.fn(async () => runtime) }),
        "Daemon",
      );

      expect(summary.installed).toBe(false);
      expect(summary.managedByOpenClaw).toBe(false);
      expect(summary.externallyManaged).toBe(false);
      expect(summary.loadedText).toBe("disabled");
      expect(getStatusOverviewRowValue("Gateway service", { gatewayService: summary })).toBe(
        "systemd not installed",
      );
    },
  );

  it.each(["load", "runtime", "runtime with missing unit"])(
    "reports %s inspection failures without a readable definition",
    async (probe) => {
      const failInspection = vi.fn(async () => {
        throw new Error("service manager permission denied");
      });
      const summary = await readServiceStatusSummary(
        createService(
          probe === "load"
            ? { isLoaded: failInspection }
            : {
                readRuntime:
                  probe === "runtime"
                    ? failInspection
                    : vi.fn(async () => ({
                        status: "unknown",
                        detail: "Error: service manager permission denied",
                        missingUnit: true,
                      })),
              },
        ),
        "Daemon",
      );

      expect(summary.installed).toBe(false);
      expect(summary.loadState).toEqual(
        probe === "load"
          ? {
              status: "unknown",
              detail: "Error: service manager permission denied",
            }
          : { status: "not-loaded" },
      );
      expect(getStatusOverviewRowValue("Gateway service", { gatewayService: summary })).toBe(
        probe === "load"
          ? "systemd unknown (inspection failed: Error: service manager permission denied) · stopped"
          : probe === "runtime"
            ? "systemd disabled (inspection failed: service runtime inspection failed) · unknown"
            : "systemd disabled (inspection failed: Error: service manager permission denied) · unknown",
      );
      if (probe === "runtime") {
        expect(summary.runtime?.inspectionFailure).toEqual({
          code: "service-runtime-inspection-failed",
          detail: "service manager permission denied",
        });
      }
    },
  );

  it("preserves running service state when optional layout diagnostics fail", async () => {
    const layoutSpy = vi
      .spyOn(gatewayServiceLayout, "summarizeGatewayServiceLayout")
      .mockRejectedValueOnce(new Error("package metadata is unreadable"));

    try {
      const summary = await readServiceStatusSummary(
        createService({
          isLoaded: vi.fn(async () => true),
          readCommand: vi.fn(async () => ({ programArguments: ["openclaw", "gateway", "run"] })),
          readRuntime: vi.fn(async () => ({ status: "running", pid: 1234 })),
        }),
        "Daemon",
      );

      expect(layoutSpy).toHaveBeenCalledOnce();
      expect(summary).toMatchObject({
        label: "systemd",
        installed: true,
        loadState: { status: "loaded" },
        managedByOpenClaw: true,
        externallyManaged: false,
        loadedText: "enabled",
        runtime: { status: "running", pid: 1234 },
      });
      expect(summary.layout).toBeUndefined();
    } finally {
      layoutSpy.mockRestore();
    }
  });

  it("keeps unsupported service adapters readable", async () => {
    await withMockedPlatform("aix", async () => {
      const summary = await readServiceStatusSummary(resolveGatewayService(), "Daemon");

      expect(summary.label).toBe("Gateway service");
      expect(summary.installed).toBe(false);
      expect(summary.loadState).toEqual({
        status: "unknown",
        detail: "Error: Gateway service install not supported on aix",
      });
      expect(summary.managedByOpenClaw).toBe(false);
      expect(summary.externallyManaged).toBe(false);
      expect(summary.loadedText).toBe("unknown");
      expect(summary.runtime).toEqual({
        status: "unknown",
        detail: "Gateway service install not supported on aix",
      });
    });
  });

  it("passes command environment to runtime and loaded checks", async () => {
    const isLoaded = vi.fn(async ({ env }: GatewayServiceEnvArgs) => {
      return env?.OPENCLAW_GATEWAY_PORT === "18789";
    });
    const readRuntime = vi.fn(async (env?: NodeJS.ProcessEnv) => ({
      status: env?.OPENCLAW_GATEWAY_PORT === "18789" ? ("running" as const) : ("unknown" as const),
    }));

    const summary = await readServiceStatusSummary(
      createService({
        isLoaded,
        readCommand: vi.fn(async () => ({
          programArguments: ["openclaw", "gateway", "run", "--port", "18789"],
          environment: { OPENCLAW_GATEWAY_PORT: "18789" },
        })),
        readRuntime,
      }),
      "Daemon",
    );

    const loadedArgs = requireMockArg(isLoaded, "isLoaded") as GatewayServiceEnvArgs;
    expect(loadedArgs?.env?.OPENCLAW_GATEWAY_PORT).toBe("18789");
    const runtimeEnv = requireMockArg(readRuntime, "readRuntime") as NodeJS.ProcessEnv;
    expect(runtimeEnv?.OPENCLAW_GATEWAY_PORT).toBe("18789");
    expect(summary.installed).toBe(true);
    expect(summary.loadState).toEqual({ status: "loaded" });
    expect(summary.runtime?.status).toBe("running");
  });

  it("includes service layout diagnostics and flags source checkout entrypoints", async () => {
    await withTestDir({ prefix: "openclaw-status-service-layout-" }, async (root) => {
      await fs.mkdir(path.join(root, ".git"), { recursive: true });
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.mkdir(path.join(root, "extensions"), { recursive: true });
      await fs.mkdir(path.join(root, "dist"), { recursive: true });
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "0.0.0-test" }),
        "utf8",
      );
      const entrypoint = path.join(root, "dist", "index.js");
      const serviceFile = path.join(root, "openclaw-gateway.service");
      await fs.writeFile(entrypoint, "export {};\n", "utf8");
      await fs.writeFile(serviceFile, "[Service]\n", "utf8");
      const realRoot = await fs.realpath(root);

      const summary = await readServiceStatusSummary(
        createService({
          isLoaded: vi.fn(async () => true),
          readCommand: vi.fn(async () => ({
            programArguments: ["/usr/bin/node", entrypoint, "gateway", "run"],
            sourcePath: serviceFile,
          })),
          readRuntime: vi.fn(async () => ({ status: "running" })),
        }),
        "Daemon",
      );

      const layout = summary.layout;
      if (!layout) {
        throw new Error("Expected service layout diagnostics");
      }
      expect(layout.sourcePath).toBe(serviceFile);
      expect(layout.sourcePathReal).toBe(path.join(realRoot, "openclaw-gateway.service"));
      expect(layout.entrypoint).toBe(entrypoint);
      expect(layout.entrypointReal).toBe(path.join(realRoot, "dist", "index.js"));
      expect(layout.packageRoot).toBe(realRoot);
      expect(layout.packageRootReal).toBe(realRoot);
      expect(layout.packageVersion).toBe("0.0.0-test");
      expect(layout.entrypointSourceCheckout).toBe(true);
      expect(layout.execStart).toBe(`/usr/bin/node ${entrypoint} gateway run`);
    });
  });
});
