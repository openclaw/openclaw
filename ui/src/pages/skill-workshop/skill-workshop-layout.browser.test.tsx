import { expect, it, vi } from "vitest";
import "../../styles.css";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createContext, createRuntimeConfigStub } from "./skill-workshop-page.test-support.ts";
import { SkillWorkshopPage } from "./skill-workshop-page.tsx";

function workshopRequest(content: string, files = ["SKILL.md"]) {
  return vi.fn(async (method: string, params: { agentId: string }) => {
    if (method === "skills.workshop.list") {
      return {
        agentId: params.agentId,
        mode: "auto",
        root: "/synthetic/workshop",
        skills: Array.from({ length: 16 }, (_, index) => ({
          name: `review-${index}`,
          description: "Review the source and preserve existing behavior.",
          updatedAtMs: Date.now(),
          sizeBytes: content.length,
          files,
        })),
        archived: [],
      };
    }
    if (method === "skills.workshop.changes") {
      return { changes: [] };
    }
    if (method === "skills.workshop.read") {
      return { content, files };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
}

it.each([
  { width: 390, height: 844, nativeChrome: false },
  { width: 844, height: 390, nativeChrome: true },
])(
  "opens a skill's page from a scrolled list at $width px (native chrome: $nativeChrome)",
  async ({ width, height, nativeChrome }) => {
    const { page } = await import("vitest/browser");
    await page.viewport(width, height);
    vi.stubGlobal("__OPENCLAW_NATIVE_WEB_CHROME__", nativeChrome);
    const scrollingPage = () => (
      <div style={{ height: "100vh", overflow: "auto" }}>
        <SkillWorkshopPage />
      </div>
    );
    const mounted = mountSolid(scrollingPage, {
      wrapper: createSolidApplicationContextProvider(
        createContext(workshopRequest("# Review procedure"), {
          runtimeConfig: createRuntimeConfigStub({ sourceConfig: {} }),
        }),
      ).wrapper,
    });
    try {
      const row = await waitForSolid(() => mounted.getByRole("button", { name: /^review-12/ }));
      row.scrollIntoView();
      row.click();
      const find = (selector: string) => mounted.container.querySelector<HTMLElement>(selector)!;
      await waitForSolid(() => {
        expect(find(".sw-detail h1").textContent).toBe("review-12");
        const top = find(".sw-detail h1").getBoundingClientRect();
        expect(top.top).toBeGreaterThanOrEqual(0);
        expect(top.bottom).toBeLessThan(window.innerHeight);
        expect(find(".sw-markdown")).not.toBeNull();
      });
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      mounted.getByRole("link", { name: "Skill workshop" }).click();
      await waitForSolid(() =>
        expect(mounted.container.querySelectorAll(".sw-row")).toHaveLength(16),
      );
    } finally {
      mounted.unmount();
      vi.unstubAllGlobals();
    }
  },
);

it("keeps the facts beside the reading column on a wide page and under it on a phone", async () => {
  const { page } = await import("vitest/browser");
  await page.viewport(1440, 900);
  const content =
    "# Review procedure\n\n" + "Read the source and report actionable findings.\n\n".repeat(40);
  const context = createContext(workshopRequest(content, ["SKILL.md", "references/checklist.txt"]));
  const mounted = mountSolid(() => <SkillWorkshopPage />, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  try {
    const find = (selector: string) => mounted.container.querySelector<HTMLElement>(selector)!;
    (await waitForSolid(() => mounted.getByRole("button", { name: /^review-0/ }))).click();
    await waitForSolid(() => expect(find(".sw-markdown")).not.toBeNull());
    const main = find(".plugin-catalog-detail__main").getBoundingClientRect();
    const facts = find(".sw-facts").getBoundingClientRect();
    expect(facts.left).toBeGreaterThan(main.right);
    expect(facts.top).toBeLessThan(main.bottom);

    mounted.getByRole("button", { name: /^Files/ }).click();
    await waitForSolid(() => expect(find(".sw-file")).not.toBeNull());
    mounted.getByRole("button", { name: /^Instructions$/ }).click();
    await waitForSolid(() => expect(find(".sw-markdown")).not.toBeNull());

    await page.viewport(390, 844);
    await waitForSolid(() => {
      const column = find(".plugin-catalog-detail__main").getBoundingClientRect();
      const stacked = find(".sw-facts").getBoundingClientRect();
      expect(stacked.top).toBeGreaterThanOrEqual(column.bottom);
      expect(stacked.right).toBeLessThanOrEqual(window.innerWidth);
    });
  } finally {
    mounted.unmount();
  }
});

it("keeps long draft file choices compact and opens the exact selected file", async () => {
  const { page } = await import("vitest/browser");
  await page.viewport(390, 844);
  const file =
    "templates/account_receivables/regional_invoice_escalation_weekly_followup_reminder_for_accounts_overdue.md";
  const draft = {
    id: "reminders-1a2b3c4d",
    skillName: "reminders",
    summary: "Review the reminder.",
    createdAtMs: 1,
  };
  const request = vi.fn(async (method: string, params: { agentId: string; filePath?: string }) => {
    if (method === "skills.workshop.list") {
      return {
        agentId: params.agentId,
        root: "/synthetic/workshop",
        mode: "propose",
        skills: [],
        archived: [],
        drafts: [draft],
      };
    }
    if (method === "skills.workshop.changes") {
      return { changes: [] };
    }
    if (method === "skills.workshop.read") {
      return {
        content: params.filePath === file ? "Please review the invoice." : "Use the reminder.",
        files: ["SKILL.md", file],
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const mounted = mountSolid(() => <SkillWorkshopPage />, {
    wrapper: createSolidApplicationContextProvider(
      createContext(request, { search: "?draft=" + draft.id }),
    ).wrapper,
  });
  try {
    (await waitForSolid(() => mounted.getByRole("button", { name: file }))).click();
    await waitForSolid(() =>
      expect(
        mounted.getByText("Please review the invoice.").getBoundingClientRect().height,
      ).toBeGreaterThan(0),
    );
    const choice = mounted.getByRole("button", { name: file });
    expect(choice.getAttribute("aria-current")).toBe("true");
    const column = choice.closest(".sw-file-chips")!.getBoundingClientRect();
    const box = choice.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);
    expect(column.right).toBeLessThanOrEqual(window.innerWidth);
    expect(box.right).toBeLessThanOrEqual(column.right + 1);
    const instructions = mounted.getByRole("button", { name: "SKILL.md" });
    expect(box.height).toBe(instructions.getBoundingClientRect().height);
    expect(choice.getAttribute("title")).toBe(file);
    expect(choice.scrollWidth).toBeGreaterThan(choice.clientWidth);
    expect(getComputedStyle(choice).textOverflow).toBe("ellipsis");
    expect(getComputedStyle(choice).direction).toBe("rtl");
    instructions.click();
    await waitForSolid(() => expect(mounted.getByText("Use the reminder.")).toBeTruthy());
    expect(mounted.getByRole("button", { name: "SKILL.md" }).getAttribute("aria-current")).toBe(
      "true",
    );
  } finally {
    mounted.unmount();
  }
});
