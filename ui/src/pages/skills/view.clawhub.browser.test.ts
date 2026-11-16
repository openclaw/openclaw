import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../styles.css";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { cleanupSkillsViews, renderSkills } from "./view.solid.test-support.tsx";
import { createProps, createReport, createSkill } from "./view.test-support.ts";

const container = document.createElement("openclaw-skills-page");

afterEach(() => {
  cleanupSkillsViews();
  container.remove();
  container.className = "";
  container.removeAttribute("style");
});

const nextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

it("appends grouped inventory without moving focus and completes later filters", async () => {
  document.body.append(container);
  const skills = Array.from({ length: 1_000 }, (_, index) =>
    createSkill({
      name: `Inventory skill ${String(index).padStart(4, "0")}`,
      skillKey: `inventory-${index}`,
      source: index % 2 === 0 ? "openclaw-workspace" : "openclaw-managed",
    }),
  );
  const [query, setQuery] = createSignal("");
  const props = createProps({ report: createReport(skills), onFilterChange: setQuery });
  renderSkills(
    {
      ...props,
      state: {
        ...props.state,
        get skillsFilter() {
          return query();
        },
      },
    },
    container,
  );
  const rows = () => [
    ...container.querySelectorAll<HTMLButtonElement>(".plugins-item__detail-button"),
  ];
  expect(rows().length).toBeGreaterThan(0);
  expect(rows().length).toBeLessThan(skills.length);
  expect(container.querySelectorAll(".skills-group")).toHaveLength(1);
  expect(container.querySelector(".skills-group .settings-count")?.textContent).toBe("500");
  expect(container.querySelector(".skills-group")?.getAttribute("aria-busy")).toBe("true");
  const first = rows()[0]!;
  first.focus();
  await waitForSolid(() => {
    expect(rows()).toHaveLength(1_000);
    expect(container.querySelectorAll('.skills-group[aria-busy="true"]')).toHaveLength(0);
  });
  expect(rows()[0]).toBe(first);
  expect(document.activeElement).toBe(first);
  expect(rows()[499]?.getAttribute("aria-label")).toBe("Open Inventory skill 0998 details");
  expect(rows()[500]?.getAttribute("aria-label")).toBe("Open Inventory skill 0001 details");
  const search = container.querySelector<HTMLInputElement>('input[name="skills-filter"]')!;
  await userEvent.fill(search, "Inventory skill 09");
  await waitForSolid(() => {
    expect(rows()).toHaveLength(100);
    expect(container.querySelectorAll('.skills-group[aria-busy="true"]')).toHaveLength(0);
  });
  expect(
    rows().every((row) => row.getAttribute("aria-label")?.includes("Inventory skill 09")),
  ).toBe(true);
  expect(document.activeElement).toBe(search);
});

it("windows skill discovery while preserving keyboard traversal, notices, details, and filtering", async () => {
  await page.viewport(1440, 900);
  container.className = "content";
  Object.assign(container.style, {
    display: "block",
    height: "500px",
    width: "1100px",
    overflow: "auto",
  });
  document.body.append(container);
  const skills = Array.from({ length: 1_000 }, (_, index) =>
    createSkill({
      name: `Window skill ${String(index).padStart(4, "0")}`,
      skillKey: `window-skill-${index}`,
      description: "A local skill for browsing a large installed inventory.",
    }),
  );
  const [query, setQuery] = createSignal("");
  const [notice, setNotice] = createSignal<{ ref: string; kind: "error"; text: string } | null>(
    null,
  );
  const onDetailOpen = vi.fn();
  const props = createProps({
    surface: "discovery",
    report: createReport(skills),
    clawhubResults: [],
    onDetailOpen,
    onClawHubQueryChange: setQuery,
  });
  renderSkills(
    {
      ...props,
      state: {
        ...props.state,
        get clawhubSearchQuery() {
          return query();
        },
        get clawhubInstallMessage() {
          return notice();
        },
      },
    },
    container,
  );
  const cards = () => [...container.querySelectorAll<HTMLElement>("[data-skill-id]")];
  const card = (index: number) =>
    container.querySelector<HTMLElement>(`[data-skill-id="local:window-skill-${index}"]`)!;
  await waitForSolid(() => {
    expect(cards().length).toBeGreaterThan(4);
    expect(cards().length).toBeLessThan(100);
    expect(card(0).parentElement?.getAttribute("aria-setsize")).toBe("1000");
    expect(container.scrollHeight).toBeGreaterThan(10_000);
  });
  await nextFrame();
  const boundary = Math.max(
    ...cards()
      .map((entry) => Number(entry.dataset.skillId!.replace("local:window-skill-", "")))
      .filter((index) => index < 100),
  );
  const focused = card(boundary).querySelector<HTMLElement>(".plugin-catalog-card__status")!;
  focused.focus();
  await waitForSolid(() => expect(card(boundary + 1)).not.toBeNull());
  // macOS WebKit visits buttons with Option-Tab under its default keyboard policy.
  const optionTab =
    navigator.platform.includes("Mac") &&
    navigator.userAgent.includes("AppleWebKit") &&
    !navigator.userAgent.includes("Chrome");
  await userEvent.keyboard(optionTab ? "{Alt>}{Tab}{/Alt}" : "{Tab}");
  expect(document.activeElement).toBe(
    card(boundary + 1).querySelector(".skill-discovery-card__open"),
  );
  await userEvent.keyboard(
    optionTab ? "{Alt>}{Shift>}{Tab}{/Shift}{/Alt}" : "{Shift>}{Tab}{/Shift}",
  );
  expect(document.activeElement).toBe(focused);

  const expectEndVisible = async () => {
    await nextFrame();
    container.scrollTop = container.scrollHeight;
    await waitForSolid(() => {
      const viewport = container.getBoundingClientRect();
      for (const index of [992, 999]) {
        expect(card(index)).not.toBeNull();
        const bounds = card(index).getBoundingClientRect();
        expect(bounds.top).toBeLessThan(viewport.bottom);
        expect(bounds.bottom).toBeGreaterThan(viewport.top);
      }
    });
  };
  await expectEndVisible();
  setNotice({
    ref: "other",
    kind: "error",
    text: "The registry could not refresh this catalog. ".repeat(100),
  });
  await expectEndVisible();
  setNotice(null);
  await expectEndVisible();
  await page.getByRole("button", { name: "Open Window skill 0999 details", exact: true }).click();
  expect(onDetailOpen).toHaveBeenLastCalledWith("window-skill-999");

  const search = container.querySelector<HTMLInputElement>('input[name="skills-search"]')!;
  await userEvent.fill(search, "Window skill 0999");
  await waitForSolid(() => {
    expect(cards()).toHaveLength(1);
    expect(card(999)).not.toBeNull();
    expect(card(999).parentElement?.getAttribute("aria-setsize")).toBe("1");
    expect(card(999).parentElement?.style.position).toBe("");
    expect(document.activeElement).toBe(search);
  });
});

describe("ClawHub detail content", () => {
  it.each([390, 1440])("contains rendered Markdown details at %ipx", async (width) => {
    await page.viewport(width, 960);
    document.body.append(container);
    const code = "long_identifier_".repeat(80);
    const tableIdentifier = "table_identifier_".repeat(80);
    const changelog = `# Release notes\n\nFirst paragraph starts here.\n\n\`\`\`text\n${code}\n\`\`\`\n\n| Change | Status |\n| --- | --- |\n| ${tableIdentifier} | Ready |\n\n<img src="javascript:alert(1)" onerror="alert(1)">`;
    renderSkills(
      createProps({
        clawhubDetailRef: "@fixture/guide",
        clawhubDetail: {
          skill: {
            slug: "guide",
            displayName: "Guide",
            summary: `Review and verification instructions. ${"long_summary_".repeat(80)}`,
            createdAt: 1,
            updatedAt: 2,
          },
          owner: { displayName: "Fixture operator" },
          latestVersion: { version: "1.0.0", createdAt: 2, changelog },
        },
      }),
      container,
    );
    await expect
      .element(page.getByRole("button", { name: "Install Guide", exact: true }))
      .toBeVisible();
    const body = container.querySelector<HTMLElement>(".skill-reader-dialog__body")!;
    const footer = container.querySelector<HTMLElement>(
      "openclaw-modal-actions.skill-reader-dialog__actions",
    )!;
    expect(footer.parentElement?.lastElementChild).toBe(footer);
    expect(body.contains(footer)).toBe(false);
    await Promise.all(
      footer
        .closest("dialog")!
        .getAnimations()
        .map((animation) => animation.finished),
    );
    const footerTop = footer.getBoundingClientRect().top;
    body.scrollTop = body.scrollHeight;
    await nextFrame();
    expect(footer.getBoundingClientRect().top).toBe(footerTop);
    expect(body.clientWidth).toBeGreaterThan(0);
    expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth);
    for (const child of body.children) {
      expect(child.scrollWidth).toBeLessThanOrEqual(child.clientWidth);
    }
    expect(body.querySelector("h1")?.textContent).toBe("Release notes");
    expect(body.querySelector("article > p")?.textContent).toBe("First paragraph starts here.");
    expect(body.querySelector("pre code")?.textContent).toBe(`${code}\n`);
    const table = body.querySelector("table")!;
    expect(table.scrollWidth).toBeGreaterThan(table.clientWidth);
    table.scrollLeft = 100;
    expect(table.scrollLeft).toBeGreaterThan(0);
    expect(body.querySelector("[onerror], [src^='javascript:']")).toBeNull();
  });
});
