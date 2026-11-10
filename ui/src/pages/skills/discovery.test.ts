import { afterEach, describe, expect, it, vi } from "vitest";
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

const remoteSkill = (owner = "alice", slug = "repo", displayName = "Repo") => ({
  score: 1,
  registry: "https://clawhub.ai",
  slug,
  installRef: `@${owner}/${slug}`,
  displayName,
});

describe("unified skill discovery", () => {
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
      await waitForFast(() =>
        expect(
          mounted.container.querySelector('[data-skill-id="library:' + entry.skillId + '"]'),
        ).not.toBeNull(),
      );
      expect(
        mounted.container.querySelector('[data-skill-id="local:prefetched-status"]'),
      ).toBeNull();
    } finally {
      status.resolve(report);
      await route;
    }
    await waitForFast(() =>
      expect(
        mounted.container.querySelector('[data-skill-id="local:prefetched-status"]'),
      ).not.toBeNull(),
    );
    expect(request.mock.calls.filter(([method]) => method === "skills.status")).toHaveLength(1);
  });

  it("keeps cards visible without a loading label while loading", () => {
    const container = document.createElement("div");
    for (const loading of [true, false]) {
      renderDiscovery({ loading }, container);
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
    expect(container.querySelectorAll(".plugin-catalog-card")).toHaveLength(3);
    const cards = [...container.querySelectorAll(".plugin-catalog-card")];
    expect(cards[0]?.textContent).toContain("Alice");
    expect(cards[1]?.textContent).toContain("Bob");
    cards[1]?.querySelector<HTMLButtonElement>(".plugin-catalog-card__primary-link")!.click();
    expect(onLibraryOpen).toHaveBeenCalledWith(libraries[1]!.skillId);
  });

  it("does not mistake an invalid namesake for a ClawHub install", () => {
    const container = renderDiscovery({
      skill: {
        name: "Repo",
        clawhub: { status: "invalid", valid: false, reason: "Origin does not match" },
      },
      clawhubResults: [remoteSkill()],
    });
    expect(container.querySelectorAll(".plugin-catalog-card")).toHaveLength(2);
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
    expect(
      container.querySelectorAll(
        "input.settings-toggle__input, .skills-group, .plugin-catalog-chips",
      ),
    ).toHaveLength(0);
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
