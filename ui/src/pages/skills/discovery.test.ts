import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createRouteLoaderOptions } from "../../test-helpers/route-loader-options.ts";
import { buildSkillLibraryMock } from "../../test-helpers/skill-library-fixtures.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { pages } from "./route.ts";
import { mountSkills, personalLibrary } from "./skills-page.test-support.tsx";
import { libraryEntry } from "./skills.test-support.ts";
import { cleanupSkillsViews, renderSkills } from "./view.solid.test-support.tsx";
import { createProps, createReport, createSkill } from "./view.test-support.ts";
afterEach(cleanupSkillsViews);

function renderDiscovery(
  {
    skill,
    ...props
  }: Parameters<typeof createProps>[0] & {
    skill?: Parameters<typeof createSkill>[0];
  },
  container = document.createElement("div"),
) {
  renderSkills(
    createProps({ surface: "discovery", report: createReport([createSkill(skill)]), ...props }),
    container,
  );
  return container;
}

/** Installed skills sit in one summary line until the Installed chip lists them. */
function showInstalled(container: HTMLElement) {
  [...container.querySelectorAll<HTMLButtonElement>(".plugin-catalog-chip")]
    .find((chip) => chip.textContent === "Installed")!
    .click();
  flush();
}

const shelfText = (container: HTMLElement) =>
  container.querySelector(".skill-installed-shelf")?.textContent ?? "";

const remoteSkill = (owner = "alice", slug = "repo", displayName = "Repo") => ({
  score: 1,
  registry: "https://clawhub.ai",
  slug,
  installRef: `@${owner}/${slug}`,
  displayName,
});

describe("unified skill discovery", () => {
  it.each(["", "calendar"])(
    "waits for an accepted library before claiming empty discovery (query=%s)",
    (clawhubQuery) => {
      const props = { report: createReport([]), clawhubQuery, clawhubResults: [] };
      const container = renderDiscovery({ ...props, libraryEntries: undefined });
      expect(container.querySelector(".settings-empty")).toBeNull();
      expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.disabled).toBe(
        false,
      );

      renderDiscovery(
        { ...props, libraryEntries: undefined, clawhubResults: [remoteSkill()] },
        container,
      );
      expect(container.querySelector('[data-skill-id="remote:@alice/repo"]')).not.toBeNull();

      // An accepted empty library remains known during later refreshes or failures.
      renderDiscovery({ ...props, libraryEntries: [] }, container);
      expect(container.querySelector(".settings-empty")?.textContent).toBe(
        clawhubQuery ? "No skills match your search." : "No skills yet. Search ClawHub to add one.",
      );
    },
  );

  it.each(["", "calendar"])(
    "does not infer empty discovery from a failed first report (query=%s)",
    (clawhubQuery) => {
      const error = "Installed skill inventory unavailable";
      const container = renderDiscovery({ report: null, error, clawhubQuery, clawhubResults: [] });
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(error);
      expect(container.querySelector(".settings-empty")).toBeNull();
      expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.disabled).toBe(
        false,
      );

      renderDiscovery(
        { report: null, error, clawhubQuery, clawhubResults: [remoteSkill()] },
        container,
      );
      expect(container.querySelector('[data-skill-id="remote:@alice/repo"]')).not.toBeNull();
      expect(container.querySelector(".settings-empty")).toBeNull();

      // An accepted empty report remains known even if its later refresh fails.
      renderDiscovery(
        { report: createReport([]), error, clawhubQuery, clawhubResults: [] },
        container,
      );
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(error);
      expect(container.querySelector(".settings-empty")?.textContent).toBe(
        clawhubQuery ? "No skills match your search." : "No skills yet. Search ClawHub to add one.",
      );
    },
  );

  it("shows first content before installed status and adopts the route result once", async () => {
    const entry = libraryEntry();
    const report = createReport([
      createSkill({ skillKey: "prefetched-status", name: "Prefetched status" }),
    ]);
    const status = Promise.withResolvers<typeof report>();
    const request = vi.fn(async (method: string) => {
      if (method === "skills.status") {
        return status.promise;
      }
      if (method === "skills.library.list") {
        return { ...personalLibrary, entries: [entry] };
      }
      if (method === "skills.search") {
        return { results: [] };
      }
      throw new Error("Unexpected method: " + method);
    });
    const mounted = mountSkills(request, "discovery", { pendingRoute: true });
    const loader = pages[0].loader!;
    const route = Promise.resolve(
      loader(
        mounted.context,
        createRouteLoaderOptions({ pathname: "/skills", search: "", hash: "" }),
      ),
    ).then((result) => {
      if ("type" in result) {
        throw new Error("Expected Skills route data, received " + result.type);
      }
      mounted.publishRouteData(result);
    });
    try {
      await waitForFast(() => expect(shelfText(mounted.container)).toContain(entry.slug));
      expect(shelfText(mounted.container)).not.toContain("Prefetched status");
    } finally {
      status.resolve(report);
      await route;
    }
    await waitForFast(() => expect(shelfText(mounted.container)).toContain("Prefetched status"));
    showInstalled(mounted.container);
    expect(
      mounted.container.querySelector('[data-skill-id="library:' + entry.skillId + '"]'),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector('[data-skill-id="local:prefetched-status"]'),
    ).not.toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "skills.status")).toHaveLength(1);
  });

  it("keeps the feed usable without category support, and retries a failed taxonomy independently", async () => {
    const research = { slug: "research", label: "Research" };
    const categories = vi
      .fn()
      .mockRejectedValueOnce(new Error("Directory unavailable"))
      .mockResolvedValue({ categories: [research] });
    const feed = vi.fn(() => ({ results: [{ ...remoteSkill(), categories: [research.slug] }] }));
    const sources: Record<string, () => unknown> = {
      "skills.categories": categories,
      "skills.search": feed,
      "skills.library.list": () => personalLibrary,
    };
    const { container, context, connection } = mountSkills(
      async (method) => sources[method]?.() ?? {},
    );
    const section = () =>
      container
        .querySelector('[data-skill-id="remote:@alice/repo"]')
        ?.closest<HTMLElement>("[data-catalog-section]")?.dataset.catalogSection;
    await waitForFast(() => expect(section()).toBe("clawhub"));
    expect(categories).not.toHaveBeenCalled();
    connection.publish({
      ...context.gateway.snapshot,
      hello: gatewayHelloForMethods(["skills.categories"]),
    });
    const alert = () => container.querySelector('[role="alert"]');
    await waitForFast(() => expect(alert()?.textContent).toContain("Directory unavailable"));
    expect(section()).toBe("clawhub");
    const reads = feed.mock.calls.length;
    alert()!.querySelector("button")!.click();
    await waitForFast(() => expect(section()).toBe("category-research"));
    expect(feed).toHaveBeenCalledTimes(reads);
  });

  it("keeps cards visible without a loading label while loading", () => {
    const container = document.createElement("div");
    for (const loading of [true, false]) {
      renderDiscovery({ loading, clawhubQuery: "repo" }, container);
      expect(container.querySelectorAll(".plugin-catalog-card")).toHaveLength(1);
      expect(container.querySelector(".plugin-catalog-grid")?.getAttribute("aria-busy")).toBe(
        String(loading),
      );
      expect(container.textContent).not.toContain("Loading…");
    }
  });
  it("shows separate personal/team copies and merges only their persisted runtime command identity", () => {
    const libraries = buildSkillLibraryMock().map((item) => item.entry);
    const onLibraryOpen = vi.fn();
    const container = renderDiscovery({
      libraryEntries: libraries,
      onLibraryOpen,
      skill: { name: libraries[0]!.name, source: "openclaw-library" },
    });
    showInstalled(container);
    expect(container.querySelectorAll(".plugin-catalog-card")).toHaveLength(3);
    const cards = [...container.querySelectorAll(".plugin-catalog-card")];
    expect(cards[0]?.textContent).toContain("Alice");
    expect(cards[1]?.textContent).toContain("Bob");
    cards[1]?.querySelector<HTMLButtonElement>(".plugin-catalog-card__primary-link")!.click();
    expect(onLibraryOpen).toHaveBeenCalledWith(libraries[1]!.skillId);
  });

  it("reports an empty category independently of installed matches or pending inventory", () => {
    const container = renderDiscovery({
      clawhubCategory: { slug: "research", label: "Research" },
      clawhubQuery: "repo",
      clawhubResults: [],
      libraryEntries: undefined,
      loading: true,
    });
    expect(container.querySelector(".plugin-catalog-card")).toBeNull();
    expect(container.querySelector(".settings-empty")?.textContent).toBe(
      "No skills match your filters.",
    );
  });

  it("previews only advertised memberships in taxonomy order, with a flat remainder", () => {
    const alpha = { slug: "lab-a", label: "Field work" };
    const beta = { slug: "lab-b", label: "On call" };
    const tagged = Array.from({ length: 6 }, (_, index) => ({
      ...remoteSkill("alice", "row-" + index, "Row " + index),
      categories: index ? [alpha.slug] : [alpha.slug, beta.slug, beta.slug],
    }));
    const uncategorized = [
      remoteSkill("alice", "old"),
      { ...remoteSkill("alice", "unknown"), categories: ["unadvertised"] },
    ];
    const onCategoryChange = vi.fn();
    const props = { clawhubResults: [...tagged, ...uncategorized], onCategoryChange };
    const container = renderDiscovery({ ...props, readCategories: () => null });
    expect(shelfText(container)).not.toBe("");
    expect(container.querySelector("[data-skill-id]")).toBeNull();
    const categories = [beta, alpha, { slug: "empty", label: "Empty" }];
    renderDiscovery({ ...props, readCategories: () => ({ categories }) }, container);
    const sections = [...container.querySelectorAll("[data-catalog-section]")];
    expect(sections.map((section) => section.querySelector("h2")?.textContent)).toEqual([
      "On call",
      "Field work",
      "ClawHub",
    ]);
    const ids = (section: Element) =>
      [...section.querySelectorAll("[data-skill-id]")].map((el) =>
        el.getAttribute("data-skill-id"),
      );
    expect(ids(sections[0]!)).toEqual(["remote:@alice/row-0"]);
    expect(ids(sections[1]!)).toEqual(tagged.slice(0, 4).map((row) => "remote:" + row.installRef));
    expect(ids(sections[2]!)).toEqual(uncategorized.map((row) => "remote:" + row.installRef));
    const chip = [...container.querySelectorAll<HTMLButtonElement>(".plugin-catalog-chip")].find(
      (button) => button.textContent === alpha.label,
    )!;
    const focus = vi.spyOn(chip, "focus");
    sections[1]!.querySelector<HTMLButtonElement>(".plugin-catalog-section__view-all")!.click();
    expect(focus).toHaveBeenCalledOnce();
    expect(onCategoryChange).toHaveBeenCalledExactlyOnceWith(alpha);
    expect(sections[2]!.querySelector(".plugin-catalog-section__view-all")).toBeNull();
  });

  it("does not mistake an invalid namesake for a ClawHub install", () => {
    const container = renderDiscovery({
      skill: {
        name: "Repo",
        clawhub: { status: "invalid", valid: false, reason: "Origin does not match" },
      },
      clawhubResults: [remoteSkill()],
    });
    // The local namesake stays an installed skill; the registry row keeps its own Add action.
    expect(shelfText(container)).toContain("Repo");
    expect(container.querySelectorAll(".plugin-catalog-card")).toHaveLength(1);
    expect(container.querySelectorAll(".plugin-catalog-card__install")).toHaveLength(1);
  });
  it("combines installed and remote skills in one search with exclusive status/install actions", () => {
    const onClawHubQueryChange = vi.fn();
    const onClawHubInstall = vi.fn();
    const onDetailOpen = vi.fn();
    const container = renderDiscovery({
      clawhubQuery: "repo",
      clawhubResults: [remoteSkill("alice", "repo-helper", "Repo Helper")],
      onClawHubQueryChange,
      onClawHubInstall,
      onDetailOpen,
    });
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="search"]');
    expect(inputs).toHaveLength(1);
    expect(container.querySelectorAll(".plugin-catalog-card")).toHaveLength(2);
    expect(container.querySelectorAll("input.settings-toggle__input, .skills-group")).toHaveLength(
      0,
    );
    const local = container.querySelector('[data-skill-id="local:repo-skill"]')!;
    expect(local.querySelector('[role="img"]')?.getAttribute("title")).toContain("Ready");
    expect(local.querySelector(".plugin-catalog-card__install")).toBeNull();
    local.querySelector<HTMLButtonElement>(".plugin-catalog-card__primary-link")!.click();
    expect(onDetailOpen).toHaveBeenCalledWith("repo-skill");
    const remote = container.querySelector('[data-skill-id="remote:@alice/repo-helper"]')!;
    remote.querySelector<HTMLButtonElement>(".plugin-catalog-card__install")!.click();
    expect(onClawHubInstall).toHaveBeenCalledWith("@alice/repo-helper");
    inputs[0]!.value = "calendar";
    inputs[0]!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onClawHubQueryChange).toHaveBeenCalledWith("calendar");
  });

  it("deduplicates verified registry identity without hiding namesakes or another publisher", () => {
    const container = renderDiscovery({
      clawhubQuery: "repo",
      skill: {
        name: "Local name",
        clawhub: {
          status: "linked",
          valid: true,
          registry: "https://clawhub.ai",
          slug: "repo",
          ownerHandle: "alice",
          installedVersion: "1.0.0",
          installedAt: 1,
          originPath: "/tmp/origin",
          lockPath: "/tmp/lock",
        },
      },
      clawhubResults: ["alice", "bob"].map((owner) => remoteSkill(owner)),
    });
    expect(container.querySelectorAll(".plugin-catalog-card")).toHaveLength(2);
    expect(container.querySelector('[data-skill-id="local:repo-skill"]')).not.toBeNull();
    expect(container.querySelector('[data-skill-id="remote:@alice/repo"]')).toBeNull();
    expect(container.querySelector('[data-skill-id="remote:@bob/repo"]')).not.toBeNull();
  });

  it("keeps local results usable during remote failure and explains missing setup in the dot", () => {
    const container = renderDiscovery({
      clawhubQuery: "repo",
      clawhubSearchError: "Registry unavailable",
      skill: {
        eligible: false,
        missing: { bins: ["repo-cli"], anyBins: [], env: [], config: [], os: [] },
      },
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Registry unavailable",
    );
    expect(container.querySelectorAll(".plugin-catalog-card")).toHaveLength(1);
    expect(container.querySelector('[role="img"]')?.getAttribute("title")).toContain("repo-cli");
  });
});
