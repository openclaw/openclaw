/* @vitest-environment jsdom */
import { createComponent, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import * as themeBranding from "../app/theme-branding.ts";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
import * as avatarGateway from "../lib/identity-avatar-context.ts";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { allMutationObserverOptions } from "../test-helpers/dom-probe.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { AgentRowChip } from "./agent-row-chip.tsx";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
const agents = [
  { id: "main", name: "Home agent", identity: { emoji: "🏡" } },
  { id: "research", name: "Research", identity: { emoji: "🔬" } },
];
function mountChip(view: Parameters<typeof mountSolid>[0], liveIdentity = false) {
  const request = vi.fn(async () =>
    liveIdentity ? { agentId: "research", name: "Research Lab", emoji: "🧪" } : {},
  );
  const gateway = createGateway(createTestGatewayClient(request));
  const identities = liveIdentity ? createAgentIdentityCapability(gateway) : undefined;
  const roster: Parameters<typeof createContext>[2] = liveIdentity
    ? null
    : { defaultId: "main", mainKey: "main", scope: "per-sender", agents };
  const context = createContext(gateway, createSessions("research", []), roster, [], identities);
  const { container } = mountSolid(view, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  flush();
  return { container, request, identities };
}

it.each([
  [undefined, "main", "Home agent", "🏡", "Home agent (agent:main)"],
  ["research", "research", "Research", "🔬", "Research (agent:research)"],
  ["retired", "retired", "retired", null, "agent:retired"],
] as const)("renders %s without identity requests", async (agentId, id, name, avatar, label) => {
  const { container, request } = mountChip(() => createComponent(AgentRowChip, { agentId }));
  const chip = container.querySelector(".agent-row-chip")!;
  expect(chip).toMatchObject({ title: label, dataset: { agentId: id } });
  expect(chip.getAttribute("aria-label")).toBe(label);
  expect(container.querySelector(".agent-row-chip__name")?.textContent).toBe(name);
  expect(
    [...container.querySelectorAll(".identity-avatar__text")].map((node) =>
      node.getAttribute("data-avatar"),
    ),
  ).toEqual(avatar ? [avatar] : []);
  if (!avatar) {
    await vi.waitFor(() =>
      expect(container.querySelector(".identity-avatar__agent-face")).not.toBeNull(),
    );
  }
  expect(request).not.toHaveBeenCalled();
});

it("updates a mounted chip when the identity owner publishes", async () => {
  const { container, identities } = mountChip(
    () => createComponent(AgentRowChip, { agentId: "research" }),
    true,
  );
  const chip = container.querySelector("openclaw-agent-row-chip");
  expect(container.querySelector(".agent-row-chip__name")?.textContent).toBe("research");
  await identities!.ensure(["research"]);
  await waitForSolid(() => {
    expect(container.querySelector(".agent-row-chip__name")?.textContent).toBe("Research Lab");
    expect(container.querySelector(".identity-avatar__text")).toMatchObject({
      dataset: { avatar: "🧪" },
    });
  });
  expect(container.querySelector("openclaw-agent-row-chip")).toBe(chip);
});

it("leaves retained chip DOM untouched when only the parent's loading state changes", () => {
  const [parent, setParent] = createSignal({ agentId: "research", loading: false });
  const { container } = mountChip(() =>
    createComponent(AgentRowChip, {
      get agentId() {
        return parent().agentId;
      },
    }),
  );
  const observer = new MutationObserver(() => undefined);
  observer.observe(container, allMutationObserverOptions());
  setParent({ agentId: "research", loading: true });
  flush();
  const mutations = observer.takeRecords();
  observer.disconnect();
  expect(mutations).toEqual([]);
});

it("shares row and avatar subscriptions while isolating applications and retiring readers", () => {
  function application(name: string) {
    const gateway = createGateway(createTestGatewayClient(async () => ({})));
    const context = createContext(gateway, createSessions("research", []), {
      defaultId: "research",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "research", name, identity: { emoji: "🔬" } }],
    });
    const listeners = new Set<Parameters<typeof context.agents.subscribe>[0]>();
    const subscribeAgents = vi.spyOn(context.agents, "subscribe").mockImplementation((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const subscribeIdentity = vi.spyOn(context.agentIdentity, "subscribe");
    const subscribeGateway = vi.spyOn(gateway, "subscribe");
    const wrapper = createSolidApplicationContextProvider(context).wrapper;
    return {
      mount: () =>
        mountSolid(() => createComponent(AgentRowChip, { agentId: "research" }), { wrapper }),
      counts: () =>
        [subscribeAgents, subscribeIdentity, subscribeGateway].map((spy) => spy.mock.calls.length),
      listeners,
      rename(next: string) {
        context.agents.state.agentsList!.agents[0]!.name = next;
        for (const listener of listeners) {
          listener(context.agents.state);
        }
        flush();
      },
    };
  }
  const subscribeAvatar = vi.spyOn(avatarGateway, "registerAvatarGatewayReset");
  const subscribeBranding = vi.spyOn(themeBranding, "subscribeThemeBranding");
  const firstApp = application("First research");
  const first = firstApp.mount();
  const second = firstApp.mount();
  flush();
  expect(firstApp.counts()).toEqual([1, 1, 1]);
  expect(subscribeAvatar).toHaveBeenCalledOnce();
  expect(subscribeBranding).toHaveBeenCalledOnce();

  const secondApp = application("Second research");
  const separate = secondApp.mount();
  flush();
  expect(secondApp.counts()).toEqual([1, 1, 1]);
  expect(subscribeAvatar).toHaveBeenCalledOnce();
  expect(subscribeBranding).toHaveBeenCalledOnce();
  first.unmount();
  firstApp.rename("Renamed research");
  expect(second.container.querySelector(".agent-row-chip__name")?.textContent).toBe(
    "Renamed research",
  );
  expect(separate.container.querySelector(".agent-row-chip__name")?.textContent).toBe(
    "Second research",
  );
  second.unmount();
  flush();
  expect(firstApp.listeners.size).toBe(0);
  expect(secondApp.listeners.size).toBe(1);
  separate.unmount();
  flush();
  expect(secondApp.listeners.size).toBe(0);

  const remounted = firstApp.mount();
  flush();
  expect(firstApp.counts()).toEqual([2, 2, 2]);
  expect(subscribeAvatar).toHaveBeenCalledTimes(2);
  expect(subscribeBranding).toHaveBeenCalledTimes(2);
  expect(remounted.container.querySelector(".agent-row-chip__name")?.textContent).toBe(
    "Renamed research",
  );
});
