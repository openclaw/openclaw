import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolvePinnedDaemonRuntimePath } from "../../daemon/runtime-paths.js";
import {
  inspectManagedGatewayServiceBeforeUpdate,
  resolveManagedServicePackageUpdatePlan,
} from "./update-command-service-plan.js";

const service = vi.hoisted(() => ({
  admit: vi.fn(),
  readCommand: vi.fn(),
  isLoaded: async () => true,
  readRuntime: async () => ({
    status: "running",
    systemd: { managerUid: process.getuid?.() ?? 501 },
  }),
  readDefinitionMutationCapability: vi.fn(),
}));
vi.mock("../../daemon/service.js", async (original) => ({
  ...(await original<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: () => service,
}));
vi.mock("../../infra/gateway-supervision.js", () => ({
  assertGatewayServiceMutationAllowed: service.admit,
}));
vi.mock("../../daemon/runtime-paths.js", () => ({
  resolvePinnedDaemonRuntimePath: vi.fn(async (value) => value),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  service.admit.mockReset();
  service.readCommand.mockReset();
  service.readDefinitionMutationCapability.mockReset();
  vi.mocked(resolvePinnedDaemonRuntimePath).mockClear();
});

async function fixture({ systemd = false } = {}) {
  const root = tempDirs.make("service-root-plan-");
  const serviceRoot = path.join(root, "service");
  const invokingRoot = path.join(root, "invoking");
  await fs.mkdir(path.join(serviceRoot, "dist"), { recursive: true });
  await fs.mkdir(invokingRoot);
  await fs.writeFile(
    path.join(serviceRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
  );
  const nodeRunner = path.join(root, "bin", "node");
  const command = {
    programArguments: [nodeRunner, path.join(serviceRoot, "dist", "index.js"), "gateway"],
    sourcePath: path.join(root, "gateway.cmd"),
  };
  service.readCommand.mockResolvedValue(
    systemd ? { ...command, managedDefinition: command, managedOverrides: {} } : command,
  );
  service.readDefinitionMutationCapability.mockResolvedValue({ kind: "writable" });
  return { serviceRoot, invokingRoot, nodeRunner };
}

describe("managed service root planning", () => {
  it("does not inspect or redirect a service when management admission refuses", async () => {
    const f = await fixture();
    service.admit.mockImplementation(() => {
      throw new Error("fixture supervisor owns service");
    });
    expect(await resolveManagedServicePackageUpdatePlan({ root: f.invokingRoot })).toEqual({
      rootRedirect: null,
      serviceUnitTarget: "not inspected (service management unavailable)",
    });
    expect(service.readCommand).not.toHaveBeenCalled();
  });
  it.each([
    { platform: "win32", definition: "plain", runtime: "node", sameRoot: false },
    { platform: "win32", definition: "plain", runtime: "node", sameRoot: true },
    { platform: "linux", definition: "managedOverrides", runtime: "node", sameRoot: false },
    { platform: "linux", definition: "managedDefinition", runtime: "node", sameRoot: false },
    { platform: "linux", definition: "empty", runtime: "node", sameRoot: false },
    { platform: "linux", definition: "empty", runtime: "bun", sameRoot: false },
  ] as const)(
    "plans $platform $runtime service roots with $definition definitions (same=$sameRoot)",
    async ({ platform, definition, runtime, sameRoot }) => {
      const f = await fixture();
      vi.stubGlobal("process", { ...process, platform });
      const nodeRunner = path.join(path.dirname(f.nodeRunner), runtime);
      const environment =
        runtime === "bun"
          ? { OPENCLAW_SQLITE_LIBRARY: "/fixture/sqlite.dylib" }
          : { NODE_OPTIONS: "--max-old-space-size=4096" };
      const command = {
        programArguments: [nodeRunner, path.join(f.serviceRoot, "dist", "index.js"), "gateway"],
        ...(definition === "plain"
          ? { sourcePath: path.join(path.dirname(f.serviceRoot), "gateway.cmd") }
          : definition === "empty" && runtime === "node"
            ? {}
            : { environment }),
      };
      service.readCommand.mockResolvedValue({
        ...command,
        ...(definition === "managedDefinition" || definition === "empty"
          ? { managedDefinition: command }
          : {}),
        ...(definition === "managedOverrides"
          ? { managedOverrides: { environment: { keys: ["NODE_OPTIONS"] } } }
          : {}),
        ...(definition === "empty" ? { managedOverrides: {} } : {}),
      });
      const rebind = platform === "linux" && definition === "empty" && runtime === "node";
      expect(
        await resolveManagedServicePackageUpdatePlan({
          root: sameRoot ? f.serviceRoot : f.invokingRoot,
        }),
      ).toEqual({
        rootRedirect:
          sameRoot || rebind ? null : { root: f.serviceRoot, previousRoot: f.invokingRoot },
        ...(rebind ? { serviceRoot: f.serviceRoot } : {}),
        nodeRunner,
        serviceUnitTarget: path.join(f.serviceRoot, "dist", "index.js"),
      });
      expect(service.readDefinitionMutationCapability).toHaveBeenCalledOnce();
      if (platform === "win32" && !sameRoot) {
        expect(service.readCommand).toHaveBeenCalledWith(
          process.env,
          expect.objectContaining({ requireEffective: true, requireLoaded: true }),
        );
      }
      if (runtime === "bun") {
        expect(resolvePinnedDaemonRuntimePath).toHaveBeenCalledWith(
          nodeRunner,
          "bun",
          expect.objectContaining(environment),
        );
      }
    },
  );
  it.each(["node", "bun"])(
    "refuses app-owned %s services before split-root redirection or runtime probing",
    async (runtime) => {
      const f = await fixture({ systemd: true });
      vi.stubGlobal("process", { ...process, platform: "linux" });
      const command = {
        programArguments: [
          path.join(path.dirname(f.nodeRunner), runtime),
          path.join(f.serviceRoot, "dist", "index.js"),
          "gateway",
        ],
      };
      service.readCommand.mockResolvedValue({
        ...command,
        managedDefinition: command,
        managedOverrides: {},
      });
      await fs.writeFile(
        path.join(f.serviceRoot, "openclaw-install-owner.json"),
        JSON.stringify({
          schemaVersion: 1,
          owner: "macos-app",
          displayName: "OpenClaw.app",
          updateHint: "Update OpenClaw.app to update this Gateway.",
        }),
      );

      await expect(
        resolveManagedServicePackageUpdatePlan({ root: f.invokingRoot }),
      ).rejects.toThrow("Managed by OpenClaw.app. Update OpenClaw.app to update this Gateway.");
      await expect(
        inspectManagedGatewayServiceBeforeUpdate({
          root: f.invokingRoot,
          allowInstallRootChange: true,
          state: {
            command,
            installed: true,
            running: true,
            env: {},
            loadState: { status: "loaded" },
            runtime: { status: "running", systemd: { managerUid: process.getuid?.() ?? 501 } },
          },
        }),
      ).rejects.toMatchObject({
        name: "GatewayServiceUpdateOwnershipError",
        failureFacts: [expect.objectContaining({ code: "service-mutation-refused" })],
      });
      expect(resolvePinnedDaemonRuntimePath).not.toHaveBeenCalled();
    },
  );
});
