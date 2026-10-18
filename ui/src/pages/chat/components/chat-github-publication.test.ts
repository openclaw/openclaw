/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-owner.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  paintChatPullRequests,
  clearChatPullRequests,
  publication,
  sessionBranch,
} from "./chat-pull-requests.test-support.ts";
import type { ChatPullRequestsProps } from "./chat-pull-requests.tsx";

describe("GitHub publication account controls", () => {
  let container: HTMLDivElement;

  function paint(props: Partial<ChatPullRequestsProps>) {
    paintChatPullRequests(
      {
        pullRequests: [],
        status: "ready",
        onDismiss: () => {},
        ...props,
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
      paint({
        branch: sessionBranch(),
        publication: publication({
          options: { shared, personal: null, pendingPersonal: null, latestShared: null },
          selection: shared ? { source: "shared", expected: shared } : null,
          onSelect,
        }),
      });
      expect(container.querySelector('select, [role="menu"], [role="dialog"][popover]')).toBeNull();
      expect(container.querySelector('[aria-label="Publication account"]')).toBeNull();
      expect(container.querySelector(".chat-pr__create")?.textContent?.trim()).toBe("Publish PR");
      expect(container.querySelector("[data-publication-account]")).toBeNull();
      expect(onSelect).not.toHaveBeenCalled();
      if (shared) {
        expect(container.querySelector(".chat-pr__publication-outcome")).toBeNull();
      } else {
        expect(container.querySelector<HTMLButtonElement>(".chat-pr__create")?.disabled).toBe(true);
        expect(container.textContent).toContain(
          "Sign in with a personal profile to use My GitHub.",
        );
        expect(container.textContent).not.toContain(
          "applies only to this explicit Publish PR action",
        );
        paint({
          branch: sessionBranch(),
          publication: publication({
            options: {
              shared: { source: "system-configured", accountId: 1, login: "system-bot" },
              personal: null,
              pendingPersonal: null,
              latestShared: null,
            },
            selection: null,
          }),
        });
        expect(container.textContent).not.toContain("Sign in with a personal profile");
      }
    },
  );

  it.each([false, true])(
    "offers radio account choices, disambiguating matching logins only: %s",
    async (sameLogin) => {
      const shared = { source: "agent-override" as const, accountId: 1, login: "agent-bot" };
      const personal = {
        state: "connected" as const,
        generation: "personal-generation",
        account: { accountId: 2, login: sameLogin ? shared.login : "alice-tools" },
        accessExpiresAtMs: null,
        refreshState: "available" as const,
        pending: null,
      };
      const onSelect = vi.fn();
      const options = { shared, personal, pendingPersonal: null, latestShared: null };
      const paintSelection = (source: "shared" | "personal") =>
        paint({
          branch: sessionBranch(),
          publication: publication({
            options,
            selection:
              source === "shared"
                ? { source, expected: shared }
                : { source, generation: personal.generation, account: personal.account },
            onSelect,
          }),
        });
      paintSelection("shared");
      const menu = container.querySelector('[role="menu"]');
      expect(menu?.getAttribute("aria-label")).toBe("Publication account");
      expect(container.querySelector('select, [role="dialog"][popover]')).toBeNull();
      const choices = [...menu!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
      expect(choices.map((item) => item.getAttribute("value"))).toEqual(["shared", "personal"]);
      expect(choices.map((item) => item.getAttribute("role"))).toEqual([
        "menuitemradio",
        "menuitemradio",
      ]);
      expect(choices.map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "false"]);
      expect(choices[0]?.textContent).toContain("@agent-bot");
      expect(choices[1]?.textContent).toContain(sameLogin ? "@agent-bot" : "@alice-tools");
      expect(menu?.textContent?.includes("Agent override")).toBe(sameLogin);
      expect(menu?.textContent?.includes("My GitHub")).toBe(sameLogin);
      expect(menu?.textContent).not.toContain("applies only to this explicit Publish PR action");
      expect(choices[0]?.querySelector(".oc-menu-item__details svg")).not.toBeNull();
      expect(choices[1]?.querySelector(".oc-menu-item__details svg")).toBeNull();
      expect(onSelect).not.toHaveBeenCalled();
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Publication account"]')!
        .click();
      await waitForSolid(() => expect(menu?.matches(":popover-open")).toBe(true));
      choices[1]!.click();
      await waitForSolid(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith("personal"));
      paintSelection("personal");
      await waitForSolid(() =>
        expect(choices.map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "true"]),
      );
      expect(choices.map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "true"]);
      expect(choices[0]?.querySelector(".oc-menu-item__details svg")).toBeNull();
      expect(choices[1]?.querySelector(".oc-menu-item__details svg")).not.toBeNull();
      expect(container.querySelector(".chat-pr__create")?.textContent?.trim()).toBe("Publish PR");
    },
  );

  it("warns about the workspace only for a selected or sole personal account", () => {
    const personal = {
      state: "connected" as const,
      generation: "personal-generation",
      account: { accountId: 2, login: "alice-tools" },
      accessExpiresAtMs: null,
      refreshState: "available" as const,
      pending: null,
    };
    const shared = { source: "system-configured" as const, accountId: 1, login: "system-bot" };
    const options = { shared, personal, pendingPersonal: null, latestShared: null };
    const onSelect = vi.fn();
    const paintPublication = (overrides: Partial<GitHubPublicationView>) =>
      paint({
        branch: sessionBranch(),
        publication: publication({ options, onSelect, personalReady: false, ...overrides }),
      });
    paintPublication({});
    expect(container.querySelector<HTMLButtonElement>("button.chat-pr__create")?.disabled).toBe(
      false,
    );
    expect(container.textContent).not.toContain("reclaim the workspace");
    paintPublication({
      selection: { source: "personal", generation: personal.generation, account: personal.account },
    });
    expect(container.querySelector<HTMLButtonElement>("button.chat-pr__create")?.disabled).toBe(
      true,
    );
    expect(container.textContent).toContain("reclaim the workspace");
    expect(container.querySelector('[role="menu"]')?.textContent).not.toContain(
      "reclaim the workspace",
    );
    expect(
      container
        .querySelector(".chat-pr__publication-outcome")
        ?.textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("Wait for work to finish and reclaim the workspace to publish with My GitHub.");
    paintPublication({ options: { ...options, shared: null }, selection: null });
    const publish = container.querySelector<HTMLButtonElement>("button.chat-pr__create");
    expect(publish?.disabled).toBe(true);
    expect(publish?.textContent?.trim()).toBe("Publish as @alice-tools");
    expect(container.querySelector('[aria-label="Publication account"]')).toBeNull();
    expect(container.textContent).toContain("reclaim the workspace");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
