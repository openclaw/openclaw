import type { ProgressCard } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { createHovercard } from "./session-progress-hovercard.test-support.ts";

const key = "agent:research:provider-probe";
const mountedProviders: HTMLElement[] = [];

function fixture(card: ProgressCard | null) {
  const h = createHovercard({ sessionKey: key, card, browser: true });
  return {
    ...h,
    async mount() {
      mountedProviders.push(h.provider);
      await h.mount();
    },
    async focus() {
      h.trigger.blur();
      h.trigger.focus();
      await drainTurn();
    },
  };
}

async function drainTurn(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  flush();
}

function portal() {
  return document.querySelector<HTMLDivElement>(".session-progress-hovercard");
}

function progress(revision: number, markdown: string): ProgressCard {
  return { sessionKey: key, revision, updatedAt: revision, markdown };
}

const expectText = (text: string) =>
  waitForSolid(() => expect(portal()?.textContent).toContain(text));
const expectReads = (h: ReturnType<typeof fixture>, count: number) =>
  expect([h.getReads(), h.getPullRequestReads()]).toEqual([count, count]);

afterEach(async () => {
  for (const provider of mountedProviders.splice(0)) {
    provider.remove();
  }
  await Promise.resolve();
  flush();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("progress hovercard provider boundary", () => {
  it("keeps caller-owned children connected when the passive provider mounts", async () => {
    let connections = 0;
    let disconnections = 0;
    class ConnectionProbe extends HTMLElement {
      connectedCallback() {
        connections += 1;
      }
      disconnectedCallback() {
        disconnections += 1;
      }
    }
    customElements.define("openclaw-progress-provider-connection-probe", ConnectionProbe);
    const h = fixture(progress(1, "Synthetic progress"));
    const child = document.createElement("openclaw-progress-provider-connection-probe");
    h.provider.append(child);
    await h.mount();
    expect({ connections, disconnections }).toEqual({ connections: 1, disconnections: 0 });
    expect(child.parentElement).toBe(h.provider);
  });

  it("follows replacement sources and retires detached provider interactions", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = fixture(progress(1, "Original gateway"));
    const replacement = fixture(progress(1, "Replacement gateway"));
    await h.mount();
    await h.focus();
    await expectText("Original gateway");
    const originalPortal = portal();
    await drainTurn(500);
    expect(portal()).toBe(originalPortal);
    expectReads(h, 1);
    h.provider.client = replacement.gateway.snapshot.client;
    await drainTurn();
    expect(portal()).toBe(originalPortal);
    await expectText("Original gateway");
    h.provider.context = replacement.provider.context;
    h.provider.gateway = replacement.gateway;
    await drainTurn();
    expect(portal()).toBeNull();
    await h.focus();
    await expectText("Replacement gateway");
    const heldPortal = portal();
    h.select("other");
    await drainTurn();
    expect(portal()).toBe(heldPortal);
    replacement.select("other");
    expect(portal()).toBeNull();
    await h.focus();
    await expectText("Replacement gateway");
    h.provider.remove();
    await drainTurn();
    expect(portal()).toBeNull();
    const reads = replacement.getReads();
    h.trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await drainTurn();
    expect(portal()).toBeNull();
    expect(replacement.getReads()).toBe(reads);
    document.body.append(h.provider);
    await h.provider.updateComplete;
    flush();
    await h.focus();
    await expectText("Replacement gateway");
  });
});
