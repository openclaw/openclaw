import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { NodeRegistry } from "./node-registry.js";
import { makeClient, registerNodeSession } from "./node-registry.test-helpers.js";

const registries = new Set<NodeRegistry>();
afterEach(() => {
  for (const registry of registries) {
    for (const session of registry.listConnected()) {
      registry.unregister(session.connId);
    }
  }
  registries.clear();
});

it.each(["allowed", "denied", "revoked"] as const)(
  "waits for durable dispatch authority and checks the live owner (%s)",
  async (outcome) => {
    const authorization = createDeferred<boolean>();
    const registry = new NodeRegistry();
    registries.add(registry);
    const frames: string[] = [];
    registerNodeSession(registry, makeClient("conn-1", "node-1", frames), {});
    let authorityActive = true;
    const dispatched = createDeferred<void>();
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      authorizeDispatch: () => authorization.promise,
      isDispatchAuthorized: () => authorityActive,
      onDispatchReady: () => dispatched.resolve(),
    });
    expect(frames).toEqual([]);
    authorityActive = outcome !== "revoked";
    authorization.resolve(outcome !== "denied");
    if (outcome === "allowed") {
      await dispatched.promise;
      expect(frames).toHaveLength(1);
      const frame: { payload: { id: string } } = JSON.parse(frames[0]!);
      registry.handleInvokeResult({
        id: frame.payload.id,
        nodeId: "node-1",
        connId: "conn-1",
        ok: true,
        payload: { completed: true },
      });
      await expect(invoke).resolves.toMatchObject({ ok: true });
    } else {
      await expect(invoke).resolves.toMatchObject({
        ok: false,
        error: { code: "APPROVAL_AUTHORITY_CLOSED" },
      });
      expect(frames).toEqual([]);
    }
  },
);
