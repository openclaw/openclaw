// @vitest-environment jsdom
import type { SkillsLibraryListResult, SkillsLibraryReceipt } from "@openclaw/gateway-protocol";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ClawHubSkillDetail } from "../../lib/skills/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { mountSkills, personalLibrary, remoteSkill } from "./skills-page.test-support.tsx";
import { libraryEntry } from "./skills.test-support.ts";
import { createSkill } from "./view.test-support.ts";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Skills discovery lifecycle", () => {
  it("keeps Discovery library status in sync with a held editor toggle", async () => {
    onTestFinished(installDialogPolyfill());
    const entry = libraryEntry();
    const mutation = deferred<SkillsLibraryReceipt>();
    const request = vi.fn(async (method: string) => {
      if (method === "skills.library.list") {
        return { ...personalLibrary, entries: [entry] };
      }
      if (method === "skills.library.read") {
        return { entry, content: "# Existing skill", files: [], revisions: [] };
      }
      if (method === "skills.library.mutate") {
        return mutation.promise;
      }
      if (method === "skills.search") {
        return { results: [] };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const { page } = mountSkills(request);
    const selector = `[data-skill-id="library:${entry.skillId}"]`;
    await waitForFast(() => expect(page.querySelector(selector)).not.toBeNull());
    const card = page.querySelector(selector)!;
    const status = () => card.querySelector(".settings-status")!.getAttribute("aria-label");
    expect(status()).toContain("Enabled");
    card.querySelector<HTMLButtonElement>(".skill-discovery-card__open")!.click();
    const { dialog } = await getRenderedModalDialog(page);
    const button = (label: string) =>
      [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === label,
      )!;
    button("Disable").click();
    try {
      await waitForFast(() => expect(button("Enable").disabled).toBe(true));
      expect(status()).toContain("Disabled");
      expect(page.querySelector(selector)).toBe(card);
    } finally {
      mutation.reject(new Error("Synthetic rejected library update"));
    }
    await waitForFast(() => {
      expect(button("Disable").disabled).toBe(false);
      expect(status()).toContain("Enabled");
      expect(dialog.textContent).toContain("Synthetic rejected library update");
    });
    expect(page.querySelector(selector)).toBe(card);
  });

  it("releases a held library save before retained surface navigation", async () => {
    onTestFinished(installDialogPolyfill());
    const pending = deferred<unknown>();
    const request = vi.fn(async (method: string) => {
      if (method === "skills.library.save") {
        return pending.promise;
      }
      if (method === "skills.library.list") {
        return personalLibrary;
      }
      return method === "skills.search" ? { results: [] } : { skills: [] };
    });
    const mounted = mountSkills(request, "settings");
    const create = () =>
      [...mounted.page.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Create skill",
      )!;
    await waitForFast(() => expect(create()?.disabled).toBe(false));
    create().click();
    flush();
    const content = mounted.page.querySelector<HTMLTextAreaElement>(
      'textarea[name="library-content"]',
    )!;
    content.value = "# Retained draft";
    content.dispatchEvent(new Event("input", { bubbles: true }));
    const slug = mounted.page.querySelector<HTMLInputElement>('input[name="library-slug"]')!;
    slug.value = "retained-draft";
    slug.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    [...mounted.page.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Save skill")!
      .click();
    await waitForFast(() => expect(content.readOnly).toBe(true));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    await mounted.router.navigate("skills", mounted.context);
    mounted.changeSurface("discovery");
    await waitForFast(() =>
      expect(mounted.page.querySelector('input[name="skills-search"]')).not.toBeNull(),
    );
    const retained = mounted.page.querySelector<HTMLTextAreaElement>(
      'textarea[name="library-content"]',
    )!;
    expect(retained.value).toBe("# Retained draft");

    pending.reject(new Error("Synthetic retained-owner save rejection"));
    await waitForFast(() => {
      expect(retained.readOnly).toBe(false);
      expect(mounted.page.textContent).toContain("Synthetic retained-owner save rejection");
    });
    expect(mounted.page.querySelector('textarea[name="library-content"]')).toBe(retained);
    expect(retained.value).toBe("# Retained draft");
  });

  it("keeps installed selection responsive while verdict enrichment refreshes", async () => {
    const report = {
      workspaceDir: "/workspace",
      managedSkillsDir: "/managed",
      skills: [
        createSkill({
          skillKey: "linked",
          name: "Linked Skill",
          clawhub: {
            status: "linked",
            valid: true,
            registry: "https://clawhub.ai",
            slug: "linked",
            installedVersion: "1.0.0",
            installedAt: 1,
            originPath: "/workspace/.clawhub/origin.json",
            lockPath: "/workspace/.clawhub/lock.json",
          },
        }),
        createSkill(),
      ],
    };
    const pending = deferred<{ items: [] }>();
    let verdictRequests = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "skills.library.list") {
        return personalLibrary;
      }
      if (method === "skills.status") {
        return report;
      }
      if (method === "skills.securityVerdicts") {
        return ++verdictRequests === 1 ? { items: [] } : pending.promise;
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const { page, publishRouteData } = mountSkills(request, "settings");
    publishRouteData({ report });
    await waitForFast(() => expect(page.querySelector('input[value="workspace"]')).not.toBeNull());
    page.querySelector<HTMLInputElement>('input[value="workspace"]')!.click();
    await waitForFast(() => expect(page.textContent).toContain("Unavailable"));
    page.querySelector<HTMLButtonElement>('[aria-label="Open Linked Skill details"]')!.click();
    await waitForFast(() =>
      expect(page.querySelector(".exec-approval-title")?.textContent).toBe("Linked Skill"),
    );
    const dialog = page.querySelector(".skill-reader-dialog");
    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Refresh")!
      .click();
    await waitForFast(() => expect(verdictRequests).toBe(2));
    await waitForFast(() => expect(dialog?.textContent).toContain("Refreshing"));
    page.querySelector<HTMLButtonElement>('[aria-label="Open Repo Skill details"]')!.click();
    await waitForFast(() =>
      expect(page.querySelector(".exec-approval-title")?.textContent).toBe("Repo Skill"),
    );
    expect(page.querySelector(".skill-reader-dialog")).toBe(dialog);
    pending.resolve({ items: [] });
  });

  it("keeps detail chrome usable while one admitted read is pending", async () => {
    const warnings = vi.spyOn(console, "warn");
    const pending = deferred<ClawHubSkillDetail>();
    const request = vi.fn(async (method: string) => {
      if (method === "skills.detail") {
        return pending.promise;
      }
      if (method === "skills.library.list") {
        return personalLibrary;
      }
      if (method === "skills.search") {
        return { results: [] };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const { page, publishRouteData } = mountSkills(request);
    publishRouteData({ clawhubRef: "@fixture/guide" });
    await waitForFast(() =>
      expect(page.querySelector(".clawhub-skill-detail__body")?.textContent).toContain("Loading"),
    );
    const panel = page.querySelector(".skill-reader-dialog");
    const body = page.querySelector(".clawhub-skill-detail__body");
    expect(page.querySelector(".exec-approval-title")?.textContent).toContain("@fixture/guide");
    expect(
      page.querySelector<HTMLButtonElement>('.skill-reader-dialog [aria-label="Close"]')?.disabled,
    ).toBe(false);
    expect(page.querySelector(".skill-reader-dialog__actions")).toBeNull();

    publishRouteData({ clawhubRef: "@fixture/guide", error: "Unrelated report refresh" });
    pending.resolve({
      skill: {
        slug: "guide",
        displayName: "Guide",
        summary: "Current guide",
        createdAt: 1,
        updatedAt: 2,
      },
      latestVersion: { version: "2.0.0", createdAt: 2 },
    });
    await waitForFast(() =>
      expect(page.querySelector(".clawhub-skill-detail__body")?.textContent).toContain(
        "Latest: v2.0.0",
      ),
    );
    expect(page.querySelector(".skill-reader-dialog")).toBe(panel);
    expect(page.querySelector(".clawhub-skill-detail__body")).toBe(body);
    expect(page.querySelector(".exec-approval-title")?.textContent).toBe("Guide");
    expect(page.querySelector(".skill-reader-dialog__actions")?.textContent).toContain("Import");
    expect(request.mock.calls.filter(([method]) => method === "skills.detail")).toHaveLength(1);
    expect(warnings.mock.calls.flat().join("\n")).not.toContain("STRICT_READ_UNTRACKED");
    expect(warnings.mock.calls.flat().join("\n")).not.toContain("ASYNC_OUTSIDE_LOADING_BOUNDARY");
  });

  it.each(["error", "missing"])(
    "renders an admitted %s detail outcome without an install footer",
    async (outcome) => {
      const pending = deferred<ClawHubSkillDetail | null>();
      const request = vi.fn(async (method: string) => {
        if (method === "skills.detail") {
          return pending.promise;
        }
        if (method === "skills.library.list") {
          return personalLibrary;
        }
        if (method === "skills.search") {
          return { results: [] };
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const { page, publishRouteData } = mountSkills(request);
      publishRouteData({ clawhubRef: "@fixture/guide" });
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("skills.detail", { slug: "@fixture/guide" }),
      );
      if (outcome === "error") {
        pending.reject(new Error("Synthetic detail failure"));
      } else {
        pending.resolve(null);
      }
      await waitForFast(() =>
        expect(page.querySelector(".clawhub-skill-detail__body")?.textContent).toContain(
          outcome === "error" ? "Synthetic detail failure" : "Skill not found",
        ),
      );
      expect(page.querySelector(".skill-reader-dialog__actions")).toBeNull();
      expect(page.querySelector(".exec-approval-title")?.textContent).toContain("@fixture/guide");
    },
  );

  it.each(["close", "connection", "reference"])(
    "retires pending detail after %s replacement",
    async (replacement) => {
      const oldRead = deferred<ClawHubSkillDetail>();
      const newRead = deferred<ClawHubSkillDetail>();
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "skills.detail") {
          return params && typeof params === "object" && "slug" in params && params.slug === "old"
            ? oldRead.promise
            : newRead.promise;
        }
        if (method === "skills.library.list") {
          return personalLibrary;
        }
        if (method === "skills.search") {
          return { results: [] };
        }
        if (method === "skills.status") {
          return { skills: [] };
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const { page, connection, publishRouteData } = mountSkills(request);
      publishRouteData({ clawhubRef: "old" });
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("skills.detail", { slug: "old" }),
      );
      if (replacement === "close") {
        page.querySelector<HTMLButtonElement>('.skill-reader-dialog [aria-label="Close"]')!.click();
        flush();
        expect(page.querySelector(".skill-reader-dialog")).toBeNull();
      } else if (replacement === "connection") {
        // SAFETY: The browser-client fixture only needs the request method used by this page.
        const client = { request } as unknown as GatewayBrowserClient;
        connection.publish({ ...connection.gateway.snapshot, client });
        flush();
        expect(page.querySelector(".skill-reader-dialog")).toBeNull();
      }
      publishRouteData({ clawhubRef: "new", gatewaySnapshot: connection.gateway.snapshot });
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("skills.detail", { slug: "new" }),
      );
      await waitForFast(() =>
        expect(page.querySelector(".skill-reader-dialog")?.textContent).toContain("new"),
      );
      oldRead.resolve({
        skill: { slug: "old", displayName: "Obsolete", createdAt: 1, updatedAt: 1 },
      });
      await oldRead.promise;
      flush();
      expect(page.querySelector(".skill-reader-dialog")?.textContent).not.toContain("Obsolete");
      newRead.resolve({
        skill: { slug: "new", displayName: "Current", createdAt: 1, updatedAt: 1 },
      });
      await waitForFast(() =>
        expect(page.querySelector(".exec-approval-title")?.textContent).toBe("Current"),
      );
      expect(request.mock.calls.filter(([method]) => method === "skills.detail")).toHaveLength(2);
    },
  );

  it("retains a library draft across reconnect and retires it on client replacement", async () => {
    onTestFinished(installDialogPolyfill());
    const pending = deferred<unknown>();
    const request = vi.fn(async (method: string) => {
      if (method === "skills.library.save") {
        return pending.promise;
      }
      return method === "skills.library.list"
        ? {
            ...personalLibrary,
            entries: [
              {
                skillId: "12345678-1234-1234-1234-123456789abc",
                revision: "a".repeat(64),
                slug: "retained-library-skill",
                name: "retained-library-skill",
                description: "Retained library entry",
                ownerProfileId: "alice",
                authorProfileId: "alice",
                ownerLabel: "Alice",
                shared: false,
                enabled: true,
                removed: false,
                canEdit: true,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          }
        : { skills: [] };
    });
    const { page, connection } = mountSkills(request, "settings");
    await waitForFast(() => {
      const create = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Create skill",
      );
      expect(create?.disabled).toBe(false);
    });
    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Create skill")!
      .click();
    flush();
    const content = page.querySelector<HTMLTextAreaElement>('textarea[name="library-content"]')!;
    content.value = "# Offline draft\nKeep this authored content.";
    content.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    const slug = page.querySelector<HTMLInputElement>('input[name="library-slug"]')!;
    slug.value = "offline-draft";
    slug.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    const snapshot = connection.gateway.snapshot;
    connection.publish({ ...snapshot, phase: "reconnecting", hello: null });
    flush();
    expect(page.textContent).toContain("retained-library-skill");
    expect(page.querySelector<HTMLTextAreaElement>('textarea[name="library-content"]')?.value).toBe(
      content.value,
    );
    connection.publish(snapshot);
    flush();
    expect(page.querySelector<HTMLTextAreaElement>('textarea[name="library-content"]')?.value).toBe(
      content.value,
    );
    await waitForFast(() => {
      const save = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Save skill",
      );
      expect(save?.disabled).toBe(false);
    });
    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Save skill")!
      .click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("skills.library.save", {
        expectedRevision: null,
        slug: "offline-draft",
        content: "# Offline draft\nKeep this authored content.",
        files: [],
      }),
    );
    await waitForFast(() => expect(content.readOnly).toBe(true));
    connection.publish({ ...snapshot, client: { request } as unknown as GatewayBrowserClient });
    flush();
    await waitForFast(() =>
      expect(page.querySelector('textarea[name="library-content"]')).toBeNull(),
    );
    await waitForFast(() => expect(page.textContent).toContain("retained-library-skill"));
    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Create skill")!
      .click();
    flush();
    const successor = page.querySelector<HTMLTextAreaElement>('textarea[name="library-content"]')!;
    expect(successor).not.toBeNull();
    expect(successor.readOnly).toBe(false);
    successor.value = "# Successor draft";
    successor.dispatchEvent(new Event("input", { bubbles: true }));
    pending.reject(new Error("Synthetic retired save rejection"));
    await waitForFast(() => {
      expect(page.querySelector('textarea[name="library-content"]')).toBe(successor);
      expect(successor.value).toBe("# Successor draft");
      expect(page.textContent).not.toContain("Synthetic retired save rejection");
    });
    connection.publish({
      ...connection.gateway.snapshot,
      hello: gatewayHelloForMethods([], ["operator.read"]),
    });
    flush();
    await waitForFast(() =>
      expect(page.querySelector('textarea[name="library-content"]')).toBeNull(),
    );
    connection.publish({ ...connection.gateway.snapshot, hello: gatewayHelloForMethods([], []) });
    flush();
    await waitForFast(() => expect(page.textContent).not.toContain("retained-library-skill"));
  });

  it("shows a settings heading with its four actions in one row below it", async () => {
    const { page } = mountSkills(
      async (method) => (method === "skills.library.list" ? personalLibrary : { skills: [] }),
      "settings",
    );
    await waitForFast(() =>
      expect(
        page.querySelectorAll<HTMLButtonElement>(".plugins-toolbar button").length,
      ).toBeGreaterThanOrEqual(4),
    );

    expect(page.querySelector(".content-header h1")?.textContent).toBe("Skills");
    const actions = page.querySelector(".plugins-toolbar");
    expect(
      Array.from(actions?.querySelectorAll("button") ?? [], (button) => button.textContent?.trim()),
    ).toEqual(["Search skills", "Workshop", "Create skill", "Import skill"]);
  });

  it("opens Plugins and Skill workshop from the shared tabs", async () => {
    const { page, context } = mountSkills(async (method) =>
      method === "skills.library.list" ? personalLibrary : { results: [] },
    );
    flush();
    for (const tab of ["plugins", "skill-workshop"]) {
      page
        .querySelector(`#plugins-tab-${tab}`)
        ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
      expect(context.navigate).toHaveBeenLastCalledWith(tab);
    }
  });

  it("keeps typing and local matches responsive through debounce, search failure, and retry", async () => {
    const initial = deferred<unknown>();
    const pending = deferred<unknown>();
    const search = vi
      .fn<(query?: string) => Promise<unknown>>()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ results: [remoteSkill] });
    const { page, publishRouteData } = mountSkills(async (method, params) => {
      if (method === "skills.search") {
        return search((params as { query?: string }).query);
      }
      return method === "skills.library.list" ? personalLibrary : { results: [] };
    });
    const report = {
      workspaceDir: "/workspace",
      managedSkillsDir: "/managed",
      skills: [createSkill({ name: "Calendar local", skillKey: "calendar-local" })],
    };
    publishRouteData({ report });
    await waitForFast(() => expect(page.textContent).toContain("Calendar local"));
    expect(page.querySelector(".plugin-catalog-grid")?.getAttribute("aria-busy")).toBe("true");
    const localCard = page.querySelector('[data-skill-id="local:calendar-local"]');
    const localOpen = localCard!.querySelector<HTMLButtonElement>("button")!;
    localOpen.focus();
    initial.resolve({ results: [] });
    await waitForFast(() =>
      expect(page.querySelector(".plugin-catalog-grid")?.getAttribute("aria-busy")).toBe("false"),
    );
    expect(page.querySelector('[data-skill-id="local:calendar-local"]')).toBe(localCard);
    expect(document.activeElement).toBe(localOpen);
    const input = page.querySelector<HTMLInputElement>('input[name="skills-search"]')!;
    input.focus();
    vi.useFakeTimers();
    try {
      input.value = "calendar";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
      expect(page.querySelector('input[name="skills-search"]')).toBe(input);
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe("calendar");
      expect(page.textContent).toContain("Calendar local");
      expect(page.querySelector('[data-skill-id="local:calendar-local"]')).toBe(localCard);
      expect(page.querySelector(".plugin-catalog-grid")?.getAttribute("aria-busy")).toBe("true");
      await vi.advanceTimersByTimeAsync(299);
      expect(search.mock.calls.filter(([query]) => query === "calendar")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(search.mock.calls.filter(([query]) => query === "calendar")).toHaveLength(1);
      publishRouteData({ report, error: "Unrelated report refresh" });
      expect(search.mock.calls.filter(([query]) => query === "calendar")).toHaveLength(1);
      expect(document.activeElement).toBe(input);
    } finally {
      vi.useRealTimers();
    }
    pending.reject(new Error("Registry unavailable"));
    await waitForFast(() => expect(page.textContent).toContain("Registry unavailable"));
    expect(page.textContent).toContain("Calendar local");
    expect(page.querySelector('[data-skill-id="local:calendar-local"]')).toBe(localCard);
    expect(page.querySelector(".plugin-catalog-grid")?.getAttribute("aria-busy")).toBe("false");
    const retry = Array.from(page.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Retry",
    )!;
    retry.click();
    flush();
    expect(page.textContent).not.toContain("Registry unavailable");
    expect(page.textContent).toContain("Calendar local");
    await waitForFast(() =>
      expect(search.mock.calls.filter(([query]) => query === "calendar")).toHaveLength(2),
    );
    await waitForFast(() =>
      expect(page.querySelector(".plugin-catalog-grid")?.getAttribute("aria-busy")).toBe("false"),
    );
    expect(page.querySelector('[data-skill-id="remote:@alice/calendar"]')).not.toBeNull();
    expect(page.querySelector('[data-skill-id="local:calendar-local"]')).toBe(localCard);
    expect(page.querySelector('input[name="skills-search"]')).toBe(input);
  });

  it("keeps a debounced search receipt across discovery surface replacement", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "skills.search" && (params as { query?: string }).query === "calendar") {
        return pending.promise;
      }
      return method === "skills.library.list" ? personalLibrary : { results: [] };
    });
    const { page, changeSurface } = mountSkills(request);
    await waitForFast(() =>
      expect(page.querySelector('input[name="skills-search"]')).not.toBeNull(),
    );
    vi.useFakeTimers();
    try {
      const input = page.querySelector<HTMLInputElement>('input[name="skills-search"]')!;
      input.value = "calendar";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
      changeSurface("settings");
      changeSurface("discovery");
      await vi.advanceTimersByTimeAsync(300);
      expect(
        request.mock.calls.filter(
          ([method, params]) =>
            method === "skills.search" && (params as { query?: string }).query === "calendar",
        ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
    pending.reject(new Error("Replacement search unavailable"));
    await waitForFast(() => expect(page.textContent).toContain("Replacement search unavailable"));
    expect(page.querySelector(".plugin-catalog-grid")?.getAttribute("aria-busy")).toBe("false");
  });

  it("cancels the debounced discovery search when the page unmounts", async () => {
    const request = vi.fn(async (method: string) =>
      method === "skills.library.list" ? personalLibrary : { results: [] },
    );
    const { page, unmount } = mountSkills(request);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("skills.search", expect.anything(), expect.anything()),
    );
    vi.useFakeTimers();
    try {
      const input = page.querySelector<HTMLInputElement>('input[name="skills-search"]')!;
      input.value = "calendar";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
      unmount();
      request.mockClear();

      await vi.advanceTimersByTimeAsync(300);

      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows sidebar selection and rejects old scope results before installing", async () => {
    const oldReport = deferred<unknown>();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "skills.search") {
        return { results: [remoteSkill] };
      }
      if (method === "skills.library.list") {
        return { ...personalLibrary, defaultTarget: "workspace" };
      }
      if (method === "skills.status") {
        if ((params as { agentId: string }).agentId === "research") {
          return oldReport.promise;
        }
        return { skills: [createSkill({ name: "main-only", skillKey: "main-only" })] };
      }
      if (method === "skills.install") {
        return { message: "Installed" };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const { page, context, refreshRouteData } = mountSkills(request);
    await waitForFast(() =>
      expect(page.querySelector(".plugin-catalog-card__install")).not.toBeNull(),
    );
    context.agentSelection.set("research");
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("skills.status", { agentId: "research" }),
    );
    context.agentSelection.set("main");
    await waitForFast(() => expect(page.textContent).toContain("main-only"));
    oldReport.resolve({
      skills: [createSkill({ name: "research-only", skillKey: "research-only", disabled: true })],
    });
    await oldReport.promise;
    flush();
    expect(page.textContent).not.toContain("research-only");
    expect(page.querySelector('[name="skills-agent"]')).toBeNull();
    context.agentSelection.set("research");
    await waitForFast(() => expect(page.textContent).toContain("research-only"));
    expect(
      page
        .querySelector('[data-skill-id="local:research-only"] .settings-status')
        ?.getAttribute("title"),
    ).toContain("Disabled");
    refreshRouteData();
    flush();
    expect(context.agentSelection.state.selectedId).toBe("research");
    expect(page.textContent).toContain("research-only");
    page.querySelector<HTMLButtonElement>(".plugin-catalog-card__install")!.click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("skills.install", {
        agentId: "research",
        source: "clawhub",
        slug: "@alice/calendar",
      }),
    );
    page.querySelector<HTMLButtonElement>('[aria-label="Skill settings"]')!.click();
    expect(context.navigate).toHaveBeenCalledWith("skill-settings", { search: "?agent=research" });
  });
  it("keeps Settings scope independent of discovery and rejects an older route snapshot", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "skills.library.list") {
        return { ...personalLibrary, defaultTarget: "workspace" };
      }
      if (method === "skills.status") {
        const agentId = (params as { agentId: string }).agentId;
        return { skills: [createSkill({ name: `${agentId}-only`, skillKey: `${agentId}-only` })] };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const { page, context, refreshRouteData } = mountSkills(request, "settings");
    flush();
    context.settingsAgentSelection.set("research");
    await waitForFast(() => expect(page.textContent).toContain("research-only"));
    expect(page.querySelector("openclaw-agent-select")).toBeNull();
    context.agentSelection.set("research");
    context.agentSelection.set("main");
    refreshRouteData();
    flush();
    expect(page.textContent).toContain("research-only");
    expect(context.settingsAgentSelection.state.selectedId).toBe("research");
    expect(request.mock.calls.filter(([method]) => method === "skills.status")).toEqual([
      ["skills.status", { agentId: "research" }],
    ]);
  });

  it("keeps each selection owner when a retained page changes surface", async () => {
    const warnings = vi.spyOn(console, "warn");
    const report = (agentId: string) => ({
      workspaceDir: "/workspace",
      managedSkillsDir: "/managed",
      skills: [createSkill({ name: `${agentId}-only`, skillKey: `${agentId}-only` })],
    });
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "skills.library.list") {
        return { ...personalLibrary, defaultTarget: "workspace" };
      }
      if (method === "skills.search") {
        return { results: [] };
      }
      if (method === "skills.status") {
        // SAFETY: This fixture only reads the typed skills.status request payload.
        return report((params as { agentId: string }).agentId);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const { page, context, publishRouteData, changeSurface } = mountSkills(request);
    context.agentSelection.set("research");
    await waitForFast(() => expect(page.textContent).toContain("research-only"));
    publishRouteData({
      selectedAgentId: "research",
      selectionIntentRevision: context.agentSelection.intentRevision,
      report: report("research"),
    });
    // Independent owners can have equal intent revisions while selecting different agents.
    context.settingsAgentSelection.set("main");
    changeSurface("settings");
    await waitForFast(() => expect(page.textContent).toContain("main-only"));
    expect(context.settingsAgentSelection.state.selectedId).toBe("main");
    expect(context.agentSelection.state.selectedId).toBe("research");
    request.mockClear();
    context.agentSelection.set("main");
    flush();
    expect(request).not.toHaveBeenCalled();
    expect(
      warnings.mock.calls.filter(
        ([message]) =>
          typeof message === "string" &&
          message.includes("STRICT_READ_UNTRACKED") &&
          message.includes("effect callback"),
      ),
    ).toEqual([]);
  });

  it("reloads empty-query results after a same-client reconnect and ignores the previous search", async () => {
    const staleSearch = deferred<{ results: (typeof remoteSkill)[] }>();
    const search = vi
      .fn()
      .mockReturnValueOnce(staleSearch.promise)
      .mockResolvedValue({ results: [remoteSkill] });
    const request = vi.fn(async (method: string) => {
      if (method === "skills.search") {
        return search();
      }
      if (method === "skills.library.list") {
        return personalLibrary;
      }
      if (method === "skills.status") {
        return { skills: [] };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const { page, connection, agents } = mountSkills(request);
    await waitForFast(() => expect(search).toHaveBeenCalledOnce());

    connection.publish({ ...connection.gateway.snapshot, phase: "reconnecting" });
    connection.publish({ ...connection.gateway.snapshot, phase: "connected" });

    await waitForFast(() => {
      expect(search).toHaveBeenCalledTimes(2);
      expect(page.querySelector('[data-skill-id="remote:@alice/calendar"]')).not.toBeNull();
    });
    staleSearch.resolve({
      results: [{ ...remoteSkill, installRef: "@old/calendar", displayName: "Old calendar" }],
    });
    await staleSearch.promise;
    flush();
    expect(page.querySelector('[data-skill-id="remote:@old/calendar"]')).toBeNull();
    expect(agents.ensureList).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([method]) => method === "skills.search")).toHaveLength(2);
  });

  it.each(["personal", "failure"] as const)(
    "waits for the library destination before allowing installation (%s)",
    async (outcome) => {
      const library = deferred<SkillsLibraryListResult>();
      const request = vi.fn(async (method: string) => {
        if (method === "skills.library.list") {
          return library.promise;
        }
        if (method === "skills.search") {
          return { results: [remoteSkill] };
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const { page } = mountSkills(request);
      const install = () => page.querySelector<HTMLButtonElement>(".plugin-catalog-card__install");
      await waitForFast(() => expect(install()).not.toBeNull());
      expect(install()!.disabled).toBe(true);
      install()!.click();
      expect(request.mock.calls.some(([method]) => method === "skills.install")).toBe(false);

      if (outcome === "failure") {
        library.reject(new Error("Library unavailable"));
        await waitForFast(() => expect(page.textContent).toContain("Library unavailable"));
        expect(install()!.disabled).toBe(true);
      } else {
        library.resolve(personalLibrary);
        await waitForFast(() => expect(install()!.disabled).toBe(false));
        install()!.click();
        flush();
        expect(page.querySelector('input[name="library-import-slug"]')).not.toBeNull();
        expect(request.mock.calls.some(([method]) => method === "skills.install")).toBe(false);
      }
    },
  );
});
