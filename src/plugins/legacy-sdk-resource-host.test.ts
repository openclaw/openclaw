import { expect, it, vi } from "vitest";

it("retains exact Gateway SDK ownership across separately evaluated host modules", async () => {
  const firstBinding = await import("./runtime/gateway-context-binding.js");
  const firstHost = await import("./legacy-sdk-resource-host.js");
  const firstScope = await import("./runtime/gateway-request-scope.js");
  const owner = vi.fn(() => undefined);
  const wrapper = vi.fn(() => undefined);
  firstBinding.bindGatewayContextResolver(wrapper, owner);
  const lifetime = firstBinding.getGatewayContextLifetime(wrapper);
  lifetime.abort();
  const host = new firstHost.LegacyPluginSdkResourceHost();
  firstHost.bindLegacyPluginSdkResourceHost(owner, host);

  vi.resetModules();
  const secondBinding = await import("./runtime/gateway-context-binding.js");
  const secondHost = await import("./legacy-sdk-resource-host.js");
  const secondScope = await import("./runtime/gateway-request-scope.js");
  try {
    expect(
      secondScope.withPluginRuntimeGatewayContextResolver(
        wrapper,
        secondHost.getBoundLegacyPluginSdkResourceHost,
      ),
    ).toBe(host);
    expect(secondBinding.getGatewayContextLifetime(wrapper)).toBe(lifetime);
    expect(secondBinding.getGatewayContextLifetime(wrapper).signal.aborted).toBe(true);
    const nested = vi.fn(() => undefined);
    secondBinding.bindGatewayContextResolver(nested, wrapper);
    expect(
      firstScope.withPluginRuntimeGatewayContextResolver(
        nested,
        firstHost.getBoundLegacyPluginSdkResourceHost,
      ),
    ).toBe(host);
    const copied = Object.defineProperties(
      () => undefined,
      Object.getOwnPropertyDescriptors(wrapper),
    );
    expect(() =>
      secondScope.withPluginRuntimeGatewayContextResolver(
        copied,
        secondHost.getBoundLegacyPluginSdkResourceHost,
      ),
    ).toThrow("Gateway SDK resource host is not bound");
    expect(secondBinding.getGatewayContextResolver(copied)).toBeUndefined();
    expect(owner).not.toHaveBeenCalled();
    expect(wrapper).not.toHaveBeenCalled();
    expect(nested).not.toHaveBeenCalled();
  } finally {
    await host.close();
  }
});
