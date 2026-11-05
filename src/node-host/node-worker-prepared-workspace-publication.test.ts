import { expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { nodePreparedWorkspacePublication } from "./node-worker-prepared-workspace-publication.js";
import { NodeWorkerPreparedWorkspaceStore } from "./node-worker-prepared-workspace-store.js";

it("publishes every prepared-workspace transition before the awaited owner returns", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    const store = new NodeWorkerPreparedWorkspaceStore({ env: state.env });
    const states: string[] = [];
    const unsubscribe = nodePreparedWorkspacePublication.subscribeFacts((change) => {
      if (change.kind === "committed") {
        for (const fact of change.receipt.facts.values()) {
          if (fact.kind === "postimage") {
            states.push(fact.value.state);
          }
        }
      }
    });
    try {
      const row = await store.register({
        action: "register",
        preparationKey: "a".repeat(64),
        cacheKey: "b".repeat(64),
        gatewayNamespace: "synthetic-gateway",
        environmentId: "synthetic-environment",
        workspaceDir: state.workspaceDir,
        homeDir: state.home,
        sourceManifestRef: `sha256:${"c".repeat(64)}`,
        preparedManifestRef: `sha256:${"d".repeat(64)}`,
      });
      expect(states).toEqual(["available"]);
      expect(await store.find(row.environment_id)).toEqual(row);
      const bound = await store.bind({
        action: "bind",
        preparationKey: row.preparation_key,
        cacheKey: row.cache_key,
        gatewayNamespace: row.gateway_namespace,
        environmentId: row.environment_id,
        sessionId: "synthetic-session",
        sessionKey: "agent:main:synthetic",
        ownerEpoch: 1,
      });
      expect(states.at(-1)).toBe("bound");
      const mutation = await store.beginMutation(bound);
      expect(states.at(-1)).toBe("retiring");
      await mutation.complete();
      expect(states.at(-1)).toBe("bound");
      await store.retire(bound, true);
      expect(states).toEqual(["available", "bound", "retiring", "bound", "retired"]);
      expect(await store.find(row.environment_id)).toMatchObject({ state: "retired" });
    } finally {
      unsubscribe();
    }
  });
});

it("replaces and publishes only an available, unbound prepared baseline", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    const store = new NodeWorkerPreparedWorkspaceStore({ env: state.env });
    const registration = {
      action: "register" as const,
      preparationKey: "a".repeat(64),
      cacheKey: "b".repeat(64),
      gatewayNamespace: "synthetic-gateway",
      environmentId: "synthetic-environment",
      workspaceDir: state.workspaceDir,
      homeDir: state.home,
      sourceManifestRef: `sha256:${"c".repeat(64)}`,
      preparedManifestRef: `sha256:${"d".repeat(64)}`,
    };
    await store.register(registration);
    const replacement = {
      ...registration,
      sourceManifestRef: `sha256:${"e".repeat(64)}`,
      preparedManifestRef: `sha256:${"f".repeat(64)}`,
    };
    for (const changed of [
      { preparationKey: "0".repeat(64) },
      { cacheKey: "0".repeat(64) },
      { gatewayNamespace: "another-gateway" },
      { environmentId: "another-environment" },
      { workspaceDir: "/another-workspace" },
      { homeDir: "/another-home" },
    ]) {
      await expect(store.register({ ...replacement, ...changed })).rejects.toThrow(
        "already owns a prepared workspace",
      );
    }
    const row = await store.register(replacement);
    expect(row).toMatchObject({
      state: "available",
      source_manifest_ref: replacement.sourceManifestRef,
      prepared_manifest_ref: replacement.preparedManifestRef,
    });
    expect(await store.find(registration.environmentId)).toEqual(row);
    const bound = await store.bind({
      action: "bind",
      preparationKey: registration.preparationKey,
      cacheKey: registration.cacheKey,
      gatewayNamespace: registration.gatewayNamespace,
      environmentId: registration.environmentId,
      sessionId: "synthetic-session",
      sessionKey: "agent:main:synthetic",
      ownerEpoch: 1,
    });
    await expect(store.register(registration)).rejects.toThrow("already owns a prepared workspace");
    expect(await store.find(registration.environmentId)).toEqual(bound);
  });
});
