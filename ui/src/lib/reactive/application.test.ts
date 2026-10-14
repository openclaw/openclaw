/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import {
  createGatewayStoreTestStore,
  stubGatewayStoreTestGlobals,
} from "../../app/gateway-store.test-support.ts";
import { verifyApplicationProjection } from "./application-test-support.ts";
import { projectAgentSelection, projectApplicationConfig, projectGateway } from "./application.ts";

beforeEach(() => stubGatewayStoreTestGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("application projections", () => {
  it("reads and replaces the Gateway owner without retaining its old selection", async () => {
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
