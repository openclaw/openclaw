/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
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
