/* @vitest-environment jsdom */

import { createComponent, createSignal, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-owner.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { setup, settled } from "../chat-github-publication.test-support.ts";
import { ChatDetailsEnvironment } from "./chat-details-environment.tsx";
import type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
import {
  paintChatPullRequests,
  clearChatPullRequests,
  publication,
  sessionBranch,
} from "./chat-pull-requests.test-support.ts";

let container: HTMLDivElement;
const query = (selector: string) => container.querySelector(selector);
const publish = () => container.querySelector<HTMLButtonElement>(".chat-pr__create");
let environmentView:
  | {
      update: (work: ChatPullRequestsProps) => void;
      unmount: () => void;
    }
  | undefined;

function paintEnvironment(work: ChatPullRequestsProps) {
  if (environmentView) {
    environmentView.update(work);
  } else {
    let update!: (work: ChatPullRequestsProps) => void;
    const mounted = mountSolid(
      () => {
        const [current, setCurrent] = createSignal(work);
        update = setCurrent;
        return createComponent(ChatDetailsEnvironment, {
          presented: true,
          get work() {
            return current();
          },
          get details() {
            return {
              sessionKey: "agent:main:one",
              currentAgentId: "main",
              messages: [],
              selectedSession: undefined,
              detailsWorkspace: {
                root: "/synthetic/project",
                label: "project",
                branch: current().branch?.branch,
              },
            };
          },
        });
      },
      { container },
    );
    environmentView = { update, unmount: mounted.unmount };
  }
  flush();
}

const personalAccount = (login = "alice-tools") => ({
  state: "connected" as const,
  generation: "personal-generation",
  account: { accountId: 2, login },
  accessExpiresAtMs: null,
  refreshState: "available" as const,
  pending: null,
});

function paint(
  overrides: Partial<GitHubPublicationView>,
  surface: "pull-requests" | "environment" = "pull-requests",
) {
  const work: ChatPullRequestsProps = {
    pullRequests: [],
    status: "ready",
    onDismiss: () => {},
    branch: sessionBranch(),
    publication: publication(overrides),
  };
  if (surface === "environment") {
    paintEnvironment(work);
  } else {
    paintChatPullRequests(work, container);
  }
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  environmentView?.unmount();
  environmentView = undefined;
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

it("selects an eligible profile directly from Details and publishes its exact identity", async () => {
  const { controller, request, changed } = setup();
  await settled(controller);
  request.mockResolvedValue({
    requestId: "profile-choice",
    status: "requested",
    publisher: { source: "personal", accountId: 2, login: "alice-tools" },
  });
  const draw = () =>
    paintEnvironment({
      pullRequests: [],
      status: "ready",
      onDismiss: () => {},
      branch: sessionBranch(),
      publication: controller.view(),
    });
  changed.mockImplementation(draw);
  draw();
  const create = container.querySelector<HTMLButtonElement>(
    ".chat-environment__branch button.chat-pr__create",
  );
  expect(create?.textContent).toBe("Create PR");
  expect(
    request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
  ).toHaveLength(0);
  container.querySelector<HTMLButtonElement>(".chat-pr__actions-trigger")!.click();
  await waitForSolid(() =>
    expect(query(".chat-pr-branch-menu")?.matches(":popover-open")).toBe(true),
  );
  const personal = container.querySelector<HTMLButtonElement>(
    '.chat-pr-branch-menu [role="menuitemradio"][value="personal"]',
  )!;
  expect(personal).not.toBeNull();
  expect(personal.textContent).toContain("My GitHub");
  expect(personal.textContent).toContain("@alice-tools");
  expect(query('.chat-pr-branch-menu [role="menuitemradio"]')).toBe(personal);
  expect(personal.closest('[role="menu"]')).toBe(query(".chat-pr-branch-menu"));
  personal.click();
  await waitForSolid(() => expect(controller.view()?.selection?.source).toBe("personal"));
  expect(query(".chat-pr-branch-menu")?.matches(":popover-open")).toBe(false);
  create!.click();
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("sessions.github.publish", {
      sessionKey: "agent:main:one",
      agentId: "main",
      idempotencyKey: expect.any(String),
      selection: {
        source: "personal",
        generation: "bdca439a-e787-4f9f-b5f3-a878c662cc76",
        account: { accountId: 2, login: "alice-tools" },
      },
    }),
  );
});

it.each(["personal", "confirmation"] as const)(
  "opens the native %s action from the Environment row before dispatching",
  async (state) => {
    const personal = personalAccount();
    const nativeAction = vi.fn();
    paintEnvironment({
      pullRequests: [],
      status: "ready",
      onDismiss: () => {},
      branch: sessionBranch(),
      publication: publication({
        options: { shared: null, personal, pendingPersonal: null, latestShared: null },
        selection: null,
        result:
          state === "confirmation"
            ? {
                requestId: "original-request",
                status: "needs_confirmation",
                publisher: { source: "personal", ...personal.account },
                message: "Review the original publication.",
              }
            : null,
        onPublish: nativeAction,
        onConfirm: nativeAction,
      }),
    });
    const entry = container.querySelector<HTMLButtonElement>(
      ".chat-environment__branch button.chat-pr__create",
    )!;
    expect(entry.textContent).toBe(state === "personal" ? "Create PR" : "Review");
    entry.click();
    await waitForSolid(() =>
      expect(query(".chat-pr-branch-menu")?.matches(":popover-open")).toBe(true),
    );
    expect(nativeAction).not.toHaveBeenCalled();
    const action = container.querySelector<HTMLButtonElement>(
      ".chat-pr-branch-menu .chat-pr__create",
    )!;
    expect(action.textContent).toBe(
      state === "personal" ? "Publish as @alice-tools" : "Confirm original publication",
    );
    action.click();
    expect(nativeAction).toHaveBeenCalledOnce();
  },
);

it.each([false, true])("labels publication reads as Loading (recovery=%s)", (recovery) => {
  const onPublish = vi.fn();
  const draw = (activity: GitHubPublicationView["activity"]) =>
    paintEnvironment({
      pullRequests: [],
      status: "ready",
      onDismiss: () => {},
      branch: sessionBranch(),
      publication: publication({ activity, locked: recovery, onPublish }),
    });
  draw("read");
  expect(publish()?.textContent?.trim()).toBe("Loading…");
  draw("publish");
  expect(publish()?.textContent?.trim()).toBe("Creating…");
  expect(onPublish).not.toHaveBeenCalled();
});

it.each(["pull-requests", "environment"] as const)(
  "keeps an admitted publication action busy until its completion settles (%s)",
  async (surface) => {
    const completion = Promise.withResolvers<void>();
    const retired = Promise.withResolvers<void>();
    const readiness = { read: null, retired: retired.promise };
    const onPublish = vi.fn(() => completion.promise);
    paint({ readiness, onPublish }, surface);
    const button = publish()!;
    button.click();
    await waitForSolid(() => expect(button.disabled).toBe(true));
    expect(onPublish).toHaveBeenCalledOnce();
    paint(
      {
        readiness,
        locked: true,
        result: {
          status: "requested",
          requestId: "request-one",
          message: "Publication was accepted.",
        },
      },
      surface,
    );
    completion.resolve();
    await waitForSolid(() => {
      if (surface === "pull-requests") {
        expect(publish()).toBe(button);
        expect(button.disabled).toBe(false);
        expect(button.textContent).toContain("Check");
      } else {
        expect(publish()?.textContent).toContain("Retry");
        expect(publish()?.disabled).toBe(false);
      }
    });
    expect(container.textContent).toContain("Publication queued");
  },
);

it.each(["pull-requests", "environment"] as const)(
  "contains an unexpected action rejection in the publication error boundary (%s)",
  async (surface) => {
    const completion = Promise.withResolvers<void>();
    paint({ onPublish: () => completion.promise }, surface);
    publish()!.click();
    completion.reject(new Error("Publication action unavailable"));
    await waitForSolid(() =>
      expect(container.textContent).toContain("Publication action unavailable"),
    );
    container.querySelector<HTMLButtonElement>(".lazy-view-error button")?.click();
    await waitForSolid(() =>
      expect(publish()?.textContent).toContain(
        surface === "environment" ? "Create PR" : "Publish PR",
      ),
    );
  },
);

it.each(["pull-requests", "environment"] as const)(
  "consumes a late action rejection after publication controls unmount (%s)",
  async (surface) => {
    const completion = Promise.withResolvers<void>();
    paint({ onPublish: () => completion.promise }, surface);
    publish()!.click();
    await waitForSolid(() => expect(publish()?.disabled).toBe(true));
    if (surface === "environment") {
      environmentView?.unmount();
      environmentView = undefined;
    } else {
      clearChatPullRequests(container);
    }
    completion.reject(new Error("Retired publication action unavailable"));
    await waitForSolid(() => expect(container.textContent).toBe(""));
  },
);

it.each(["pull-requests", "environment"] as const)(
  "consumes a rejection when the owner synchronously replaces the action control (%s)",
  async (surface) => {
    const completion = Promise.withResolvers<void>();
    paint(
      {
        onPublish: () => {
          paint({ optionsUnavailable: true, error: "Publication discovery unavailable" }, surface);
          return completion.promise;
        },
      },
      surface,
    );
    publish()!.click();
    await waitForSolid(() =>
      expect(container.querySelector('button[aria-label="Refresh publication"]')).not.toBeNull(),
    );
    completion.reject(new Error("Replaced publication action unavailable"));
    await waitForSolid(() =>
      expect(container.querySelector('button[aria-label="Refresh publication"]')).not.toBeNull(),
    );
  },
);
