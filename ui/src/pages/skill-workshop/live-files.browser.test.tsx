import type {
  SkillsWorkshopListResult,
  SkillsWorkshopReadResult,
} from "@openclaw/gateway-protocol";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createContext } from "./skill-workshop-page.test-support.ts";
import { SkillWorkshopPage } from "./skill-workshop-page.tsx";

it.each([undefined, "20260930T010000000Z-patch"])(
  "keeps support-file groups and read targets for version %s",
  async (versionId) => {
    const files = ["SKILL.md", "assets/a.txt", "assets/deep/b.txt", "assets/z.txt", "readme.txt"];
    const currentFiles = versionId ? ["SKILL.md", "current.txt"] : files;
    const list: SkillsWorkshopListResult = {
      agentId: "research",
      mode: "auto",
      root: "/synthetic/workshop",
      skills: [
        {
          name: "orchard",
          description: "Tend fruit trees",
          files: currentFiles,
          sizeBytes: 40,
          updatedAtMs: 1,
        },
      ],
      archived: versionId
        ? [
            {
              name: "orchard",
              live: true,
              versions: [{ id: versionId, action: "patch", createdAtMs: 1 }],
            },
          ]
        : [],
    };
    const request = vi.fn(
      async (method: string, params: { filePath?: string; versionId?: string }) => {
        if (method === "skills.workshop.list") {
          return list;
        }
        if (method === "skills.workshop.changes") {
          return { changes: [] };
        }
        if (method === "skills.workshop.read" && params.filePath) {
          return {
            name: "orchard",
            filePath: params.filePath,
            content: params.filePath === "SKILL.md" ? "# Orchard" : "Water the trees.",
            files: params.versionId ? files : currentFiles,
          } satisfies SkillsWorkshopReadResult;
        }
        throw new Error("Unexpected workshop request: " + method);
      },
    );
    const mounted = mountSolid(() => <SkillWorkshopPage />, {
      wrapper: createSolidApplicationContextProvider(
        createContext(request, { search: "?skill=orchard" }),
      ).wrapper,
    });
    onTestFinished(mounted.unmount);
    const button = (name: string | RegExp) => mounted.getByRole("button", { name });
    await waitForSolid(() => mounted.getByRole("heading", { name: /^Orchard$/ }));
    if (versionId) {
      button(/^History/).click();
      (await waitForSolid(() => button("Compare"))).click();
      await waitForSolid(() =>
        expect(mounted.container.querySelector(".sw-diff__same")).not.toBeNull(),
      );
    }
    button(/^Files/).click();
    await waitForSolid(() => expect(button("a.txt").getAttribute("aria-current")).toBe("true"));
    const fileList = mounted.container.querySelector(".sw-files__list")!;
    expect(
      Array.from(fileList.children, (element) => [element.tagName, element.textContent]),
    ).toEqual([
      ["SPAN", "assets"],
      ["UL", "a.txtz.txt"],
      ["SPAN", "assets/deep"],
      ["UL", "b.txt"],
      ["UL", "readme.txt"],
    ]);
    expect(
      Array.from(fileList.querySelectorAll("button"), (element) => [
        element.title,
        element.textContent,
      ]),
    ).toEqual([
      ["assets/a.txt", "a.txt"],
      ["assets/z.txt", "z.txt"],
      ["assets/deep/b.txt", "b.txt"],
      ["readme.txt", "readme.txt"],
    ]);
    const target = { agentId: "research", name: "orchard", ...(versionId ? { versionId } : {}) };
    expect(request).toHaveBeenCalledWith("skills.workshop.read", {
      ...target,
      filePath: "assets/a.txt",
    });
    button("b.txt").click();
    await waitForSolid(() => expect(button("b.txt").getAttribute("aria-current")).toBe("true"));
    expect(button("a.txt").getAttribute("aria-current")).toBeNull();
    expect(request).toHaveBeenCalledWith("skills.workshop.read", {
      ...target,
      filePath: "assets/deep/b.txt",
    });
    await waitForSolid(() =>
      expect(mounted.container.querySelector(".sw-file")?.textContent).toBe("Water the trees."),
    );
  },
);

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
