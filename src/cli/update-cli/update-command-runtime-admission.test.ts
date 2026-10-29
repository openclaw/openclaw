import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as runtimePaths from "../../daemon/runtime-paths.js";
import * as shared from "./shared.js";
import * as databaseContext from "./update-command-database-context.js";
import * as recovery from "./update-command-node-runtime-resolution.js";
import { inspectPackageEngineAdmission } from "./update-command-runtime-admission.js";
import { stubNodeRuntime } from "./update-command-runtime-recovery.test-support.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import * as servicePlan from "./update-command-service-plan.js";

vi.mock("./update-command-database-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-database-context.js")>()),
  inspectUpdateManagedServices: vi.fn(),
}));
const dirs = createTempDirTracker();
let root: string;
let oldNode: string;
let currentNode: string;
let service: PreManagedServiceStop;
beforeEach(() => {
  // Model a Node updater even when the test runner itself is Bun.
  stubNodeRuntime();
  vi.spyOn(servicePlan, "isGatewayServiceManagementAllowedForUpdate").mockReturnValue(true);
  root = dirs.make("engine-admission-");
  oldNode = path.join(root, "old-node");
  currentNode = path.join(root, "current-node");
  for (const node of [oldNode, currentNode]) {
    fs.writeFileSync(node, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  }
  service = {
    stopped: false,
    inspected: true,
    runtimeInspected: true,
    running: true,
    serviceNodeRunner: oldNode,
    serviceEnv: { OPENCLAW_STATE_DIR: "/service/state", OPENCLAW_CONFIG_PATH: "/service/config" },
    serviceDefinitionEnv: {
      OPENCLAW_STATE_DIR: "/service/state",
      OPENCLAW_CONFIG_PATH: "/service/config",
    },
    serviceUpdateVerdict: { kind: "owned", root, fingerprint: "original", refreshDefinition: true },
  };
  vi.mocked(databaseContext.inspectUpdateManagedServices).mockImplementation(async () => ({
    service,
    services: new Map([[root, service]]),
    managedEnv: undefined,
  }));
  vi.spyOn(shared, "resolveNodeRunner").mockImplementation(() => currentNode);
  vi.spyOn(runtimePaths, "resolveNodeRuntimeInfo").mockImplementation(async (node) => ({
    status: "supported",
    version: node === oldNode ? "24.22.1" : "26.12.1",
    sqliteVersion: "3.53.0",
    nodeSharedSqlite: false,
    sqliteProbe: { available: true, version: "3.53.0", text: true, blob: true, json: true },
  }));
  vi.spyOn(recovery, "resolveTargetNodeRuntime").mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  dirs.cleanup();
});
const admit = (shouldRestart = true) =>
  inspectPackageEngineAdmission({
    root,
    nodeRunner: oldNode,
    shouldRestart,
    timeoutMs: 1000,
    target: { version: "2026.10.6", nodeEngine: ">=26.12.1" },
  });
it("admits only the captured compatible current executable and retains a recheck", async () => {
  const result = await admit();
  expect(result.runtime).toMatchObject({
    ok: true,
    value: { nodeRunner: currentNode, replacedNodeRunner: oldNode },
  });
  expect(runtimePaths.resolveNodeRuntimeInfo).toHaveBeenCalledWith(
    currentNode,
    expect.anything(),
    1000,
  );
  await result.assertCurrent();
  expect(databaseContext.inspectUpdateManagedServices).toHaveBeenCalledTimes(3);
  expect(recovery.resolveTargetNodeRuntime).not.toHaveBeenCalled();
});
it.each([
  "sealed",
  "denied",
  "management-denied",
  "foreign",
  "different-root",
  "uninspected",
  "runtime-uninspected",
  "install-root-refresh",
  "stopped",
  "runtime-mismatch",
  "no-restart",
])("refuses current-Node fallback without authoritative permission: %s", async (reason) => {
  const verdict = service.serviceUpdateVerdict;
  if (verdict?.kind !== "owned") {
    throw new Error("fixture");
  }
  if (reason === "sealed") {
    verdict.refreshDefinition = false;
  }
  if (reason === "management-denied") {
    vi.mocked(servicePlan.isGatewayServiceManagementAllowedForUpdate).mockReturnValue(false);
  }
  if (reason === "denied") {
    service.serviceMutationAllowed = false;
  }
  if (reason === "foreign") {
    service.serviceUpdateVerdict = { kind: "foreign" };
  }
  if (reason === "different-root") {
    verdict.root = path.join(root, "other");
  }
  if (reason === "uninspected") {
    service.inspected = false;
  }
  if (reason === "runtime-uninspected") {
    service.runtimeInspected = false;
  }
  if (reason === "install-root-refresh") {
    verdict.requiresInstallRootRefresh = true;
  }
  if (reason === "stopped") {
    service.running = false;
  }
  if (reason === "runtime-mismatch") {
    service.serviceNodeRunner = currentNode;
  }
  expect((await admit(reason !== "no-restart")).runtime.ok).toBe(false);
  expect(runtimePaths.resolveNodeRuntimeInfo).not.toHaveBeenCalledWith(
    currentNode,
    expect.anything(),
    expect.anything(),
  );
  expect(recovery.resolveTargetNodeRuntime).not.toHaveBeenCalled();
});
it.each(["permission", "management", "definition", "executable"])(
  "rejects %s drift before staging",
  async (drift) => {
    const result = await admit();
    expect(result.runtime.ok).toBe(true);
    // Mutate the provider object in place: retained authority must be a snapshot.
    if (service.serviceUpdateVerdict?.kind !== "owned") {
      throw new Error("fixture");
    }
    if (drift === "management") {
      vi.mocked(servicePlan.isGatewayServiceManagementAllowedForUpdate).mockReturnValue(false);
    }
    if (drift === "permission") {
      service.serviceUpdateVerdict.refreshDefinition = false;
    }
    if (drift === "definition") {
      service.serviceUpdateVerdict.fingerprint = "changed";
    }
    if (drift === "executable") {
      fs.appendFileSync(currentNode, "changed");
    }
    await expect(result.assertCurrent()).rejects.toThrow("changed after engine admission");
    expect(recovery.resolveTargetNodeRuntime).not.toHaveBeenCalled();
  },
);
it("rejects executable replacement during the compatibility probe", async () => {
  vi.mocked(runtimePaths.resolveNodeRuntimeInfo).mockImplementation(async (node) => {
    if (node === currentNode) {
      fs.appendFileSync(node, "replaced");
    }
    return {
      status: "supported",
      version: node === oldNode ? "24.22.1" : "26.12.1",
      sqliteVersion: "3.53.0",
      nodeSharedSqlite: false,
      sqliteProbe: { available: true, version: "3.53.0", text: true, blob: true, json: true },
    };
  });
  expect((await admit()).runtime.ok).toBe(false);
});
it("retains service selectors in read-only engine refusal without exposing secrets", async () => {
  Object.assign(service.serviceEnv!, {
    OPENCLAW_GATEWAY_TOKEN: "private-test-token",
    OPENCLAW_PROFILE: "service-profile",
    OPENCLAW_SYSTEMD_UNIT: "managed-gateway",
    OPENCLAW_LAUNCHD_LABEL: "managed.launchd",
    OPENCLAW_WINDOWS_TASK_NAME: "managed-task",
  });
  service.serviceDefinitionEnv = { ...service.serviceEnv };
  const result = await admit(false);
  expect(result.runtime.ok).toBe(false);
  expect(result.runtime.recoverySteps?.[1]).toMatchObject({
    kind: "preserve-context",
    command: expect.stringContaining(
      "OPENCLAW_STATE_DIR=/service/state OPENCLAW_CONFIG_PATH=/service/config",
    ),
  });
  const contextStep = result.runtime.recoverySteps?.[1];
  const contextCommand = contextStep && "command" in contextStep ? contextStep.command : undefined;
  for (const selector of [
    "OPENCLAW_PROFILE=service-profile",
    "OPENCLAW_SYSTEMD_UNIT=managed-gateway",
    "OPENCLAW_LAUNCHD_LABEL=managed.launchd",
    "OPENCLAW_WINDOWS_TASK_NAME=managed-task",
  ]) {
    expect(contextCommand).toContain(selector);
  }
  expect(contextCommand).toContain("unset");
  expect(JSON.stringify(result.runtime)).not.toContain("private-test-token");
  expect(recovery.resolveTargetNodeRuntime).not.toHaveBeenCalled();
});

it("does not use Bun's emulated Node version as a current-Node fallback", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "versions");
  if (!descriptor) {
    throw new Error("Missing versions descriptor");
  }
  Object.defineProperty(process, "versions", { value: { ...process.versions, bun: "1.4.3" } });
  try {
    expect((await admit()).runtime.ok).toBe(false);
    expect(runtimePaths.resolveNodeRuntimeInfo).not.toHaveBeenCalledWith(
      currentNode,
      expect.anything(),
      expect.anything(),
    );
    expect(recovery.resolveTargetNodeRuntime).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, "versions", descriptor);
  }
});
it("refuses an unavailable service authority before probing or provisioning", async () => {
  vi.mocked(databaseContext.inspectUpdateManagedServices).mockRejectedValue(
    new Error("authority unavailable"),
  );
  await expect(admit()).rejects.toThrow("authority unavailable");
  expect(runtimePaths.resolveNodeRuntimeInfo).not.toHaveBeenCalled();
  expect(recovery.resolveTargetNodeRuntime).not.toHaveBeenCalled();
});
