import { flush } from "@solidjs/signals";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createAgentIdentityCapability } from "../agents/identity.ts";
import { createAgentCapability } from "../agents/index.ts";
import { rosterActivityStore } from "../agents/roster-activity-store.ts";
import { createChannelCapability } from "../channels/index.ts";
import { createRuntimeConfigCapability } from "../config/runtime-config-capability.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../sessions/session-capability.test-support.ts";
import {
  projectAgentFiles,
  projectAgentIdentity,
  projectAgents,
  projectChannels,
  projectRosterActivity,
  projectRuntimeConfig,
  projectSessionCreated,
  projectSessionList,
  projectSessions,
} from "./domain-capabilities.ts";

describe("domain capability projections", () => {
  it("delivers created sessions from only the current capability until disposal", async () => {
    const createOwner = (key: string) => {
      const source = createApplicationGateway();
      const client = createTestGatewayClient(async (method) => {
        if (method === "sessions.create") {
          return { key };
        }
        if (method === "sessions.list") {
          return sessionsResult([], 1);
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      source.publish({ ...source.gateway.snapshot, client, phase: "connected" });
      return createTestSessionCapability(source.gateway);
    };
    const first = createOwner("agent:main:first-created");
    const second = createOwner("agent:main:second-created");
    const projection = projectSessionCreated(first);
    onTestFinished(() => projection.dispose());
    const delivered: string[] = [];
    projection.subscribe((key) => {
      delivered.push(key);
    });
    await expect(first.create({ agentId: "main" })).resolves.toBe("agent:main:first-created");
    expect(delivered).toEqual(["agent:main:first-created"]);

    projection.replaceSource(second);
    await expect(first.create({ agentId: "main" })).resolves.toBe("agent:main:first-created");
    expect(delivered).toEqual(["agent:main:first-created"]);
    await expect(second.create({ agentId: "main" })).resolves.toBe("agent:main:second-created");
    expect(delivered).toEqual(["agent:main:first-created", "agent:main:second-created"]);

    projection.dispose();
    await expect(second.create({ agentId: "main" })).resolves.toBe("agent:main:second-created");
    expect(delivered).toEqual(["agent:main:first-created", "agent:main:second-created"]);
  });

  it("publishes mutable agent state and scopes file and identity reads to the selected agent", async () => {
    const source = createApplicationGateway();
    const client = createTestGatewayClient(async (method, params) => {
      if (method === "agents.list") {
        return {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main" }],
        };
      }
      if (method === "agents.files.list") {
        return { agentId: "main", workspace: "/fixture", files: [{ name: "IDENTITY.md" }] };
      }
      if (method === "agent.identity.get") {
        return { agentId: (params as { agentId: string }).agentId, name: "Fixture" };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const agents = createAgentCapability(source.gateway);
    const identities = createAgentIdentityCapability(source.gateway);
    const state = projectAgents(agents);
    const files = projectAgentFiles({ agents, agentId: "main" });
    const identity = projectAgentIdentity({ identities, agentId: "main" });
    const changed = vi.fn();
    state.subscribe(changed);
    files.subscribe(() => {});
    identity.subscribe(() => {});
    onTestFinished(() => {
      state.dispose();
      files.dispose();
      identity.dispose();
      agents.dispose();
    });
    const original = state.read();
    expect(original.agentsList).toBeNull();
    expect(identity.read()).toBeNull();
    source.publish({ ...source.gateway.snapshot, client, phase: "connected" });
    await agents.ensureList();
    await agents.ensureFiles("main");
    await identities.ensure(["main"]);
    expect(state.read()).toBe(original);
    expect(state.read().agentsList?.agents).toEqual([{ id: "main" }]);
    expect(changed).toHaveBeenCalled();
    expect(files.read().list?.files).toEqual([{ name: "IDENTITY.md" }]);
    expect(identity.read()?.name).toBe("Fixture");
    files.replaceSource({ agents, agentId: "other" });
    identity.replaceSource({ identities, agentId: "other" });
    expect(files.read().list).toBeNull();
    expect(identity.read()).toBeNull();
  });

  it("retains the roster owner's first/last upstream acquisition", () => {
    const source = createApplicationGateway();
    const agents = createAgentCapability(source.gateway);
    const agentIdentity = createAgentIdentityCapability(source.gateway);
    const sessions = createTestSessionCapability(source.gateway);
    onTestFinished(() => agents.dispose());
    const subscribe = vi.spyOn(agents, "subscribe");
    const roster = rosterActivityStore({
      gateway: source.gateway,
      agents,
      agentIdentity,
      sessions,
    });
    const projection = projectRosterActivity(roster);
    onTestFinished(() => projection.dispose());
    expect(projection.read().involvingMe).toBe(false);
    expect(subscribe).not.toHaveBeenCalled();
    const first = projection.subscribe(() => {});
    const second = projection.subscribe(() => {});
    expect(subscribe).toHaveBeenCalledOnce();
    const before = projection.revision();
    roster.setInvolvingMe(true);
    flush();
    expect(projection.read().involvingMe).toBe(true);
    expect(projection.revision()).toBeGreaterThan(before);
    first();
    second();
    expect(projection.read().cards).toEqual([]);
    projection.subscribe(() => {});
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("invalidates channel state on the real connection boundary", () => {
    const source = createApplicationGateway();
    const channels = createChannelCapability(source.gateway);
    const projection = projectChannels(channels);
    const changed = vi.fn();
    projection.subscribe(changed);
    onTestFinished(() => channels.dispose());
    onTestFinished(() => projection.dispose());
    expect(projection.read().connected).toBe(false);
    source.publish({ ...source.gateway.snapshot, phase: "connected" });
    expect(projection.read().connected).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    projection.dispose();
    source.publish({ ...source.gateway.snapshot, phase: "stopped" });
    expect(changed).toHaveBeenCalledOnce();
  });

  it("reads config permissions with the mutable draft snapshot", () => {
    const source = createApplicationGateway();
    const config = createRuntimeConfigCapability(source.gateway);
    const projection = projectRuntimeConfig(config);
    projection.subscribe(() => {});
    onTestFinished(() => config.dispose());
    onTestFinished(() => projection.dispose());
    expect(projection.read().canSet).toBe(false);
    config.setRaw('{"agents":{}}');
    flush();
    expect(projection.read().state.configRaw).toBe('{"agents":{}}');
    expect(projection.revision()).toBeGreaterThan(0);
  });

  it("publishes session facts outside the primary snapshot", () => {
    const source = createApplicationGateway();
    const sessions = createTestSessionCapability(source.gateway);
    const projection = projectSessions(sessions);
    projection.subscribe(() => {});
    onTestFinished(() => projection.dispose());
    expect(projection.read().state.result).toBeNull();
    sessions.setPullRequestSummary("agent:main:main", { numbers: [42], state: "open" });
    flush();
    expect(projection.read().revision).toBeGreaterThan(0);
    expect(projection.revision()).toBeGreaterThan(0);
  });

  it("rebinds managed lists without mixing agent query membership", async () => {
    const source = createApplicationGateway();
    const client = createTestGatewayClient(async (method, params) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected method: ${method}`);
      }
      const agentId = (params as { agentId: string }).agentId;
      return sessionsResult([{ key: `agent:${agentId}:task`, kind: "direct" }], 1);
    });
    source.publish({ ...source.gateway.snapshot, client, phase: "connected" });
    const sessions = createTestSessionCapability(source.gateway);
    const firstScope = { agentId: "main", archivedFilter: "all" as const };
    const list = projectSessionList({ sessions, scope: firstScope });
    list.subscribe(() => {});
    onTestFinished(() => list.dispose());
    await sessions.refreshList(firstScope);
    expect(list.read().result?.sessions.map((row) => row.key)).toEqual(["agent:main:task"]);
    const nextScope = { ...firstScope, agentId: "other" };
    list.replaceSource({ sessions, scope: nextScope });
    expect(list.read().result).toBeNull();
    await sessions.refreshList(nextScope);
    expect(list.read().result?.sessions.map((row) => row.key)).toEqual(["agent:other:task"]);
  });
});
