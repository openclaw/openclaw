import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveManagedServicePackageUpdatePlan } from "./update-command-service-plan.js";

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
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  service.admit.mockReset();
  service.readCommand.mockReset();
  service.readDefinitionMutationCapability.mockReset();
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
  it("redirects Windows split-prefix updates before unsupported retained custody admission", async () => {
    const f = await fixture();
    vi.stubGlobal("process", { ...process, platform: "win32" });
    expect(await resolveManagedServicePackageUpdatePlan({ root: f.invokingRoot })).toEqual({
      rootRedirect: { root: f.serviceRoot, previousRoot: f.invokingRoot },
      nodeRunner: f.nodeRunner,
      serviceUnitTarget: path.join(f.serviceRoot, "dist", "index.js"),
    });
    expect(service.readCommand).toHaveBeenCalledWith(
      process.env,
      expect.objectContaining({
        requireEffective: true,
        requireLoaded: true,
      }),
    );
    expect(service.readDefinitionMutationCapability).toHaveBeenCalledOnce();
  });
  it.each(["managedOverrides", "managedDefinition"] as const)(
    "preserves writable operator definitions through service-root fallback (%s)",
    async (field) => {
      const f = await fixture();
      vi.stubGlobal("process", { ...process, platform: "linux" });
      const command = {
        programArguments: [f.nodeRunner, path.join(f.serviceRoot, "dist", "index.js"), "gateway"],
        environment: { NODE_OPTIONS: "--max-old-space-size=4096" },
      };
      service.readCommand.mockResolvedValue({
        ...command,
        ...(field === "managedDefinition"
          ? { managedDefinition: command }
          : { managedOverrides: { environment: { keys: ["NODE_OPTIONS"] } } }),
      });
      expect(await resolveManagedServicePackageUpdatePlan({ root: f.invokingRoot })).toEqual({
        rootRedirect: { root: f.serviceRoot, previousRoot: f.invokingRoot },
        nodeRunner: f.nodeRunner,
        serviceUnitTarget: path.join(f.serviceRoot, "dist", "index.js"),
      });
      expect(service.readDefinitionMutationCapability).toHaveBeenCalledOnce();
    },
  );
  it.each(["darwin", "linux"])("keeps writable split-prefix rebinds on %s", async (platform) => {
    const f = await fixture({ systemd: platform === "linux" });
    vi.stubGlobal("process", { ...process, platform });
    expect(await resolveManagedServicePackageUpdatePlan({ root: f.invokingRoot })).toEqual({
      rootRedirect: null,
      serviceRoot: f.serviceRoot,
      nodeRunner: f.nodeRunner,
      serviceUnitTarget: path.join(f.serviceRoot, "dist", "index.js"),
    });
    expect(service.readDefinitionMutationCapability).toHaveBeenCalledOnce();
  });
  it.each(["win32", "linux"])("keeps same-root updates in place on %s", async (platform) => {
    const f = await fixture();
    vi.stubGlobal("process", { ...process, platform });
    expect(await resolveManagedServicePackageUpdatePlan({ root: f.serviceRoot })).toEqual({
      rootRedirect: null,
      nodeRunner: f.nodeRunner,
      serviceUnitTarget: path.join(f.serviceRoot, "dist", "index.js"),
    });
    expect(service.readDefinitionMutationCapability).toHaveBeenCalledOnce();
  });
  it("retains the existing protected-definition redirect", async () => {
    const f = await fixture();
    vi.stubGlobal("process", { ...process, platform: "linux" });
    service.readDefinitionMutationCapability.mockResolvedValue({ kind: "sealed" });
    expect(await resolveManagedServicePackageUpdatePlan({ root: f.invokingRoot })).toEqual({
      rootRedirect: { root: f.serviceRoot, previousRoot: f.invokingRoot },
      nodeRunner: f.nodeRunner,
      serviceUnitTarget: path.join(f.serviceRoot, "dist", "index.js"),
    });
  });
});
