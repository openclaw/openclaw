import { describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";

function createOwner() {
  let currentServices: PluginServicesHandle | null = null;
  return createGatewayPluginRuntimeGeneration({
    getServices: () => currentServices,
    setServices: (services) => {
      currentServices = services;
    },
  });
}

describe("Gateway plugin runtime generation", () => {
  it("blocks stale publication during reservation, restores rejected claims, and commits winners", async () => {
    const owner = createOwner();
    const startupClaim = owner.currentClaim();
    const published = vi.fn();

    expect(startupClaim.publish(published)).toBe(true);

    const rejectedReplacement = owner.reserve();
    expect(startupClaim.isCurrent()).toBe(false);
    expect(startupClaim.publish(published)).toBe(false);
    let startupUnblocked = false;
    const startupCanContinue = startupClaim.waitForUnblocked().then(() => {
      startupUnblocked = true;
    });
    await Promise.resolve();
    expect(startupUnblocked).toBe(false);
    rejectedReplacement.reject();
    await startupCanContinue;
    expect(startupClaim.isCurrent()).toBe(true);

    const acceptedReplacement = owner.reserve();
    expect(acceptedReplacement.claim.publish(published)).toBe(false);
    acceptedReplacement.commit();
    expect(owner.currentClaim()).toBe(acceptedReplacement.claim);
    expect(startupClaim.publish(published)).toBe(false);
    expect(acceptedReplacement.claim.publish(published)).toBe(true);
    expect(published).toHaveBeenCalledTimes(2);

    const winningServices: PluginServicesHandle = {
      reload: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    expect(owner.publishServices(startupClaim, winningServices)).toBe(false);
    expect(owner.publishServices(acceptedReplacement.claim, winningServices)).toBe(true);
    expect(owner.currentServices()).toBe(winningServices);
  });

  it.each([
    { successor: "rejects", survives: true },
    { successor: "commits", survives: false },
  ])(
    "settles a pending successor that $successor before deciding discovery and service ownership",
    async ({ survives }) => {
      const owner = createOwner();
      const committed = owner.reserve();
      committed.commit();
      const pendingSuccessor = owner.reserve();
      const discoveryStop = vi.fn();
      const services: PluginServicesHandle = {
        reload: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      };
      let settled = false;
      const publication = committed.claim.waitForUnblocked().then((isCurrent) => {
        settled = true;
        if (isCurrent) {
          owner.publishServices(committed.claim, services);
        } else {
          discoveryStop();
        }
        return isCurrent;
      });

      await Promise.resolve();
      expect(settled).toBe(false);
      if (survives) {
        pendingSuccessor.reject();
      } else {
        pendingSuccessor.commit();
      }

      await expect(publication).resolves.toBe(survives);
      expect(owner.currentServices()).toBe(survives ? services : null);
      expect(discoveryStop).toHaveBeenCalledTimes(survives ? 0 : 1);
    },
  );

  it("publishes queued reload status without fencing the serving claim", () => {
    const owner = createOwner();
    const serving = owner.currentClaim();
    const prior = owner.reserve();
    prior.setReloadStatus({ phase: "failed", pluginIds: ["prior"] });
    prior.reject();
    const queued = {
      phase: "reloading" as const,
      pluginIds: ["probe"],
      deadlineAtMs: 1_700_000_000_000,
      reason: "Plugin replacement queued behind 1 retained work item(s)",
    };

    owner.publishReloadStatus(queued);
    expect(serving.isCurrent()).toBe(true);
    expect(serving.publish(() => {})).toBe(true);
    expect(owner.getReloadStatus()).toEqual(queued);

    owner.publishReloadStatus(undefined);
    expect(serving.isCurrent()).toBe(true);
    expect(owner.getReloadStatus()).toEqual({ phase: "failed", pluginIds: ["prior"] });

    owner.publishReloadStatus(queued);
    const admitted = owner.reserve();
    expect(serving.isCurrent()).toBe(false);
    expect(owner.getReloadStatus()).toEqual(queued);
    admitted.reject();
    admitted.finishReload("unchanged", new Set(), createEmptyPluginRegistry(), new Set());
    expect(serving.isCurrent()).toBe(true);
    expect(owner.getReloadStatus()).toEqual({ phase: "failed", pluginIds: ["prior"] });
  });
});
