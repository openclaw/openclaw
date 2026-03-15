import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "../acp/runtime/errors.js";
import type { AcpRuntime } from "../acp/runtime/types.js";
import {
  __testing,
  getExtensionHostAcpRuntimeBackend,
  registerExtensionHostAcpRuntimeBackend,
  requireExtensionHostAcpRuntimeBackend,
  unregisterExtensionHostAcpRuntimeBackend,
} from "./acp-runtime-backend-registry.js";

function createRuntimeStub(): AcpRuntime {
  return {
    ensureSession: vi.fn(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "stub",
      runtimeSessionName: `${input.sessionKey}:runtime`,
    })),
    runTurn: vi.fn(async function* () {}),
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

describe("extension host acp runtime backend registry", () => {
  beforeEach(() => {
    __testing.resetExtensionHostAcpRuntimeBackendsForTests();
  });

  it("registers and resolves backends by id", () => {
    const runtime = createRuntimeStub();
    registerExtensionHostAcpRuntimeBackend({ id: "acpx", runtime });

    const backend = getExtensionHostAcpRuntimeBackend("acpx");
    expect(backend?.id).toBe("acpx");
    expect(backend?.runtime).toBe(runtime);
  });

  it("prefers a healthy backend when resolving without explicit id", () => {
    registerExtensionHostAcpRuntimeBackend({
      id: "unhealthy",
      runtime: createRuntimeStub(),
      healthy: () => false,
    });
    registerExtensionHostAcpRuntimeBackend({
      id: "healthy",
      runtime: createRuntimeStub(),
      healthy: () => true,
    });

    expect(getExtensionHostAcpRuntimeBackend()?.id).toBe("healthy");
  });

  it("throws typed errors for missing or unavailable backends", () => {
    expect(() => requireExtensionHostAcpRuntimeBackend()).toThrowError(AcpRuntimeError);

    registerExtensionHostAcpRuntimeBackend({
      id: "acpx",
      runtime: createRuntimeStub(),
      healthy: () => false,
    });

    try {
      requireExtensionHostAcpRuntimeBackend("acpx");
      throw new Error("expected requireExtensionHostAcpRuntimeBackend to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AcpRuntimeError);
      expect((error as AcpRuntimeError).code).toBe("ACP_BACKEND_UNAVAILABLE");
    }
  });

  it("shares backend state globally for cross-loader access", () => {
    const runtime = createRuntimeStub();
    const sharedState = __testing.getExtensionHostAcpRuntimeRegistryGlobalStateForTests();

    sharedState.backendsById.set("acpx", {
      id: "acpx",
      runtime,
    });

    expect(getExtensionHostAcpRuntimeBackend("acpx")?.runtime).toBe(runtime);
    unregisterExtensionHostAcpRuntimeBackend("acpx");
    expect(getExtensionHostAcpRuntimeBackend("acpx")).toBeNull();
  });
});
