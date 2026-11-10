/* @vitest-environment jsdom */
import { createEffect, createRoot, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import {
  createGatewayStoreTestStore,
  stubGatewayStoreTestGlobals,
} from "../../app/gateway-store.test-support.ts";
import { createGatewayHarness } from "../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { verifyApplicationProjection } from "./application-test-support.ts";
import { projectAgentSelection, projectApplicationConfig, projectGateway } from "./application.ts";

beforeEach(() => stubGatewayStoreTestGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("application projections", () => {
  it("isolates Gateway owners and releases each consumer independently", async () => {
    await verifyApplicationProjection({
      create: () => {
        const { gateway } = createGatewayStoreTestStore();
        return {
          source: gateway,
          update: () => gateway.setSessionKey("agent:main:projected"),
          dispose: () => gateway.stop(),
        };
      },
      project: projectGateway,
      select: (value) => value.snapshot.sessionKey,
      initial: "main",
      updated: "agent:main:projected",
    });
  });

  it("shares one Gateway observation across independent render consumers", () => {
    const initialClient = createTestGatewayClient(async () => ({}));
    const replacementClient = createTestGatewayClient(async () => ({}));
    const harness = createGatewayHarness(initialClient);
    const { gateway } = harness;
    const nativeSubscribe = gateway.subscribe.bind(gateway);
    const release = vi.fn();
    const subscribe = vi.spyOn(gateway, "subscribe").mockImplementation((notify) => {
      const stop = nativeSubscribe(notify);
      return () => {
        release();
        stop();
      };
    });
    const first = projectGateway(gateway);
    const second = projectGateway(gateway);
    const seen: Array<typeof initialClient | null> = [];
    const stopFirst = createRoot((dispose) => {
      createEffect(
        () => first.read().snapshot.client,
        () => {},
      );
      return dispose;
    });
    const stopSecond = createRoot((dispose) => {
      createEffect(
        () => second.read().snapshot.client,
        (client) => {
          seen.push(client);
        },
      );
      return dispose;
    });
    flush();
    try {
      expect(second).toBe(first);
      expect(subscribe).toHaveBeenCalledOnce();
      harness.publish({ client: replacementClient });
      expect(second.read().snapshot.client).toBe(replacementClient);
      flush();
      expect(seen).toEqual([initialClient, replacementClient]);
      stopFirst();
      flush();
      expect(release).not.toHaveBeenCalled();
      harness.publish({ client: initialClient });
      flush();
      expect(seen.at(-1)).toBe(initialClient);
      stopSecond();
      flush();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      stopFirst();
      stopSecond();
      subscribe.mockRestore();
    }
  });

  it("projects accepted bootstrap configuration", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ serverVersion: "projected-version" }),
      })),
    );
    await verifyApplicationProjection({
      create: () => {
        const source = createApplicationConfigCapability({ resourceBasePath: "" });
        return { source, update: () => source.refresh() };
      },
      project: projectApplicationConfig,
      select: (value) => value.serverVersion,
      initial: null,
      updated: "projected-version",
    });
  });

  it("preserves explicit same-agent intent revisions", async () => {
    await verifyApplicationProjection({
      create: () => {
        const { gateway } = createGatewayStoreTestStore();
        const source = createAgentSelectionCapability(gateway, {
          state: { agentsList: null },
          subscribe: () => () => {},
        });
        return { source, update: () => source.set(null), dispose: () => source.dispose() };
      },
      project: projectAgentSelection,
      select: (value) => ({ id: value.state.selectedId, intent: value.intentRevision }),
      initial: { id: null, intent: 0 },
      updated: { id: null, intent: 1 },
    });
  });
});
