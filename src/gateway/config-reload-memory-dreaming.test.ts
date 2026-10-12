import { describe, expect, it } from "vitest";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import { reconcileOrphanedMemoryDreamingJobs } from "./server-cron-memory-dreaming-jobs.js";
import { SYSTEM_JOB_RECONCILERS } from "./server-cron-system-job-reconcilers.js";

describe("memory dreaming reload plan", () => {
  it.each([
    "plugins.enabled",
    "plugins.allow",
    "plugins.deny",
    "plugins.slots.memory",
    "plugins.entries.memory-core.enabled",
    // The slot owner itself: disabling it also makes the loader refuse the sidecar.
    "plugins.entries.memory-lancedb-namespaced.enabled",
    "plugins.entries.memory-lancedb-namespaced.config.dreaming.enabled",
    // A slot owner supplied only through a load path or install disappears
    // with it, and the loader then refuses the sidecar too.
    "plugins.load.paths",
    "plugins.installs.memory-lancedb-namespaced",
  ])("reloads plugins and reconciles system jobs when %s changes", (path) => {
    // Each of these can unload the memory-core sidecar; only the system-job
    // pass can remove its cron job afterwards.
    const plan = buildGatewayReloadPlan([path]);

    expect(plan).toMatchObject({
      restartGateway: false,
      hotReasons: [path],
      reloadPlugins: true,
      reconcileSystemJobs: true,
    });
  });

  it("runs the orphaned dreaming job pass on every cron start and system-job reload", () => {
    expect(SYSTEM_JOB_RECONCILERS).toContain(reconcileOrphanedMemoryDreamingJobs);
  });

  it("requests the pass for any plugin's enabled flag without a gateway restart", () => {
    const plan = buildGatewayReloadPlan(["plugins.entries.telegram.enabled"]);

    expect(plan).toMatchObject({ reloadPlugins: true, reconcileSystemJobs: true });
    expect(plan.restartGateway).toBe(false);
  });

  it("keeps other plugin config changes on the plain plugin reload", () => {
    const plan = buildGatewayReloadPlan([
      "plugins.entries.memory-lancedb-namespaced.config.recall",
    ]);

    expect(plan).toMatchObject({ reloadPlugins: true, reconcileSystemJobs: false });
  });
});
