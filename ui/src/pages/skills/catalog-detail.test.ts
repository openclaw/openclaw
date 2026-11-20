import { expect, it, vi } from "vitest";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { mountSkills, personalLibrary } from "./skills-page.test-support.tsx";
import { libraryEntry, requestFor } from "./skills.test-support.ts";
import { createReport, createSkill } from "./view.test-support.ts";

const local = createSkill({ filePath: "/work/repo/SKILL.md" });
const lib = libraryEntry();
const text = "---\nname: fixture\n---\n# The original source\n\nUse the **selected document**.";
const base = {
  "skills.status": () => createReport([local]),
  "skills.library.list": () => ({ ...personalLibrary, entries: [lib] }),
  "skills.search": () => ({ results: [] }),
  "skills.files.get": () => ({ name: local.name, path: local.filePath, content: text }),
  "skills.library.read": () => ({
    entry: lib,
    content: text,
    files: [{ path: "sample.txt", content: "other content" }],
    revisions: [],
  }),
  "skills.detail": () => ({
    skill: { displayName: "Remote repo", summary: "Registry description" },
    latestVersion: { version: "2.0.0" },
    owner: { handle: "alice" },
    instructions: { status: "available", content: text },
    inspection: { card: "Generated card" },
  }),
};
function mount(handlers: Parameters<typeof requestFor>[0] = {}) {
  const request = requestFor({ ...base, ...handlers });
  const mounted = mountSkills(request, "discovery", { report: createReport([local]) });
  const navigate = (search: string) =>
    mounted.router.navigate(
      "skills",
      mounted.context,
      {},
      { pathname: "/skills", search, hash: "" },
    );
  return { ...mounted, request, navigate };
}

it.each([
  ["skill=repo-skill", "skills.files.get", { agentId: "main", path: local.filePath }, local.name],
  ["library=" + lib.skillId, "skills.library.read", { skillId: lib.skillId }, lib.slug],
  [
    "clawhub=%40alice%2Frepo",
    "skills.detail",
    { slug: "@alice/repo", includeInstructions: true },
    "Remote repo",
  ],
] as const)(
  "opens %s as a navigable Markdown document, not a dialog",
  async (param, method, expected, title) => {
    const m = mount();
    await m.navigate("?agent=main&q=repo&" + param);
    await waitForFast(
      () =>
        expect(m.page.querySelector("article.markdown h1")?.textContent).toBe(
          "The original source",
        ),
      { timeout: 10_000 },
    );
    expect(m.request).toHaveBeenCalledWith(method, expected);
    expect(m.page.querySelector("#skill-catalog-detail-title")?.textContent).toBe(title);
    const panel = m.page.querySelector(".plugin-catalog-detail__panel")!;
    expect(panel.querySelector("strong")?.textContent).toBe("selected document");
    expect(panel.textContent).not.toMatch(
      /Generated card|other content|Registry description|fixture/,
    );
    expect(m.page.querySelector('[role="dialog"], dialog, .skill-reader-dialog')).toBeNull();
    const back = m.page.querySelector<HTMLAnchorElement>(".plugins-settings-breadcrumb a")!;
    expect(back.getAttribute("href")).toBe("/skills?agent=main&q=repo");
    back.click();
    expect(m.context.navigate).toHaveBeenCalledWith("skills", {
      pathname: "/skills",
      search: "?agent=main&q=repo",
    });
    await m.navigate(back.search);
    await waitForFast(() =>
      expect(m.page.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("repo"),
    );
    expect(m.page.querySelector(".plugin-catalog-detail")).toBeNull();
  },
);

it("does not render a late document after read authority is revoked", async () => {
  const pending = Promise.withResolvers<ReturnType<(typeof base)["skills.detail"]>>();
  const m = mount({ "skills.detail": () => pending.promise });
  await m.navigate("?clawhub=%40alice%2Frepo");
  await waitForFast(() =>
    expect(m.page.querySelector('.plugin-catalog-detail [role="status"]')?.textContent).toContain(
      "Loading",
    ),
  );
  m.connection.publish({ ...m.connection.gateway.snapshot, hello: gatewayHelloForMethods([], []) });
  pending.resolve(base["skills.detail"]());
  await waitForFast(() =>
    expect(m.page.querySelector('.plugin-catalog-detail [role="alert"]')?.textContent).toContain(
      "read",
    ),
  );
  expect(m.page.querySelector("article.markdown")).toBeNull();
});

it("recovers a failed file read without falling back to another document", async () => {
  const get = vi
    .fn()
    .mockRejectedValueOnce(new Error("Document unavailable"))
    .mockResolvedValue(base["skills.files.get"]());
  const m = mount({ "skills.files.get": get });
  await m.navigate("?skill=repo-skill");
  await waitForFast(() =>
    expect(m.page.querySelector('[role="alert"]')?.textContent).toContain("Document unavailable"),
  );
  expect(m.page.querySelector("article.markdown")).toBeNull();
  m.page.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
  await waitForFast(() =>
    expect(m.page.querySelector("article.markdown h1")?.textContent).toBe("The original source"),
  );
  expect(get).toHaveBeenCalledTimes(2);
});

it.each(["personal", "workspace"] as const)(
  "preserves the %s install destination and selected release",
  async (destination) => {
    const m = mount({
      "skills.library.list": () => ({ ...personalLibrary, defaultTarget: destination }),
      "skills.install": () => ({ message: "Installed" }),
    });
    await m.navigate("?clawhub=%40alice%2Frepo");
    const action = () =>
      m.page.querySelector<HTMLButtonElement>(".plugin-catalog-detail__actions button");
    await waitForFast(() => expect(action()?.disabled).toBe(false));
    action()!.click();
    if (destination === "personal") {
      await waitForFast(() =>
        expect(m.page.querySelector("openclaw-modal-dialog")?.textContent).toContain("@alice/repo"),
      );
      expect(m.request.mock.calls.some(([method]) => method === "skills.install")).toBe(false);
    } else {
      await waitForFast(() =>
        expect(m.request).toHaveBeenCalledWith("skills.install", {
          agentId: "main",
          source: "clawhub",
          slug: "@alice/repo",
          version: "2.0.0",
        }),
      );
    }
  },
);

it("reports unavailable source instead of substituting the generated registry card", async () => {
  const m = mount({
    "skills.detail": () => ({
      ...base["skills.detail"](),
      instructions: { status: "unavailable", reason: "This release has no SKILL.md" },
      card: { status: "available", content: "Generated card" },
    }),
  });
  await m.navigate("?clawhub=%40alice%2Frepo");
  await waitForFast(() =>
    expect(m.page.querySelector('[role="alert"]')?.textContent).toContain(
      "This release has no SKILL.md",
    ),
  );
  expect(m.page.querySelector("article.markdown")).toBeNull();
  expect(m.page.textContent).not.toContain("Generated card");
});
