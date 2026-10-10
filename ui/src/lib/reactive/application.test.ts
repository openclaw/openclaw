/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import { AssistantDock } from "../../app/assistant-dock.ts";
import { createApplicationNavigationPreferences } from "../../app/bootstrap-navigation-preferences.ts";
import { chatInputOwnerForContext } from "../../app/chat-input-owner.ts";
import { createChatSubmissions } from "../../app/chat-submissions.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
  stubGatewayStoreTestGlobals,
} from "../../app/gateway-store.test-support.ts";
import { loadSettings } from "../../app/settings.ts";
import { verifyApplicationProjection } from "./application-test-support.ts";
import {
  projectAgentSelection,
  projectApplicationConfig,
  projectAssistantDock,
  projectChatCreation,
  projectChatInputOwner,
  projectGateway,
  projectGatewayEventLog,
  projectGatewayEvents,
  projectNavigationPreferences,
} from "./application.ts";

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

  it("acquires raw diagnostic history only while observed and releases its buffer", () => {
    const first = createGatewayStoreTestStore();
    const second = createGatewayStoreTestStore();
    const projection = projectGatewayEventLog(first.gateway);
    try {
      first.gateway.start();
      second.gateway.start();
      first.current().opts.onEvent?.(createGatewayEvent("first"));
      expect(projection.read().entries).toEqual([]);
      const stop = projection.subscribe(() => {});
      first.current().opts.onEvent?.(createGatewayEvent("captured"));
      expect(projection.read().entries.map((entry) => entry.event)).toEqual(["captured"]);
      projection.replaceSource(second.gateway);
      expect(first.gateway.eventLog).toEqual([]);
      expect(projection.read().entries).toEqual([]);
      second.current().opts.onEvent?.(createGatewayEvent("replacement"));
      expect(projection.read().entries.map((entry) => entry.event)).toEqual(["replacement"]);
      stop();
      expect(second.gateway.eventLog).toEqual([]);
      projection.dispose();
    } finally {
      projection.dispose();
      first.gateway.stop();
      second.gateway.stop();
    }
  });

  it("delivers repeated Gateway events and fences the replaced transport", () => {
    const first = createGatewayStoreTestStore();
    const second = createGatewayStoreTestStore();
    first.gateway.start();
    second.gateway.start();
    const projection = projectGatewayEvents(first.gateway);
    const received: string[] = [];
    projection.subscribe((event) => received.push(event.event));
    const emit = () => first.current().opts.onEvent?.(createGatewayEvent("repeat"));
    emit();
    emit();
    projection.replaceSource(second.gateway);
    emit();
    second.current().opts.onEvent?.(createGatewayEvent("next"));
    projection.dispose();
    second.current().opts.onEvent?.(createGatewayEvent("retired"));
    expect(received).toEqual(["repeat", "repeat", "next"]);
    first.gateway.stop();
    second.gateway.stop();
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

  it("keeps local navigation presentation with its preference owner", async () => {
    await verifyApplicationProjection({
      create: () => {
        const source = createApplicationNavigationPreferences({
          settings: loadSettings(),
          subscribe: () => () => {},
        });
        return { source, update: () => source.update({ navCollapsed: true }) };
      },
      project: projectNavigationPreferences,
      select: (value) => value.navCollapsed,
      initial: false,
      updated: true,
    });
  });

  it("reads dock ownership changes without issuing dock commands", async () => {
    await verifyApplicationProjection({
      create: () => {
        const source = new AssistantDock();
        return {
          source,
          update: () => {
            source.attach({
              openSessionKey: "agent:main:dock",
              openSession() {},
              closeSession() {},
            });
          },
        };
      },
      project: projectAssistantDock,
      select: (value) => value,
      initial: null,
      updated: "agent:main:dock",
    });
  });

  it("follows the application-scoped composer owner", async () => {
    await verifyApplicationProjection({
      create: () => {
        const source = chatInputOwnerForContext({});
        return { source, update: () => source.claim("dock") };
      },
      project: projectChatInputOwner,
      select: (value) => value,
      initial: "page",
      updated: "dock",
    });
  });

  it("projects only creation metadata, leaving revocable message access at its owner", async () => {
    await verifyApplicationProjection({
      create: () => {
        const source = createChatSubmissions();
        return {
          source,
          update: () => {
            source.beginCreate({
              creation: { sessionKey: "agent:main:create", admitted: false },
              message: null,
              canDisplay: () => false,
            });
          },
          dispose: () => source.clear(),
        };
      },
      project: projectChatCreation,
      select: (value) => value?.sessionKey,
      initial: undefined,
      updated: "agent:main:create",
    });
  });
});
