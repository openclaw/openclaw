/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { AgentRowChip } from "./agent-row-chip.tsx";

afterEach(() => document.body.replaceChildren());

it("uses loaded agent names and avatars, preserving default and unknown ownership without requests", async () => {
  const request = vi.fn(async () => ({}));
  const context = createContext(
    createGateway(createTestGatewayClient(request)),
    createSessions("research", []),
    {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "Home agent", identity: { emoji: "🏡" } },
        { id: "research", name: "Research", identity: { emoji: "🔬" } },
      ],
    },
  );
  const { container: provider } = mountSolid(
    () =>
      [undefined, "research", "retired"].map((agentId) =>
        createComponent(AgentRowChip, { agentId }),
      ),
    { wrapper: createSolidApplicationContextProvider(context).wrapper },
  );
  flush();
  expect(
    [...provider.querySelectorAll(".agent-row-chip__name")].map((chip) => chip.textContent),
  ).toEqual(["Home agent", "Research", "retired"]);
  expect(
    [...provider.querySelectorAll(".identity-avatar__text")].map((chip) =>
      chip.getAttribute("data-avatar"),
    ),
  ).toEqual(["🏡", "🔬"]);
  await vi.waitFor(() =>
    expect(
      provider.querySelector('[data-agent-id="retired"] .identity-avatar__agent-face'),
    ).not.toBeNull(),
  );
  expect(
    [...provider.querySelectorAll(".agent-row-chip")].map((chip) => [
      chip.getAttribute("data-agent-id"),
      chip.getAttribute("aria-label"),
      chip.getAttribute("title"),
    ]),
  ).toEqual([
    ["main", "Home agent (agent:main)", "Home agent (agent:main)"],
    ["research", "Research (agent:research)", "Research (agent:research)"],
    ["retired", "agent:retired", "agent:retired"],
  ]);
  expect(request).not.toHaveBeenCalled();
});

it("updates a mounted chip when the identity owner publishes", async () => {
  const client = createTestGatewayClient(async () => ({
    agentId: "research",
    name: "Research Lab",
    emoji: "🧪",
  }));
  const gateway = createGateway(client);
  const identities = createAgentIdentityCapability(gateway);
  const context = createContext(gateway, createSessions("research", []), null, [], identities);
  const { container: provider } = mountSolid(
    () => createComponent(AgentRowChip, { agentId: "research" }),
    { wrapper: createSolidApplicationContextProvider(context).wrapper },
  );
  flush();
  const chip = provider.querySelector("openclaw-agent-row-chip");
  expect(provider.querySelector(".agent-row-chip__name")?.textContent).toBe("research");

  await identities.ensure(["research"]);
  await waitForSolid(() => {
    expect(provider.querySelector(".agent-row-chip__name")?.textContent).toBe("Research Lab");
    expect(provider.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe(
      "🧪",
    );
  });
  expect(provider.querySelector("openclaw-agent-row-chip")).toBe(chip);
});

it("leaves retained chip DOM untouched when only the parent's loading state changes", () => {
  const context = createContext(
    createGateway(createTestGatewayClient(async () => ({}))),
    createSessions("research", []),
    {
      defaultId: "research",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "research", name: "Research", identity: { emoji: "🔬" } }],
    },
  );
  const [parent, setParent] = createSignal({ agentId: "research", loading: false });
  const { container } = mountSolid(
    () =>
      createComponent(AgentRowChip, {
        get agentId() {
          return parent().agentId;
        },
      }),
    { wrapper: createSolidApplicationContextProvider(context).wrapper },
  );
  flush();
  const observer = new MutationObserver(() => undefined);
  observer.observe(container, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  setParent({ agentId: "research", loading: true });
  flush();
  const mutations = observer.takeRecords();
  observer.disconnect();
  expect(mutations).toEqual([]);
});
