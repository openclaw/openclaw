import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createContext } from "./skill-workshop-page.test-support.ts";
import { SkillWorkshopPage } from "./skill-workshop-page.tsx";

it.each([
  { first: "md", next: "txt" },
  { first: "txt", next: "md" },
])(
  "renders the selected .$next file after a pending read from .$first",
  async ({ first, next }) => {
    const initial = `first.${first}`;
    const sibling = `sibling.${first}`;
    const target = `last.${next}`;
    const contents = new Map([
      ["SKILL.md", "# Orchard"],
      [initial, "# Pear"],
      [sibling, "# Plum"],
      [target, "# Fig\n\nRipe fruit."],
    ]);
    const files = [...contents.keys()];
    const held = createDeferredCore();
    const request = vi.fn(async (method: string, params: { filePath?: string }) => {
      if (method === "skills.workshop.list") {
        return {
          agentId: "research",
          mode: "auto",
          skills: [{ name: "orchard", description: "Tend fruit trees", files }],
          archived: [],
        };
      }
      if (method === "skills.workshop.changes") {
        return { changes: [] };
      }
      if (method === "skills.workshop.read" && params.filePath) {
        const content = contents.get(params.filePath);
        if (content !== undefined) {
          if (params.filePath === target) {
            await held.promise;
          }
          return { content, files };
        }
      }
      throw new Error(`Unexpected workshop request: ${method} ${params.filePath ?? ""}`);
    });
    const mounted = mountSolid(() => <SkillWorkshopPage />, {
      wrapper: createSolidApplicationContextProvider(
        createContext(request, { search: "?skill=orchard" }),
      ).wrapper,
    });
    onTestFinished(mounted.unmount);
    const button = (name: string | RegExp) => mounted.getByRole("button", { name });
    const preview = (selector: string) =>
      mounted.container.querySelector(`.sw-files__content ${selector}`);
    const initialSelector = first === "md" ? "h1" : "pre";
    (await waitForSolid(() => button(/^Files/))).click();
    await waitForSolid(() =>
      expect(preview(initialSelector)?.textContent).toBe(first === "md" ? "Pear" : "# Pear"),
    );
    button(sibling).click();
    await waitForSolid(() =>
      expect(preview(initialSelector)?.textContent).toBe(first === "md" ? "Plum" : "# Plum"),
    );

    button(target).click();
    await waitForSolid(() => mounted.getByText("Loading…"));
    expect(button(target).getAttribute("aria-current")).toBe("true");
    expect(request).toHaveBeenCalledWith("skills.workshop.read", {
      agentId: "research",
      name: "orchard",
      filePath: target,
    });
    held.resolve();
    await waitForSolid(() => expect(mounted.container.textContent).toContain("Ripe fruit."));
    await waitForSolid(() => {
      if (next === "md") {
        expect(preview("h1")?.textContent).toBe("Fig");
        expect(preview("p")?.textContent).toBe("Ripe fruit.");
      } else {
        expect(preview("pre")?.textContent).toBe("# Fig\n\nRipe fruit.");
      }
    });
  },
);
