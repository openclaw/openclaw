import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../plugins/runtime.js", () => ({
  requireActivePluginRegistry: vi.fn(),
}));

import type { PluginRegistry } from "../plugins/registry.js";
import { requireActivePluginRegistry } from "../plugins/runtime.js";
import type { CloudSandboxProvider } from "./cloud-sandbox-provider.js";
import { resolveCloudSandboxProvider } from "./cloud-sandbox-registry.js";

const requireRegistryMock = vi.mocked(requireActivePluginRegistry);

function createMockProvider(id: string): CloudSandboxProvider {
  return {
    id,
    exec: vi.fn(),
    execBackground: vi.fn(),
    readSessionLog: vi.fn(),
    killSession: vi.fn(),
    ensureReady: vi.fn(),
    dispose: vi.fn(),
    isReady: () => true,
  };
}

function mockRegistry(
  services: Array<{ pluginId: string; service: { id: string; provider?: CloudSandboxProvider } }>,
): void {
  requireRegistryMock.mockReturnValue({
    services: services.map((s) => ({
      pluginId: s.pluginId,
      service: {
        id: s.service.id,
        provider: s.service.provider,
        start: vi.fn(),
      },
      source: "test",
    })),
  } as unknown as PluginRegistry);
}

describe("resolveCloudSandboxProvider", () => {
  beforeEach(() => {
    requireRegistryMock.mockReset();
  });

  it("returns null when no cloud-sandbox services are registered", () => {
    mockRegistry([]);
    expect(resolveCloudSandboxProvider()).toBeNull();
  });

  it("returns null when services exist but none match cloud-sandbox prefix", () => {
    mockRegistry([{ pluginId: "some-plugin", service: { id: "other-service" } }]);
    expect(resolveCloudSandboxProvider()).toBeNull();
  });

  it("returns provider from first matching cloud-sandbox service", () => {
    const provider = createMockProvider("ags");
    mockRegistry([{ pluginId: "satellite", service: { id: "cloud-sandbox:ags", provider } }]);
    expect(resolveCloudSandboxProvider()).toBe(provider);
  });

  it("filters by providerId when specified", () => {
    const agsProvider = createMockProvider("ags");
    const e2bProvider = createMockProvider("e2b");
    mockRegistry([
      { pluginId: "satellite", service: { id: "cloud-sandbox:ags", provider: agsProvider } },
      { pluginId: "e2b-plugin", service: { id: "cloud-sandbox:e2b", provider: e2bProvider } },
    ]);
    expect(resolveCloudSandboxProvider("e2b")).toBe(e2bProvider);
  });

  it("returns null when providerId does not match any service", () => {
    const provider = createMockProvider("ags");
    mockRegistry([{ pluginId: "satellite", service: { id: "cloud-sandbox:ags", provider } }]);
    expect(resolveCloudSandboxProvider("modal")).toBeNull();
  });

  it("returns null when service matches prefix but has no provider property", () => {
    mockRegistry([{ pluginId: "broken", service: { id: "cloud-sandbox:broken" } }]);
    expect(resolveCloudSandboxProvider()).toBeNull();
  });

  it("skips providerless services and returns first valid provider", () => {
    const validProvider = createMockProvider("e2b");
    mockRegistry([
      { pluginId: "broken", service: { id: "cloud-sandbox:broken" } },
      { pluginId: "e2b-plugin", service: { id: "cloud-sandbox:e2b", provider: validProvider } },
    ]);
    expect(resolveCloudSandboxProvider()).toBe(validProvider);
  });
});
