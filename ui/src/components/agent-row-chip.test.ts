/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { renderAgentRowChip } from "./agent-row-chip.ts";

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
  const provider = createApplicationContextProvider(context);
  render(
    html`${renderAgentRowChip()}${renderAgentRowChip("research")}${renderAgentRowChip("retired")}`,
    provider,
  );
  document.body.append(provider);
  await Promise.all(
    [...provider.querySelectorAll("openclaw-agent-row-chip")].map((chip) => chip.updateComplete),
  );
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
  const provider = createApplicationContextProvider(context);
  render(renderAgentRowChip("research"), provider);
  document.body.append(provider);
  const chip = provider.querySelector("openclaw-agent-row-chip");
  await chip?.updateComplete;
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
