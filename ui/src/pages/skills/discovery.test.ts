import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { buildSkillLibraryMock } from "../../test-helpers/skill-library-fixtures.ts";
import { createProps, createSkill } from "./view.test-support.ts";
import { renderSkills } from "./view.ts";

describe("unified skill discovery", () => {
  it.each(["loading", "clawhubSearchLoading"] as const)(
    "keeps cards visible without a loading label while %s",
    (loadingKey) => {
      const container = document.createElement("div");
      for (const loading of [true, false]) {
        render(
          renderSkills(createProps({ surface: "discovery", [loadingKey]: loading })),
          container,
        );
        expect(container.querySelectorAll(".plugin-catalog-card")).toHaveLength(1);
        expect(container.querySelector(".plugin-catalog-grid")?.getAttribute("aria-busy")).toBe(
          String(loading),
        );
        expect(container.textContent).not.toContain("Loading…");
      }
    },
  );
  it("shows separate personal/team copies and merges only their persisted runtime command identity", () => {
    const container = document.createElement("div");
    const libraries = buildSkillLibraryMock().map((item) => item.entry);
    const onLibraryOpen = vi.fn();
    render(
      renderSkills(
        createProps({
          surface: "discovery",
          libraryEntries: libraries,
          onLibraryOpen,
          report: {
            workspaceDir: "/tmp",
            managedSkillsDir: "/tmp",
            skills: [
              createSkill({
                name: libraries[0]!.name,
                source: "openclaw-library",
              }),
            ],
          },
        }),
      ),
      container,
    );
    expect(container.querySelectorAll(".plugin-catalog-card")).toHaveLength(3);
    const cards = [...container.querySelectorAll(".plugin-catalog-card")];
    expect(cards[0]?.textContent).toContain("Alice");
    expect(cards[1]?.textContent).toContain("Bob");
    cards[1]?.querySelector<HTMLButtonElement>(".plugin-catalog-card__primary-link")!.click();
    expect(onLibraryOpen).toHaveBeenCalledWith(libraries[1]!.skillId);
  });

  it.each(["unlinked", "invalid", "other-registry"])(
    "does not mistake a %s namesake for a ClawHub install",
    (variant) => {
      const container = document.createElement("div");
      const skill = createSkill({
        name: "Repo",
        clawhub:
          variant === "unlinked"
            ? undefined
            : variant === "invalid"
              ? {
                  status: "invalid",
                  valid: false,
                  reason: "Origin does not match",
                }
              : {
                  status: "linked",
                  valid: true,
                  registry: "https://private.example",
                  slug: "repo",
                  ownerHandle: "alice",
                  installedVersion: "1",
                  installedAt: 1,
                  originPath: "/tmp/o",
                  lockPath: "/tmp/l",
                },
      });
      render(
        renderSkills(
          createProps({
            surface: "discovery",
            report: { workspaceDir: "/tmp", managedSkillsDir: "/tmp", skills: [skill] },
            clawhubResults: [
              {
                score: 1,
                registry: "https://clawhub.ai",
                slug: "repo",
                installRef: "@alice/repo",
                displayName: "Repo",
              },
            ],
          }),
        ),
        container,
      );
      expect(container.querySelectorAll(".plugin-catalog-card")).toHaveLength(2);
      expect(container.querySelectorAll(".plugin-catalog-card__install")).toHaveLength(1);
    },
  );
  it("combines installed and remote skills in one search with exclusive status/install actions", () => {
    const container = document.createElement("div");
    const onClawHubQueryChange = vi.fn();
    const onClawHubInstall = vi.fn();
    const onDetailOpen = vi.fn();
    render(
      renderSkills(
        createProps({
          surface: "discovery",
          clawhubQuery: "repo",
          clawhubResults: [
            {
              score: 1,
              slug: "repo-helper",
              registry: "https://clawhub.ai",
              installRef: "@alice/repo-helper",
              displayName: "Repo Helper",
            },
          ],
          onClawHubQueryChange,
          onClawHubInstall,
          onDetailOpen,
        }),
      ),
      container,
    );
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="search"]');
    expect(inputs).toHaveLength(1);
    expect(container.querySelectorAll(".plugin-catalog-card")).toHaveLength(2);
    expect(
      container.querySelectorAll("wa-switch, .skills-group, .plugin-catalog-chips"),
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
    const container = document.createElement("div");
    const local = createSkill({
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
    });
    render(
      renderSkills(
        createProps({
          surface: "discovery",
          clawhubQuery: "repo",
          report: { workspaceDir: "/tmp", managedSkillsDir: "/tmp", skills: [local] },
          clawhubResults: ["alice", "bob"].map((owner) => ({
            score: 1,
            registry: "https://clawhub.ai",
            slug: "repo",
            installRef: `@${owner}/repo`,
            displayName: "Repo",
          })),
        }),
      ),
      container,
    );
    expect(container.querySelectorAll(".plugin-catalog-card")).toHaveLength(2);
    expect(container.querySelector('[data-skill-id="local:repo-skill"]')).not.toBeNull();
    expect(container.querySelector('[data-skill-id="remote:@alice/repo"]')).toBeNull();
    expect(container.querySelector('[data-skill-id="remote:@bob/repo"]')).not.toBeNull();
  });

  it("keeps local results usable during remote failure and explains missing setup in the dot", () => {
    const container = document.createElement("div");
    const skill = createSkill({
      eligible: false,
      missing: { bins: ["repo-cli"], anyBins: [], env: [], config: [], os: [] },
    });
    render(
      renderSkills(
        createProps({
          surface: "discovery",
          clawhubQuery: "repo",
          clawhubSearchError: "Registry unavailable",
          report: { workspaceDir: "/tmp", managedSkillsDir: "/tmp", skills: [skill] },
        }),
      ),
      container,
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Registry unavailable",
    );
    expect(container.querySelectorAll(".plugin-catalog-card")).toHaveLength(1);
    expect(container.querySelector('[role="img"]')?.getAttribute("title")).toContain("repo-cli");
  });
});
