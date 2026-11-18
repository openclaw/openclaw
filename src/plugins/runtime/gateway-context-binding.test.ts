import { expect, it, vi } from "vitest";
import { prepareGatewayContextBindingOwner } from "./gateway-context-binding-owner.js";
import * as bindings from "./gateway-context-binding.js";

it("preserves nested Gateway bindings and terminal lifetimes across module reloads", async () => {
  const gateway = vi.fn(() => undefined);
  const first = vi.fn(() => undefined);
  const second = vi.fn(() => undefined);
  const otherGateway = vi.fn(() => undefined);
  bindings.bindGatewayContextResolver(first, gateway);
  bindings.bindGatewayContextResolver(second, first);
  const owner = Object.freeze(prepareGatewayContextBindingOwner({}));
  bindings.bindGatewayContextResolver(owner, second);
  const lifetime = bindings.getGatewayContextLifetime(gateway);
  lifetime.abort();
  vi.resetModules();
  const reloaded = await import("./gateway-context-binding.js");

  expect(reloaded.hasGatewayContextOwner(owner, gateway)).toBe(true);
  expect(reloaded.hasGatewayContextOwner(owner, otherGateway)).toBe(false);
  expect(reloaded.clearGatewayContextResolver(owner)).toBe(true);
  expect(bindings.getGatewayContextResolver(owner)).toBeUndefined();
  reloaded.bindGatewayContextResolver(owner, second);
  expect(bindings.hasGatewayContextOwner(owner, gateway)).toBe(true);
  for (const resolver of [gateway, first, second, otherGateway]) {
    expect(resolver).not.toHaveBeenCalled();
  }
  expect(reloaded.getGatewayContextLifetime(gateway)).toBe(lifetime);
  expect(reloaded.getGatewayContextLifetime(gateway).signal.aborted).toBe(true);
  expect(reloaded.getGatewayContextLifetime(otherGateway).signal.aborted).toBe(false);
});
