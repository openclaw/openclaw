import type { ProgressCard } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import type { SidebarSessionHovercardRow } from "./app-sidebar-session-types.ts";
import { createHovercard } from "./session-progress-hovercard.test-support.ts";

const key = "agent:research:provider-probe";
const buildHref = "https://example.com/build";
const mountedProviders: HTMLElement[] = [];

function fixture(
  card: ProgressCard | null,
  rowDetails: Partial<SidebarSessionHovercardRow> = {},
  triggerKind: "sidebar" | "markdown" = "sidebar",
) {
  const h = createHovercard({ sessionKey: key, card, rowDetails, triggerKind, browser: true });
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

  it.each(["participants", "channel avatar"] as const)(
    "opens a pointer-held %s attribution card without repeating presentation work",
    async (kind) => {
      const { userEvent } = await import("vitest/browser");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const h = fixture(progress(1, "**Synthetic progress**"), {
        createdActor: {
          type: "human",
          id: "profile-ada",
          label: "Ada King",
          identity: { type: "profile", id: "profile-ada" },
        },
        ...(kind === "participants"
          ? {
              participants: [
                { identity: { type: "profile" as const, id: "profile-ada" }, label: "Ada King" },
                { identity: { type: "profile" as const, id: "profile-mira" }, label: "Mira" },
              ],
              participantCount: 2,
            }
          : { channelAvatarUrl: "/__openclaw__/channel-avatar/synthetic" }),
      });
      await h.mount();
      await userEvent.hover(h.row);
      await drainTurn(450);
      await expectText("Ada King");
      expectReads(h, 1);
      const heldPortal = portal();
      await drainTurn(500);
      expect(portal()).toBe(heldPortal);
      expect(heldPortal?.querySelector(".session-hovercard__creator-avatar")).not.toBeNull();
      expectReads(h, 1);
      await userEvent.unhover(h.row);
    },
  );

  it.each(["sidebar", "markdown"] as const)(
    "enters %s by Tab, retains the focused progress href on refresh, and returns focus when removed",
    async (triggerKind) => {
      const { userEvent } = await import("vitest/browser");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const h = fixture(progress(1, `[Open build log](${buildHref})`), {}, triggerKind);
      await h.mount();
      await h.focus();
      await waitForSolid(() =>
        expect(portal()?.querySelector(`a[href="${buildHref}"]`)).not.toBeNull(),
      );
      expect(h.getReads()).toBe(1);
      const heldPortal = portal();
      expect(document.activeElement).toBe(h.trigger);
      await userEvent.keyboard("{Tab}");
      await drainTurn();
      expect(document.activeElement?.getAttribute("href")).toBe(buildHref);

      h.change(progress(2, `Updated build: [Open build log](${buildHref})`));
      await drainTurn();
      await expectText("Updated build:");
      expect(portal()).toBe(heldPortal);
      expect(document.activeElement?.getAttribute("href")).toBe(buildHref);
      expect(h.getReads()).toBe(2);

      h.change(progress(3, "Updated build complete"));
      await drainTurn();
      await expectText("Updated build complete");
      expect(portal()).toBe(heldPortal);
      expect(document.activeElement).toBe(h.trigger);
      expect(h.getReads()).toBe(3);
      await userEvent.keyboard("{Escape}");
      expect(portal()).toBeNull();
      expect(h.trigger.hasAttribute("aria-controls")).toBe(false);
    },
  );
});
