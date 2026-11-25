/* @vitest-environment jsdom */

import { assert, expect, it, onTestFinished, vi } from "vitest";
import type { AgentIdentityResult, AgentsListResult } from "../api/types.ts";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { createControlUiComponents } from "./control-ui-components.ts";

it.each([
  { agentId: "writer", rosterPresent: true, disposeVia: "handle" },
  { agentId: "", rosterPresent: false, disposeVia: "abort" },
])(
  "hydrates and updates the host avatar for $agentId, then disposes via $disposeVia",
  async ({ agentId, rosterPresent, disposeVia }) => {
    const rosterAvatar = "data:image/png;base64,cm9zdGVy";
    const identityAvatar = "data:image/png;base64,aWRlbnRpdHk=";
    let identity: AgentIdentityResult = {
      agentId: "writer",
      name: "Writer",
      avatar: identityAvatar,
    };
    const roster: AgentsListResult = {
      defaultId: "writer",
      mainKey: "main",
      scope: "per-sender",
      agents: rosterPresent
        ? [{ id: "writer", name: "Writer", identity: { avatarUrl: rosterAvatar } }]
        : [],
    };
    const request = vi.fn(async (method: string) => {
      if (method === "agent.identity.get") {
        return identity;
      }
      if (method === "agents.list") {
        return roster;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const gateway = createGateway(createTestGatewayClient(request));
    const sessions = createSessions("writer", []);
    const agentIdentity = createAgentIdentityCapability(gateway);
    const context = createContext(gateway, sessions, roster, [], agentIdentity);
    const lifetime = new AbortController();
    const onError = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const components = createControlUiComponents({
      current: () => context,
      signal: lifetime.signal,
      onError,
    });
    const handle = components.mountAgentAvatar(container, { agentId, label: "Writer" });
    onTestFinished(() => {
      lifetime.abort();
      container.remove();
    });

    await vi.dynamicImportSettled();
    await vi.waitFor(() => {
      expect(onError).not.toHaveBeenCalled();
      expect(container.querySelector("img")?.getAttribute("src")).toBe(identityAvatar);
    });

    identity = { agentId: "writer", name: "Writer", avatar: "data:image/png;base64,bmV3" };
    agentIdentity.invalidate(["writer"]);
    await vi.waitFor(() => {
      expect(container.querySelector("img")?.getAttribute("src")).toBe(identity.avatar);
    });

    if (disposeVia === "abort") {
      lifetime.abort();
    } else {
      handle.dispose();
    }
    expect(container.childElementCount).toBe(0);
    const requestCount = request.mock.calls.length;
    agentIdentity.invalidate(["writer"]);
    await Promise.resolve();
    expect(request.mock.calls).toHaveLength(requestCount);
    expect(onError).not.toHaveBeenCalled();
  },
);

function countSubscriptionLeases(source: { subscribe(listener: () => void): () => void }) {
  const subscribe = source.subscribe.bind(source);
  let active = 0;
  vi.spyOn(source, "subscribe").mockImplementation((listener) => {
    const stop = subscribe(listener);
    active += 1;
    return () => {
      active -= 1;
      stop();
    };
  });
  return () => active;
}

it("shares SDK avatar source observation across factories without crossing applications", async () => {
  async function application(prefix: string) {
    let revision = 1;
    let roster: AgentsListResult = {
      defaultId: "writer",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "writer" }, { id: "reader" }],
    };
    const avatar = (agentId: string) =>
      `data:image/png;base64,${btoa(`${prefix}:${agentId}:${revision}`)}`;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "agents.list") {
        return roster;
      }
      if (method === "agent.identity.get") {
        const { agentId } = params as { agentId: string };
        return { agentId, avatar: avatar(agentId) };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const gateway = createGateway(createTestGatewayClient(request));
    const agents = createAgentCapability(gateway);
    await agents.ensureList();
    const identities = createAgentIdentityCapability(gateway);
    const context = {
      ...createContext(gateway, createSessions("writer", []), roster, [], identities),
      agents,
    };
    const agentLeases = countSubscriptionLeases(agents);
    const identityLeases = countSubscriptionLeases(identities);
    const ensureIdentity = vi.spyOn(identities, "ensure");
    onTestFinished(() => agents.dispose());
    return {
      context,
      avatar,
      identities,
      agentLeases,
      identityLeases,
      ensureIdentity,
      refreshIdentities() {
        revision += 1;
        identities.invalidate(["writer", "reader"]);
      },
      async selectDefaultReader() {
        roster = { ...roster, defaultId: "reader" };
        await agents.refreshList();
      },
    };
  }
  const first = await application("first");
  const second = await application("second");
  const onError = vi.fn();
  const lifetimes = [new AbortController(), new AbortController(), new AbortController()] as const;
  const factories = [
    { app: first, lifetime: lifetimes[0] },
    { app: first, lifetime: lifetimes[1] },
    { app: second, lifetime: lifetimes[2] },
  ].map(({ app, lifetime }) =>
    createControlUiComponents({
      current: () => app.context,
      signal: lifetime.signal,
      onError,
    }),
  );
  const mounted = factories.flatMap((components, factoryIndex) =>
    Array.from({ length: 3 }, (_, index) => {
      const container = document.createElement("div");
      document.body.append(container);
      const handle = components.mountAgentAvatar(container, {
        agentId: index === 0 ? "" : "writer",
        label: "Writer",
      });
      return { container, handle, factoryIndex };
    }),
  );
  const mountedAvatar = (index: number) => {
    const avatar = mounted[index];
    assert(avatar, `Expected mounted avatar at index ${index}`);
    return avatar;
  };
  const image = (index: number) =>
    mountedAvatar(index).container.querySelector("img")?.getAttribute("src");
  onTestFinished(() => {
    lifetimes.forEach((lifetime) => lifetime.abort());
    mounted.forEach(({ container }) => container.remove());
    vi.restoreAllMocks();
  });
  await vi.dynamicImportSettled();
  await waitForSolid(() => {
    for (let index = 0; index < mounted.length; index += 1) {
      expect(image(index)).toBe((index < 6 ? first : second).avatar("writer"));
    }
    // One shared native subscription serves hydration and presentation.
    expect(first.agentLeases()).toBe(1);
    expect(first.identityLeases()).toBe(1);
    expect(second.agentLeases()).toBe(1);
    expect(second.identityLeases()).toBe(1);
  });

  first.ensureIdentity.mockClear();
  first.refreshIdentities();
  // Hydration remains synchronous and per mounted avatar; the owner deduplicates RPCs.
  expect(first.ensureIdentity).toHaveBeenCalledTimes(6);
  await waitForSolid(() => {
    expect(image(1)).toBe(first.avatar("writer"));
    expect(image(7)).toBe(second.avatar("writer"));
  });

  first.ensureIdentity.mockClear();
  const updatedAvatar = mountedAvatar(1);
  updatedAvatar.handle.update({ agentId: "reader", label: "Reader updated" });
  expect(first.ensureIdentity).toHaveBeenCalledWith(["reader"]);
  await waitForSolid(() => {
    expect(image(1)).toBe(first.avatar("reader"));
    expect(updatedAvatar.container.querySelector("openclaw-agent-avatar")?.option.label).toBe(
      "Reader updated",
    );
    expect(image(2)).toBe(first.avatar("writer"));
  });
  await first.selectDefaultReader();
  await waitForSolid(() => {
    expect(image(0)).toBe(first.avatar("reader"));
    expect(image(3)).toBe(first.avatar("reader"));
    expect(image(2)).toBe(first.avatar("writer"));
    expect(image(6)).toBe(second.avatar("writer"));
  });

  lifetimes[0].abort();
  await waitForSolid(() => {
    expect(first.agentLeases()).toBe(1);
    expect(first.identityLeases()).toBe(1);
  });
  mounted
    .filter(({ factoryIndex }) => factoryIndex === 1)
    .forEach(({ handle }) => handle.dispose());
  await waitForSolid(() => {
    expect(first.agentLeases()).toBe(0);
    expect(first.identityLeases()).toBe(0);
    expect(second.agentLeases()).toBe(1);
    expect(second.identityLeases()).toBe(1);
  });
  lifetimes[2].abort();
  await waitForSolid(() => {
    expect(second.agentLeases()).toBe(0);
    expect(second.identityLeases()).toBe(0);
    expect(mounted.every(({ container }) => container.childElementCount === 0)).toBe(true);
  });
  expect(onError).not.toHaveBeenCalled();
});
