import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { CronCompactJob, CronJobsListResult } from "../../../api/types.ts";
import { observeResize } from "../../../lib/reactive/observers.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { phase } from "../../../test-helpers/solid-menu.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { admittedDetailsAutomationsCache } from "./chat-details-content.ts";
import { ChatDetailsDesktopBody } from "./chat-details-desktop-body.tsx";
import { ChatDetailsEnvironment } from "./chat-details-environment.tsx";
import type { ChatDetailsSession } from "./chat-details-session.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import {
  card,
  detailsFixtureProps as props,
  createDetailsBrowserFixture,
} from "./chat-details.browser.test-support.ts";
import { ChatDetails, type ChatDetailsViewProps } from "./chat-details.tsx";
import { pullRequest } from "./chat-pull-requests.test-support.ts";
import "../../../styles/components.css";
import baseStyles from "../../../styles/base.css?inline";
import detailsStyles from "../../../styles/chat/details.css?inline";
import layoutStyles from "../../../styles/chat/layout.css?inline";

const mounted: HTMLElement[] = [];

it.each([
  { viewport: 1000, width: 700, role: "dialog" },
  { viewport: 1700, width: 1400, role: "complementary" },
])(
  "follows empty desktop section arrivals and removals ($role)",
  async ({ viewport, width, role }) => {
    await page.viewport(viewport, 900);
    const view = await fixture(
      props({ progressCard: undefined, detailsWorkspace: undefined }),
      width,
      false,
      "desktop",
    );
    await waitForSolid(() => expect(view.controller).toBeDefined());
    if (role === "dialog") {
      await waitForSolid(() => expect(view.panel.hidden).toBe(true));
      view.open(view.trigger);
      flush();
    }
    await waitForSolid(() =>
      expect(view.panel.querySelector(".chat-details-desktop-body")).not.toBeNull(),
    );
    await expect.poll(() => view.panel.hidden).toBe(true);
    expect(view.panel.inert).toBe(true);
    expect(view.pane.style.getPropertyValue("--chat-details-gutter")).toBe("");
    view.updateChat({ progressCard: card });
    await expect.poll(() => view.panel.getAttribute("role")).toBe(role);
    view.updateChat({ progressCard: undefined });
    await expect.poll(() => view.panel.hidden).toBe(true);
    expect(view.panel.inert).toBe(true);
    view.updateChat({
      detailsWorkspace: { root: "/workspace/details", label: "details", branch: "fix/sidebar" },
    });
    await expect.poll(() => view.panel.getAttribute("role")).toBe(role);
  },
);
async function fixture(
  value = props(),
  width = 600,
  fullscreen = false,
  nativePresentation?: ChatDetailsViewProps["nativePresentation"],
  contentPending?: boolean,
) {
  return createDetailsBrowserFixture(
    value,
    mounted,
    width,
    fullscreen,
    nativePresentation,
    contentPending,
  );
}
async function toggle(details: HTMLDetailsElement) {
  const changed = new Promise<void>((resolve) => {
    details.addEventListener("toggle", () => resolve(), { once: true });
  });
  details.querySelector<HTMLElement>(":scope > summary")!.click();
  await changed;
}
afterEach(() => {
  for (const element of mounted.splice(0)) {
    element.remove();
  }
});

describe("chat Details presentation", () => {
  it("keeps unchanged resize targets and observes replaced refs in the same layout object", async () => {
    await page.viewport(1700, 900);
    const view = await fixture(props(), 1320, false, "desktop", true);
    onTestFinished(observeResize([view.frame], () => {}));
    const settle = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    await settle();
    const read = vi.spyOn(view.frame, "getBoundingClientRect");
    onTestFinished(() => read.mockRestore());
    view.updateChat({ messages: [] });
    flush();
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();

    const replacement = document.createElement("div");
    replacement.style.cssText = view.frame.style.cssText;
    view.pane.append(replacement);
    const replacedRead = vi.spyOn(replacement, "getBoundingClientRect");
    onTestFinished(() => replacedRead.mockRestore());
    view.elements.frame = replacement;
    view.updateChat({ messages: [] });
    flush();
    await settle();
    expect(replacedRead).toHaveBeenCalled();
  });

  it("resolves composer observation after refs attach", () => {
    const observe = vi.spyOn(ResizeObserver.prototype, "observe");
    const pane = document.createElement("div");
    document.body.append(pane);
    mounted.push(pane);
    let input: HTMLTextAreaElement | null = null;
    try {
      mountSolid(
        () => {
          const details = createComponent(ChatDetails, {
            chat: props(),
            presentation: true,
            mobile: false,
            elements: { pane, getComposerInput: () => input },
            setRef: () => {},
          });
          input = document.createElement("textarea");
          pane.append(input);
          return details;
        },
        { container: pane },
      );
      flush();
      expect(observe.mock.calls.some(([target]) => target === input)).toBe(true);
    } finally {
      observe.mockRestore();
    }
  });

  it("keeps native resize subscriptions across equivalent parent snapshots", async () => {
    const observe = vi.spyOn(ResizeObserver.prototype, "observe");
    const unobserve = vi.spyOn(ResizeObserver.prototype, "unobserve");
    try {
      const { pane, frame, footer, update } = await fixture();
      const targets = new Set<Element>([pane, frame, footer]);
      const calls = () => observe.mock.calls.filter(([target]) => targets.has(target)).length;
      const initial = calls();
      expect(initial).toBeGreaterThan(0);
      update({ elements: { pane, frame, footer } });
      flush();
      expect(calls()).toBe(initial);
      expect(unobserve.mock.calls.filter(([target]) => targets.has(target))).toHaveLength(0);
      const replacement = document.createElement("div");
      pane.append(replacement);
      update({ elements: { pane, frame: replacement, footer } });
      flush();
      expect(observe.mock.calls.some(([target]) => target === replacement)).toBe(true);
      expect(unobserve.mock.calls.some(([target]) => target === frame)).toBe(true);
    } finally {
      observe.mockRestore();
      unobserve.mockRestore();
    }
  });

  it.each([undefined, "desktop"] as const)(
    "reserves automatic Details before the first resize delivery (presentation: %s)",
    async (nativePresentation) => {
      vi.stubGlobal("ResizeObserver", undefined);
      try {
        await page.viewport(1700, 900);
        const { conversation, panel } = await fixture(
          props(),
          1320,
          false,
          nativePresentation,
          true,
        );
        expect(panel.hidden).toBe(false);
        expect(getComputedStyle(conversation).right).toBe(
          nativePresentation === "desktop" ? "313px" : "300px",
        );
        if (nativePresentation === "desktop") {
          expect(panel.querySelector(".chat-details-session")).toBeNull();
        }
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([
    {
      label: "People count",
      section: "people",
      details: {
        selectedSession: {
          key: card.sessionKey,
          kind: "direct",
          participantCount: 2,
          participants: [],
        },
      },
    },
    {
      label: "People identities",
      section: "people",
      details: {
        selectedSession: {
          key: card.sessionKey,
          kind: "direct",
          owner: {
            actor: { type: "human", id: "alex", identity: { type: "profile", id: "alex" } },
          },
          participants: [{ identity: { type: "profile", id: "blair" } }],
        },
      },
    },
    {
      label: "Environment Changes",
      section: "environment",
      details: {
        environment: {
          uncommitted: { sessionKey: card.sessionKey, additions: 1, deletions: 0, files: [] },
        },
      },
    },
    {
      label: "Environment host",
      section: "environment",
      details: {
        selectedSession: {
          key: card.sessionKey,
          kind: "direct",
          placement: {
            state: "active",
            generation: 1,
            createdAtMs: 1,
            updatedAtMs: 1,
            stateChangedAtMs: 1,
            providerId: "cloud",
            profileId: "worker",
            environmentId: "machine",
            workspaceBaseManifestRef: "manifest",
            remoteWorkspaceDir: "/workspace/details",
            activeOwnerEpoch: 1,
            workerBundleHash: "bundle",
          },
        },
      },
    },
    {
      label: "Outputs read error",
      section: "outputs",
      details: {
        outputs: {
          artifacts: null,
          artifactsError: "Artifacts unavailable",
          dashboard: null,
          dashboardError: null,
          onOpenArtifact: vi.fn(),
          renderArtifactIcon: () => null,
          onViewAll: vi.fn(),
          renderViewAllIcon: () => null,
        },
      },
    },
    {
      label: "partial Automations cache",
      section: "automations",
      details: {
        cachedDetails: {
          locale: "en",
          automations: {
            rows: [{ id: "job", name: "Cached automation", state: "idle" }],
            more: false,
          },
        },
      },
    },
    {
      label: "published PR links",
      section: "pull-requests",
      details: { pullRequests: [pullRequest()] },
    },
    {
      label: "partial Subagents cache",
      section: "subagents",
      details: {
        cachedDetails: { locale: "en", subagents: { total: 1, rows: [], counts: [] } },
      },
    },
  ] satisfies Array<{
    label: string;
    section: "people" | "environment" | "outputs" | "subagents" | "automations" | "pull-requests";
    details: Partial<ChatDetailsProps>;
  }>)("reserves $label geometry before deferred content mounts", async ({ section, details }) => {
    await page.viewport(1700, 900);
    const view = await fixture(
      props({
        progressCard: undefined,
        detailsWorkspace: undefined,
        desktopPresentation: {
          peopleLabel: "People",
          outputsLabel: "Outputs",
          subagentsWorkingLabel: "Working",
        },
        ...details,
      }),
      1320,
      false,
      "desktop",
      true,
    );
    const before = view.conversation.getBoundingClientRect();
    expect(getComputedStyle(view.conversation).right).toBe("313px");
    expect(view.panel.hidden).toBe(false);
    if (details.cachedDetails) {
      await waitForSolid(() =>
        expect(view.panel.querySelector(`[data-details-group="${section}"]`)).not.toBeNull(),
      );
    }
    view.update({ contentPending: false });
    await waitForSolid(() =>
      expect(view.panel.querySelector(`[data-details-group="${section}"]`)).not.toBeNull(),
    );
    const after = view.conversation.getBoundingClientRect();
    expect([after.x, after.y, after.width, after.height]).toEqual([
      before.x,
      before.y,
      before.width,
      before.height,
    ]);
  });

  it("releases cached Automation geometry after settled denial or empty inventory and resets owner facts", async () => {
    await page.viewport(1700, 900);
    const first = createDeferred<CronJobsListResult<CronCompactJob>>();
    const request = createGatewayRequestMock();
    request.mockReturnValueOnce(first.promise);
    const hello = gatewayHelloForMethods(["cron.list"]);
    const snapshot = {
      ...createApplicationGateway().gateway.snapshot,
      phase: "connected" as const,
      hello: { ...hello, auth: { ...hello.auth, scopes: ["operator.read"] } },
    };
    const { gateway } = createApplicationGateway({
      ...snapshot,
      client: createTestGatewayClient(request),
    });
    const view = await fixture(
      props({
        progressCard: undefined,
        detailsWorkspace: undefined,
        pullRequestsGateway: gateway,
        cachedDetails: {
          locale: "en",
          automations: {
            rows: [{ id: "job", name: "Cached automation", state: "idle" }],
            more: false,
          },
        },
      }),
      1320,
      false,
      "desktop",
    );
    const section = () => view.panel.querySelector('[data-details-group="automations"]');
    await waitForSolid(() => {
      expect(section()).not.toBeNull();
      expect(request).toHaveBeenCalled();
    });
    expect(getComputedStyle(view.conversation).right).toBe("313px");
    first.reject(new GatewayProtocolRequestError({ code: "FORBIDDEN", message: "Not allowed" }));
    await waitForSolid(() => {
      expect(section()).toBeNull();
      expect(getComputedStyle(view.conversation).right).toBe("0px");
    });
    const next = createDeferred<CronJobsListResult<CronCompactJob>>();
    request.mockReturnValue(next.promise);
    const replacement = createApplicationGateway({
      ...snapshot,
      client: createTestGatewayClient(request),
    }).gateway;
    view.updateChat({ pullRequestsGateway: replacement });
    await waitForSolid(() => {
      expect(section()).not.toBeNull();
      expect(getComputedStyle(view.conversation).right).toBe("313px");
    });
    next.resolve({
      jobs: [],
      snapshotRevision: "empty",
      offset: 0,
      limit: 50,
      total: 0,
      hasMore: false,
      nextOffset: null,
    });
    await waitForSolid(() => {
      expect(section()).toBeNull();
      expect(getComputedStyle(view.conversation).right).toBe("0px");
    });
    request.mockReturnValue(createDeferred<CronJobsListResult<CronCompactJob>>().promise);
    view.updateChat({
      selectedSession: { key: card.sessionKey, kind: "direct", sessionId: "replacement-session" },
    });
    await waitForSolid(() => {
      expect(section()).not.toBeNull();
      expect(getComputedStyle(view.conversation).right).toBe("313px");
    });
  });

  it("does not present cached Automations without current read access", async () => {
    const { gateway, publish } = createApplicationGateway();
    const hello = gatewayHelloForMethods(["cron.list"]);
    publish({ ...gateway.snapshot, hello: { ...hello, auth: { ...hello.auth, scopes: [] } } });
    const view = await fixture(
      props({
        progressCard: undefined,
        pullRequestsGateway: gateway,
        cachedDetails: {
          locale: "en",
          automations: {
            rows: [{ id: "job", name: "Cached automation", state: "idle" }],
            more: false,
          },
        },
      }),
      1320,
      false,
      "desktop",
      true,
    );
    expect(
      admittedDetailsAutomationsCache(
        { rows: [{ id: "job", name: "Cached automation", state: "idle" }], more: false },
        gateway.snapshot,
      ),
    ).toBeUndefined();
    await waitForSolid(() =>
      expect(view.panel.querySelector(".chat-details-desktop-body")).not.toBeNull(),
    );
    await waitForSolid(() => expect(view.panel.hidden).toBe(true));
    expect(getComputedStyle(view.conversation).right).toBe("0px");
    expect(view.panel.querySelector('[data-details-group="automations"]')).toBeNull();
  });

  it.each([400, 820, 1280])(
    "keeps conversation geometry across known Environment hydration at %ipx",
    async (width) => {
      await page.viewport(width, 900);
      const view = await fixture(
        props({
          progressCard: undefined,
          detailsWorkspace: { root: "/workspace/details", label: "details", branch: "fix/sidebar" },
        }),
        width - 40,
        false,
        "desktop",
        true,
      );
      const message = document.createElement("p");
      message.textContent = "Keep the conversation steady while known session details hydrate.";
      view.conversation.prepend(message);
      const bounds = () => {
        const rect = view.conversation.getBoundingClientRect();
        return [rect.x, rect.y, rect.width, rect.height];
      };
      const proofDir = import.meta.env.VITE_OPENCLAW_STATUS_PROOF_DIR;
      if (proofDir) {
        await page.screenshot({ path: `${proofDir}/hydration-${width}-pending.png` });
      }
      const before = bounds();
      view.update({ contentPending: false });
      flush();
      if (width >= 1240) {
        await expect
          .poll(() => view.panel.querySelector('[data-details-group="environment"]'))
          .not.toBeNull();
      }
      expect(bounds()).toEqual(before);
      if (proofDir) {
        await page.screenshot({ path: `${proofDir}/hydration-${width}-ready.png` });
      }
    },
  );

  it.each(["transcript paint", "explicit open"] as const)(
    "holds automatic content until %s and retains it through later hydration",
    async (release) => {
      // A cold lazy import must not accidentally satisfy the initial hold assertion.
      await import("./chat-details-session.tsx");
      await page.viewport(1700, 900);
      const { update, open, conversation, trigger, panel } = await fixture(
        props(),
        1320,
        false,
        "desktop",
        true,
      );
      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
      expect(panel.hidden).toBe(false);
      expect(getComputedStyle(conversation).right).toBe("313px");
      expect(panel.querySelector(".chat-details-session")).toBeNull();

      if (release === "transcript paint") {
        update({ contentPending: false });
      } else {
        open(trigger);
      }
      await expect.poll(() => panel.querySelector(".chat-details-session")).not.toBeNull();
      const session = panel.querySelector(".chat-details-session");
      update({ contentPending: true });
      flush();
      expect(panel.querySelector(".chat-details-session")).toBe(session);
      expect(panel.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
    },
  );

  it("automatically docks within the available pane, preserves intent, and releases its column", async () => {
    await page.viewport(1700, 900);
    const { update, updateChat, frame, conversation, footer, trigger, panel } = await fixture(
      props({
        detailsWorkspace: {
          root: "/workspace/details",
          label: "details",
          branch: "feature/docking",
        },
      }),
      1320,
    );
    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
    // The first docked view also resolves the lazy session module.
    await expect
      .poll(() => panel.querySelector(".chat-details-session"), { timeout: 5_000 })
      .not.toBeNull();
    const session = panel.querySelector<ChatDetailsSession>("openclaw-chat-details-session")!;
    expect(panel.getAttribute("role")).toBe("complementary");
    expect(panel.querySelector(".chat-details__toolbar")).toBeNull();
    const groupStyle = getComputedStyle(panel.querySelector(".chat-details-desktop-section")!);
    expect(groupStyle.borderTopWidth).toBe("0px");
    expect(groupStyle.borderInlineStartWidth).toBe("0px");
    expect(groupStyle.borderBottomWidth).toBe("0px");
    expect(panel.matches(":popover-open")).toBe(false);
    expect(conversation.getBoundingClientRect().right).toBeLessThanOrEqual(
      panel.getBoundingClientRect().left,
    );
    expect(footer.getBoundingClientRect().right).toBeLessThanOrEqual(
      panel.getBoundingClientRect().left,
    );
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const metadata = session.querySelector(".chat-details-session")!;
    // A side panel consumes pane width even when the desktop stays wide.
    frame.style.width = "900px";
    await expect
      .poll(() => trigger.getAttribute("aria-expanded"), { timeout: 5_000 })
      .toBe("false");
    expect(conversation.getBoundingClientRect().width).toBe(900);
    frame.style.width = "1320px";
    await expect.poll(() => trigger.getAttribute("aria-expanded"), { timeout: 5_000 }).toBe("true");
    expect(session.querySelector(".chat-details-session")).toBe(metadata);
    expect(metadata.querySelector(":scope > summary")).toBeNull();
    trigger.click();
    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
    expect(conversation.getBoundingClientRect().width).toBe(1320);
    updateChat({ progressCard: { ...card, revision: 4 } });
    frame.style.width = "900px";
    flush();
    frame.style.width = "1320px";
    update({ presentation: false });
    flush();
    update({ presentation: true });
    flush();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.click();
    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
    // ResizeObserver and the native popover settle on the browser's rendering turn.
    const shown = new Promise<void>((resolve) => {
      panel.addEventListener("toggle", () => resolve(), { once: true });
    });
    frame.style.width = "600px";
    await shown;
    expect(panel.matches(":popover-open")).toBe(true);
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(conversation.getBoundingClientRect().width).toBe(600);
    frame.style.width = "1320px";
    await expect.poll(() => panel.getAttribute("role"), { timeout: 5_000 }).toBe("complementary");
    expect(panel.matches(":popover-open")).toBe(false);
    update({ presentation: false });
    flush();
    expect(panel.hidden).toBe(true);
    expect(conversation.getBoundingClientRect().width).toBe(1320);
  });

  it("positions above its supplied footer when unrelated matching DOM precedes it", async () => {
    const { frame, footer, trigger, panel } = await fixture();
    const unrelatedFooter = document.createElement("div");
    unrelatedFooter.className = "chat-footer";
    unrelatedFooter.style.cssText = "position:absolute;top:0;height:20px";
    frame.prepend(unrelatedFooter);
    trigger.click();
    flush();
    expect(panel.matches(":popover-open")).toBe(true);
    expect(Number.parseFloat(panel.style.maxHeight)).toBeCloseTo(
      footer.getBoundingClientRect().top - 8 - Number.parseFloat(panel.style.top),
    );
  });

  it("keeps first-attached Details insets stable and aligns the Environment diff below its branch label", async () => {
    await page.viewport(1000, 800);
    const openChanges = vi.fn();
    const styles = document.createElement("style");
    styles.textContent = [baseStyles, layoutStyles, detailsStyles].join("\n");
    document.head.append(styles);
    const panel = document.createElement("section");
    panel.className = "chat-details";
    panel.setAttribute("data-desktop", "");
    panel.style.cssText = "position:relative;inset:auto;width:600px;max-width:none;height:400px";
    document.body.append(panel);
    mounted.push(panel, styles);
    mountSolid(
      () =>
        createComponent(ChatDetailsDesktopBody, {
          presented: true,
          get children() {
            return () =>
              createComponent(ChatDetailsEnvironment, {
                details: props({
                  detailsWorkspace: {
                    root: "/workspace/details",
                    label: null,
                    branch: "feature/details",
                  },
                }),
                presented: true,
                onOpenUncommitted: openChanges,
                uncommitted: {
                  sessionKey: card.sessionKey,
                  branch: "feature/details",
                  baseRef: "HEAD",
                  files: [{ path: "example.ts", status: "modified", additions: 3, deletions: 1 }],
                  additions: 3,
                  deletions: 1,
                },
              });
          },
        }),
      { container: panel },
    );
    flush();
    const heading = panel.querySelector(".chat-details-desktop-section__heading")!;
    const expectHeadingInsets = () => {
      const panelBounds = panel.getBoundingClientRect();
      const headingBounds = heading.getBoundingClientRect();
      expect(headingBounds.left - panelBounds.left).toBeCloseTo(17);
      expect(panelBounds.right - headingBounds.right).toBeCloseTo(17);
    };
    // Measure both widths before the scroll owner's first scheduled layout read.
    for (const width of [600, 300]) {
      panel.style.width = width + "px";
      expectHeadingInsets();
    }
    // The Environment body loads lazily; capture its controls only after it renders.
    await expect
      .poll(() => panel.querySelector(".chat-environment__branch-controls button.chat-pr__diff"))
      .not.toBeNull();
    const navigation = panel.querySelector<HTMLButtonElement>(
      ".chat-environment__branch-controls button.chat-pr__diff",
    )!;
    const branchLabel = panel.querySelector(".chat-environment__branch-name")!;
    await new Promise(requestAnimationFrame);
    expectHeadingInsets();
    expect(navigation.getAttribute("aria-label")).toBe("Show session changes");
    expect(navigation.textContent).toContain("+3");
    expect(navigation.textContent).toContain("−1");
    for (const width of [600, 300]) {
      panel.style.width = width + "px";
      const row = navigation.getBoundingClientRect();
      const headingBounds = heading.getBoundingClientRect();
      const branchBounds = branchLabel.getBoundingClientRect();
      expect(Math.abs(row.left - branchBounds.left)).toBeLessThanOrEqual(1);
      expect(row.top).toBeGreaterThanOrEqual(branchBounds.bottom);
      expect(row.left).toBeGreaterThanOrEqual(headingBounds.left);
      expect(row.right).toBeLessThanOrEqual(headingBounds.right);
      expect(row.height).toBeGreaterThanOrEqual(
        Number.parseFloat(getComputedStyle(navigation).lineHeight),
      );
      expect(navigation.scrollHeight).toBeLessThanOrEqual(navigation.clientHeight);
      expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
    }
    const beforeHover = navigation.getBoundingClientRect().toJSON();
    await page.getByRole("button", { name: "Show session changes", exact: true }).hover();
    expect(navigation.getBoundingClientRect().toJSON()).toEqual(beforeHover);
    navigation.focus();
    expect(navigation.getBoundingClientRect().toJSON()).toEqual(beforeHover);
    await page.getByRole("button", { name: "Show session changes", exact: true }).click();
    expect(openChanges).toHaveBeenCalledOnce();
  });

  it("starts closed, stays closed on revisions, and returns Escape focus to its labeled trigger", async () => {
    const { updateChat, trigger, panel } = await fixture();
    expect(trigger.textContent).toContain("Details");
    expect(panel.matches(":popover-open")).toBe(false);
    expect(panel.querySelector("openclaw-chat-details-session")).toBeNull();
    updateChat({ progressCard: { ...card, revision: 2 } });
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    trigger.click();
    flush();
    expect(panel.matches(":popover-open")).toBe(true);
    await expect.poll(() => panel.querySelector(".chat-details-session")).not.toBeNull();
    expect(panel.querySelector(".chat-details__toolbar")).toBeNull();
    panel.querySelector<HTMLButtonElement>("button")!.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("opens full-width mobile Details from Panels and restores focus to that control", async () => {
    await page.viewport(420, 720);
    const { update, open, frame, trigger, panel } = await fixture(props(), 380);
    update({ mobile: true, contentPending: true });
    const source = document.createElement("button");
    source.textContent = "Panels";
    frame.prepend(source);
    flush();
    expect(trigger.hidden).toBe(true);
    open(source);
    flush();
    expect(panel.matches(":popover-open")).toBe(true);
    expect(panel.getBoundingClientRect().width).toBe(364);
    expect(panel.querySelector(".chat-details__toolbar")).not.toBeNull();
    await expect.poll(() => panel.querySelector(".chat-details-session")).not.toBeNull();
    panel.querySelector<HTMLButtonElement>("button")!.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(source);
    open(source);
    flush();
    panel.querySelector<HTMLButtonElement>(".chat-details__toolbar button")!.click();
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(source);
    update({ presentation: false });
    flush();
    open(source);
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
  });

  it("opens fullscreen Details within the visible pane and returns focus to its external trigger", async () => {
    await page.viewport(1700, 900);
    const { open, pane, frame, trigger, panel } = await fixture(props(), 1320, true);
    const source = document.createElement("button");
    source.textContent = "Session actions";
    pane.prepend(source);
    expect(frame.checkVisibility()).toBe(false);
    expect(trigger.hidden).toBe(true);
    expect(panel.matches(":popover-open")).toBe(false);
    open(source);
    flush();
    expect(panel.matches(":popover-open")).toBe(true);
    expect(panel.checkVisibility()).toBe(true);
    expect(frame.contains(panel)).toBe(false);
    expect(pane.contains(panel)).toBe(true);
    expect(panel.getAttribute("role")).toBe("dialog");
    const bounds = panel.getBoundingClientRect();
    const paneBounds = pane.getBoundingClientRect();
    expect(bounds.width).toBe(300);
    expect(bounds.height).toBeGreaterThan(40);
    expect(bounds.left).toBeGreaterThanOrEqual(paneBounds.left);
    expect(bounds.right).toBeLessThanOrEqual(paneBounds.right);
    expect(bounds.top).toBeGreaterThanOrEqual(source.getBoundingClientRect().bottom);
    expect(bounds.bottom).toBeLessThanOrEqual(paneBounds.bottom);
    const close = panel.querySelector<HTMLButtonElement>(".chat-details__toolbar button")!;
    expect(close.checkVisibility()).toBe(true);
    expect(close.getAttribute("aria-label")).toBe("Close details");
    close.focus();
    close.click();
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(source);
    open(source);
    flush();
    close.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(source);
  });

  it("keeps its child menu open through chat updates and closes Details after it closes", async () => {
    const { trigger, panel, progress, updateChat } = await fixture();
    trigger.click();
    flush();
    const menu = progress.querySelector<HTMLElement>(".chat-details-progress__menu")!;
    const menuSurface = menu.querySelector<HTMLElement>('[role="menu"]')!;
    menu.querySelector<HTMLButtonElement>("button")!.click();
    await phase(menuSurface, "open");
    updateChat({ messages: [] });
    flush();
    expect(menuSurface.matches(":popover-open")).toBe(true);
    menu.querySelector<HTMLButtonElement>("button")!.click();
    await expect
      .poll(() => menu.querySelector("button")!.getAttribute("aria-expanded"))
      .toBe("false");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps metadata visible while progress retains its collapse across revisions", async () => {
    const { updateChat, trigger, panel, progress } = await fixture();
    trigger.click();
    flush();
    await expect.poll(() => panel.querySelector(".chat-details-session")).not.toBeNull();
    const session = panel.querySelector<ChatDetailsSession>("openclaw-chat-details-session")!;
    await session.updateComplete;
    flush();
    const sessionSection = session.querySelector<HTMLElement>(".chat-details-session")!;
    const progressSection = progress.querySelector<HTMLDetailsElement>(".task-progress-details")!;
    expect(sessionSection.querySelector(":scope > summary")).toBeNull();
    expect(progressSection.open).toBe(true);
    expect(
      session.querySelector(
        '[data-details-group="pull-requests"], [data-details-group="automations"], [data-details-group="subagents"], [data-details-group="processes"]',
      ),
    ).toBeNull();
    await toggle(progressSection);
    expect(progressSection.open).toBe(false);
    expect(
      getComputedStyle(progress.querySelector(".chat-details-progress__menu")!).display,
    ).not.toBe("none");
    updateChat({ progressCard: { ...card, revision: 3 } });
    flush();
    flush();
    expect(sessionSection.checkVisibility()).toBe(true);
    expect(progressSection.open).toBe(false);
  });

  it("constrains the popover to its conversation and above the composer after narrowing", async () => {
    const { frame, footer, trigger, panel } = await fixture();
    trigger.click();
    flush();
    for (const width of [600, 300]) {
      frame.style.width = width + "px";
      window.dispatchEvent(new Event("resize"));
      const bounds = panel.getBoundingClientRect();
      const conversation = frame.getBoundingClientRect();
      expect(
        Math.abs(
          bounds.top - Math.max(conversation.top + 8, trigger.getBoundingClientRect().bottom + 6),
        ),
      ).toBeLessThanOrEqual(1);
      expect(bounds.left).toBeGreaterThanOrEqual(conversation.left);
      expect(bounds.right).toBeLessThanOrEqual(conversation.right);
      expect(bounds.bottom).toBeLessThanOrEqual(footer.getBoundingClientRect().top);
      expect(bounds.height).toBeGreaterThan(40);
    }
  });

  it("retires the open surface on hidden presentation and session changes", async () => {
    const { update, updateChat, trigger, panel } = await fixture();
    trigger.click();
    flush();
    update({ presentation: false });
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    update({ presentation: true });
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    trigger.click();
    flush();
    updateChat({ sessionKey: "agent:main:other", selectedSession: undefined });
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
  });

  it("keeps global browser hide, lifetime dismiss, saved clear and refresh as distinct actions", async () => {
    const hide = vi.fn();
    const dismiss = vi.fn();
    const clear = vi.fn();
    const refresh = vi.fn();
    const collapse = vi.fn();
    const settings = vi.fn();
    const { update, trigger, progress } = await fixture(
      props({
        onHideTaskProgress: hide,
        onDismissProgressCard: dismiss,
        onClearSavedProgressCard: clear,
        onCollapseTaskProgressChange: collapse,
        onOpenTaskProgressSettings: settings,
        progressCardRefresh: { onRefresh: refresh },
      }),
    );
    trigger.click();
    flush();
    flush();
    const menu = progress.querySelector<HTMLElement>(".chat-details-progress__menu")!;
    const menuSurface = menu.querySelector<HTMLElement>('[role="menu"]')!;
    menu.querySelector<HTMLButtonElement>("button")!.click();
    await phase(menuSurface, "open");
    expect(progress.querySelector<HTMLDetailsElement>(".task-progress-details")!.open).toBe(true);
    const select = async (value: string) => {
      if (trigger.getAttribute("aria-expanded") !== "true") {
        trigger.click();
        flush();
        await expect
          .poll(() => menu.querySelector<HTMLButtonElement>("button")!.disabled)
          .toBe(false);
      }
      if (menu.querySelector("button")!.getAttribute("aria-expanded") !== "true") {
        menu.querySelector<HTMLButtonElement>("button")!.click();
        await phase(menuSurface, "open");
      }
      menu.querySelector<HTMLButtonElement>(`[data-value="${value}"]`)!.click();
    };
    await select("hide");
    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
    expect(hide).toHaveBeenCalledOnce();
    expect(clear).not.toHaveBeenCalled();
    await select("collapse");
    expect(collapse).toHaveBeenCalledWith(true);
    expect(progress.querySelector<HTMLDetailsElement>(".task-progress-details")!.open).toBe(true);
    await select("settings");
    expect(settings).toHaveBeenCalledOnce();
    await select("dismiss");
    expect(dismiss).toHaveBeenCalledWith(card);
    expect(clear).not.toHaveBeenCalled();
    await select("refresh");
    expect(refresh).toHaveBeenCalledWith(card);
    await select("clear");
    expect(clear).toHaveBeenCalledWith(card);
    update({ presentation: false });
    flush();
    flush();
    menu.querySelector<HTMLButtonElement>('[data-value="hide"]')!.click();
    expect(hide).toHaveBeenCalledTimes(1);
  });
});

it("keeps Environment changes readable across disclosure toggles and omits empty Participants", async () => {
  await page.viewport(1000, 800);
  const openChanges = vi.fn();
  const currentOpenChanges = vi.fn();
  const view = await fixture(
    props({
      onOpenSessionDiff: openChanges,
      environment: {
        uncommitted: {
          sessionKey: card.sessionKey,
          files: [{ path: "app.ts", status: "modified", additions: 248, deletions: 61 }],
          additions: 248,
          deletions: 61,
        },
      },
    }),
    360,
  );
  view.trigger.click();
  const action = () =>
    view.panel.querySelector<HTMLButtonElement>(
      '[data-details-group="environment"] .chat-environment__action',
    )!;
  await expect.poll(() => action()?.textContent).toContain("+248");
  const disclosure = action().closest<HTMLDetailsElement>('[data-details-group="environment"]')!;
  const heading = disclosure.querySelector<HTMLElement>(":scope > summary")!;
  for (const width of [360, 300]) {
    view.frame.style.width = width + "px";
    const row = action().getBoundingClientRect();
    const caption = heading.getBoundingClientRect();
    expect(row.left).toBeGreaterThanOrEqual(caption.left);
    expect(row.right).toBeLessThanOrEqual(caption.right);
    expect(row.top).toBeGreaterThanOrEqual(caption.bottom);
    expect(action().scrollWidth).toBeLessThanOrEqual(action().clientWidth);
  }
  await page.getByRole("button", { name: /Changes/ }).click();
  expect(openChanges).toHaveBeenCalledOnce();
  view.updateChat({ onOpenSessionDiff: currentOpenChanges });
  flush();
  heading.click();
  flush();
  expect(heading.getAttribute("aria-expanded")).toBe("false");
  expect(action().closest("[inert]")).not.toBeNull();
  heading.click();
  flush();
  expect(heading.getAttribute("aria-expanded")).toBe("true");
  expect(action().closest("[inert]")).toBeNull();
  expect(action().textContent).toContain("+248");
  expect(action().textContent).toContain("−61");
  await page.getByRole("button", { name: /Changes/ }).click();
  expect(openChanges).toHaveBeenCalledOnce();
  expect(currentOpenChanges).toHaveBeenCalledOnce();
  expect(view.session.querySelector(".chat-details__participants")).toBeNull();
  const additions = action().querySelector<HTMLElement>(".chat-environment__added")!;
  const deletions = action().querySelector<HTMLElement>(".chat-environment__removed")!;
  expect(getComputedStyle(additions).fontVariantNumeric).toBe("tabular-nums");
  expect(getComputedStyle(additions).color).not.toBe(getComputedStyle(deletions).color);
});
