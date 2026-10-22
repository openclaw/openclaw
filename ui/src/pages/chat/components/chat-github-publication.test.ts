/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-owner.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  paintChatPullRequests,
  clearChatPullRequests,
  publication,
  sessionBranch,
} from "./chat-pull-requests.test-support.ts";

let container: HTMLDivElement;
const query = (selector: string) => container.querySelector(selector);
const publish = () => container.querySelector<HTMLButtonElement>(".chat-pr__create");
const personalAccount = (login = "alice-tools") => ({
  state: "connected" as const,
  generation: "personal-generation",
  account: { accountId: 2, login },
  accessExpiresAtMs: null,
  refreshState: "available" as const,
  pending: null,
});

function paint(overrides: Partial<GitHubPublicationView>) {
  paintChatPullRequests(
    {
      pullRequests: [],
      status: "ready",
      onDismiss: () => {},
      branch: sessionBranch(),
      publication: publication(overrides),
    },
    container,
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  clearChatPullRequests(container);
  container.remove();
});

it.each(["system-configured", "agent-override", null] as const)(
  "renders publisher %s without redundant account controls",
  (source) => {
    const shared = source ? { source, accountId: 1, login: "system-bot" } : null;
    const onSelect = vi.fn();
    const options = { shared, personal: null, pendingPersonal: null, latestShared: null };
    paint({
      options,
      selection: shared ? { source: "shared", expected: shared } : null,
      onSelect,
    });
    expect(query('select, [role="menu"], [role="dialog"][popover]')).toBeNull();
    expect(query('[aria-label="Publication account"]')).toBeNull();
    expect(publish()?.textContent?.trim()).toBe("Publish PR");
    expect(query("[data-publication-account]")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    if (shared) {
      expect(query(".chat-pr__publication-outcome")).toBeNull();
    } else {
      expect(publish()?.disabled).toBe(true);
      expect(container.textContent).toContain("Sign in with a personal profile to use My GitHub.");
      expect(container.textContent).not.toContain(
        "applies only to this explicit Publish PR action",
      );
      paint({
        options: {
          ...options,
          shared: { source: "system-configured", accountId: 1, login: "system-bot" },
        },
        selection: null,
      });
      expect(container.textContent).not.toContain("Sign in with a personal profile");
    }
  },
);

it.each([false, true])(
  "offers radio account choices, disambiguating matching logins only: %s",
  async (sameLogin) => {
    const shared = { source: "agent-override" as const, accountId: 1, login: "agent-bot" };
    const personal = personalAccount(sameLogin ? shared.login : "alice-tools");
    const onSelect = vi.fn();
    const options = { shared, personal, pendingPersonal: null, latestShared: null };
    const paintSelection = (source: "shared" | "personal") =>
      paint({
        options,
        selection:
          source === "shared"
            ? { source, expected: shared }
            : { source, generation: personal.generation, account: personal.account },
        onSelect,
      });
    paintSelection("shared");
    const menu = query('[role="menu"]');
    expect(menu?.getAttribute("aria-label")).toBe("Publication account");
    expect(query('select, [role="dialog"][popover]')).toBeNull();
    const choices = [...menu!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    expect(choices.map((item) => [item.value, item.getAttribute("aria-checked")])).toEqual([
      ["shared", "true"],
      ["personal", "false"],
    ]);
    expect(choices[0]?.textContent).toContain("@agent-bot");
    expect(choices[1]?.textContent).toContain(sameLogin ? "@agent-bot" : "@alice-tools");
    expect(menu?.textContent?.includes("Agent override")).toBe(sameLogin);
    expect(menu?.textContent?.includes("My GitHub")).toBe(sameLogin);
    expect(menu?.textContent).not.toContain("applies only to this explicit Publish PR action");
    expect(choices[0]?.querySelector(".oc-menu-item__details svg")).not.toBeNull();
    expect(choices[1]?.querySelector(".oc-menu-item__details svg")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    container.querySelector<HTMLButtonElement>('button[aria-label="Publication account"]')!.click();
    await waitForSolid(() => expect(menu?.matches(":popover-open")).toBe(true));
    choices[1]!.click();
    await waitForSolid(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith("personal"));
    paintSelection("personal");
    await waitForSolid(() =>
      expect(choices.map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "true"]),
    );
    expect(choices[0]?.querySelector(".oc-menu-item__details svg")).toBeNull();
    expect(choices[1]?.querySelector(".oc-menu-item__details svg")).not.toBeNull();
    expect(publish()?.textContent?.trim()).toBe("Publish PR");
  },
);

it("warns about the workspace only for a selected or sole personal account", () => {
  const personal = personalAccount();
  const shared = { source: "system-configured" as const, accountId: 1, login: "system-bot" };
  const options = { shared, personal, pendingPersonal: null, latestShared: null };
  const onSelect = vi.fn();
  const paintPublication = (overrides: Partial<GitHubPublicationView>) =>
    paint({ options, onSelect, personalReady: false, ...overrides });
  paintPublication({});
  expect(publish()?.disabled).toBe(false);
  expect(container.textContent).not.toContain("reclaim the workspace");
  paintPublication({
    selection: { source: "personal", generation: personal.generation, account: personal.account },
  });
  expect(publish()?.disabled).toBe(true);
  expect(container.textContent).toContain("reclaim the workspace");
  expect(query('[role="menu"]')?.textContent).not.toContain("reclaim the workspace");
  expect(query(".chat-pr__publication-outcome")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
    "Wait for work to finish and reclaim the workspace to publish with My GitHub.",
  );
  paintPublication({ options: { ...options, shared: null }, selection: null });
  expect(publish()?.disabled).toBe(true);
  expect(publish()?.textContent?.trim()).toBe("Publish as @alice-tools");
  expect(query('[aria-label="Publication account"]')).toBeNull();
  expect(container.textContent).toContain("reclaim the workspace");
  expect(onSelect).not.toHaveBeenCalled();
});

it("keeps an admitted publication action busy until its completion settles", async () => {
  const completion = Promise.withResolvers<void>();
  const retired = Promise.withResolvers<void>();
  const readiness = { read: null, retired: retired.promise };
  const onPublish = vi.fn(() => completion.promise);
  paint({ readiness, onPublish });
  const button = publish()!;
  button.click();
  await waitForSolid(() => expect(button.disabled).toBe(true));
  expect(onPublish).toHaveBeenCalledOnce();
  paint({
    readiness,
    locked: true,
    result: {
      status: "requested",
      requestId: "request-one",
      message: "Publication was accepted.",
    },
  });
  completion.resolve();
  await waitForSolid(() => {
    expect(publish()).toBe(button);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain("Check");
  });
  expect(container.textContent).toContain("Publication queued");
});

it("contains an unexpected action rejection in the publication error boundary", async () => {
  const completion = Promise.withResolvers<void>();
  paint({ onPublish: () => completion.promise });
  publish()!.click();
  completion.reject(new Error("Publication action unavailable"));
  await waitForSolid(() =>
    expect(container.textContent).toContain("Publication action unavailable"),
  );
  container.querySelector<HTMLButtonElement>(".lazy-view-error button")?.click();
  await waitForSolid(() => expect(publish()?.textContent).toContain("Publish PR"));
});

it("consumes a late action rejection after publication controls unmount", async () => {
  const completion = Promise.withResolvers<void>();
  paint({ onPublish: () => completion.promise });
  publish()!.click();
  await waitForSolid(() => expect(publish()?.disabled).toBe(true));
  clearChatPullRequests(container);
  completion.reject(new Error("Retired publication action unavailable"));
  await waitForSolid(() => expect(container.textContent).toBe(""));
});

it("consumes a rejection when the owner synchronously replaces the action control", async () => {
  const completion = Promise.withResolvers<void>();
  paint({
    onPublish: () => {
      paint({ optionsUnavailable: true, error: "Publication discovery unavailable" });
      return completion.promise;
    },
  });
  publish()!.click();
  await waitForSolid(() =>
    expect(container.querySelector('button[aria-label="Refresh publication"]')).not.toBeNull(),
  );
  completion.reject(new Error("Replaced publication action unavailable"));
  await waitForSolid(() =>
    expect(container.querySelector('button[aria-label="Refresh publication"]')).not.toBeNull(),
  );
});
