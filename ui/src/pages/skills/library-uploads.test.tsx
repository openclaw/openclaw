import { createRoot, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import type {
  SkillLibraryFile,
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
  SkillsLibraryReceipt,
} from "../../../../packages/gateway-protocol/src/schema/skill-library.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { uploadsDisabledMessage } from "../../lib/uploads.ts";
/* @vitest-environment jsdom */
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { trackSolidRoot } from "../../test-helpers/solid-cleanup.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createSkillLibrary } from "./library-state.ts";
import { SkillLibrary, SkillLibraryDialogs } from "./library-view.tsx";
import { connectedGateway, libraryEntry, libraryList, requestFor } from "./skills.test-support.ts";

function harness() {
  const request = requestFor();
  const connection = connectedGateway(request, ["skills.library.save"]);
  const base = createApplicationConfigCapability({ resourceBasePath: "" });
  const config = { ...base, current: { ...base.current, uploadsEnabled: true } };
  const library = createRoot((dispose) => {
    trackSolidRoot(dispose);
    const gateway = useGatewayPage({ getGateway: () => connection.gateway });
    return createSkillLibrary(gateway, () => config);
  });
  flush();
  library.state.list = libraryList(false);
  library.state.view = "mine";
  return { library, config, request, connection };
}
function fileWithReader(name: string, read: () => Promise<ArrayBuffer>) {
  const file = new File(["skill"], name);
  Object.defineProperty(file, "arrayBuffer", { value: read });
  return file;
}
function existingSkill(files: SkillLibraryFile[] = []): SkillsLibraryReadResult {
  return {
    entry: libraryEntry(),
    content: "# Existing skill",
    files: [
      { path: "assets/image.png", content: "cGljdHVyZQ==", encoding: "base64", executable: false },
      ...files,
    ],
    revisions: [{ revision: "a".repeat(64), createdAt: 1 }],
  };
}
async function openSkill(files: SkillLibraryFile[] = []) {
  const context = harness();
  const read = existingSkill(files);
  context.request.mockResolvedValueOnce(read);
  await context.library.open(read.entry.skillId);
  return { ...context, read, draft: context.library.state.draft! };
}
function savedReceipt(read: SkillsLibraryReadResult): SkillsLibraryReceipt {
  return {
    entry: { ...read.entry, revision: "b".repeat(64), updatedAt: 2 },
    state: "published",
    target: "personal",
    sessionActivation: "new-sessions",
    nextAction: "Use in a new session.",
  };
}
it("disables import while disconnected without losing the local selection", () => {
  const { library, connection } = harness();
  library.setImportOpen(true);
  library.state.importSelection = [new File(["# Skill"], "SKILL.md")];
  const view = mountSolid(() => <SkillLibraryDialogs library={library} />);
  flush();
  const submit = view.container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(submit.disabled).toBe(false);
  connection.publish({ ...connection.gateway.snapshot, phase: "reconnecting" });
  flush();
  expect(submit.disabled).toBe(true);
  expect(library.state.importSelection).toHaveLength(1);
});

it("retains library controls and keyed rows through pending, failed, and retried reads", async () => {
  const { library, request } = harness();
  library.state.list = null;
  const first = createDeferred<SkillsLibraryListResult>();
  request.mockReturnValueOnce(first.promise);
  const view = mountSolid(() => <SkillLibrary library={library} navigationActions={null} />);
  const initial = library.load();
  flush();
  const search = view.container.querySelector<HTMLInputElement>('input[name="library-search"]')!;
  search.focus();
  expect(view.container.querySelector('[role="status"]')?.textContent).toContain("Loading");
  expect(view.container.querySelector(".settings-row")).toBeNull();
  library.create();
  expect(library.state.draft).toBeNull();

  const list = {
    ...libraryList(false),
    entries: [
      libraryEntry(),
      libraryEntry({ skillId: "second-skill", slug: "other-skill", name: "Other skill" }),
    ],
  };
  first.resolve(list);
  await initial;
  await waitForFast(() => expect(view.container.textContent).toContain("existing-skill"));
  const row = view.container.querySelector(".settings-row")!;
  const refresh = () =>
    Array.from(view.container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Refresh",
    )!;
  const failed = createDeferred<SkillsLibraryListResult>();
  request.mockReturnValueOnce(failed.promise);
  refresh().click();
  flush();
  expect(view.container.querySelector(".settings-row")).toBe(row);
  expect(row.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
  expect(view.container.querySelector('input[name="library-search"]')).toBe(search);
  search.value = "existing-skill";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(view.container.querySelectorAll(".settings-row")).toHaveLength(1);
  expect(view.container.querySelector(".settings-row")).toBe(row);

  failed.reject(new Error("Library list unavailable"));
  await waitForFast(() =>
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Library list unavailable",
    ),
  );
  expect(view.container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(view.container.querySelector(".settings-row")).toBe(row);
  expect(document.activeElement).toBe(search);
  expect(row.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);

  library.state.error = "A later mutation conflict";
  flush();
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
    "A later mutation conflict",
  );
  expect(view.container.querySelector(".settings-row")).toBe(row);
  request.mockResolvedValueOnce({
    ...list,
    entries: [{ ...list.entries[0]!, description: "Updated library skill" }],
  });
  refresh().click();
  await waitForFast(() => expect(row.textContent).toContain("Updated library skill"));
  expect(view.container.querySelector(".settings-row")).toBe(row);
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(request).toHaveBeenCalledTimes(3);

  const retainedRefresh = createDeferred<SkillsLibraryListResult>();
  request.mockReturnValueOnce(retainedRefresh.promise);
  const pendingRefresh = library.load();
  flush();
  view.unmount();
  const remounted = mountSolid(() => <SkillLibrary library={library} navigationActions={null} />);
  flush();
  expect(remounted.container.querySelector(".settings-row")?.textContent).toContain(
    "Updated library skill",
  );
  expect(
    remounted.container.querySelector<HTMLButtonElement>(".settings-row button")?.disabled,
  ).toBe(true);
  retainedRefresh.resolve(list);
  await pendingRefresh;
});

it.each(["list", "save"] as const)("ignores stale %s failures", async (operation) => {
  const { library, request, connection } = harness();
  const oldResult = createDeferred<SkillsLibraryListResult | SkillsLibraryReceipt>();
  const newResult = createDeferred<SkillsLibraryListResult | SkillsLibraryReceipt>();
  const read = existingSkill();
  const list = library.state.list!;
  const flag = operation === "list" ? "loading" : "busy";
  async function begin(result: typeof oldResult, content: string) {
    if (operation === "save") {
      request.mockResolvedValueOnce(read);
      await library.open(read.entry.skillId);
      library.state.draft!.content = content;
    }
    request.mockReturnValueOnce(result.promise);
    return { pending: operation === "list" ? library.load() : library.save() };
  }
  const old = await begin(oldResult, "First connection edit");
  connection.publish({ ...connection.gateway.snapshot, phase: "reconnecting" });
  library.reset();
  connection.publish({ ...connection.gateway.snapshot, phase: "connected" });
  const current = await begin(newResult, "Current connection edit");
  expect(request).toHaveBeenCalledTimes(operation === "list" ? 2 : 4);
  expect(library.state[flag]).toBe(true);
  oldResult.reject(new Error("Previous connection failed"));
  await old.pending;
  expect(library.state).toMatchObject({ [flag]: true, error: null });
  if (operation === "save") {
    request.mockResolvedValueOnce(list);
  }
  newResult.resolve(operation === "list" ? { ...list, profileId: "bob" } : savedReceipt(read));
  await current.pending;
  expect(library.state).toMatchObject({
    [flag]: false,
    error: null,
    ...(operation === "list"
      ? { list: { profileId: "bob" } }
      : { draft: { content: "Current connection edit", entry: { revision: "b".repeat(64) } } }),
  });
});

it.each([
  { content: "changed" },
  { encoding: "utf8" },
  { executable: true },
  { path: "assets/renamed.png" },
] satisfies Partial<SkillLibraryFile>[])(
  "blocks support-file changes without stripping them: %j",
  async (change) => {
    const { library, config, request, draft } = await openSkill();
    const original = { ...draft.files[0]! };
    draft.files = [{ ...original, ...change }];
    config.current.uploadsEnabled = false;
    await library.save();
    expect(request).toHaveBeenCalledTimes(1);
    expect(library.state.error).toBe(uploadsDisabledMessage());
    expect(draft.files[0]).toEqual({ ...original, ...change });
    expect(draft.baseFiles[0]).toEqual(original);
  },
);

it("uploads only changed or new support files and retains their saved baseline on the next edit", async () => {
  const { library, config, request, read, draft } = await openSkill([
    { path: "notes.txt", content: "Original notes", encoding: "utf8" },
  ]);
  const newFile = { path: "new.txt", content: "New notes", encoding: "utf8" as const };
  draft.files = [draft.files[0]!, { ...draft.files[1]!, content: "Updated notes" }, newFile];
  request.mockResolvedValueOnce(savedReceipt(read)).mockResolvedValueOnce(library.state.list);
  await library.save();
  expect(library.state.error).toBeNull();
  expect(request).toHaveBeenNthCalledWith(
    2,
    "skills.library.save",
    expect.objectContaining({
      retainFiles: ["assets/image.png"],
      files: [{ path: "notes.txt", content: "Updated notes", encoding: "utf8" }, newFile],
    }),
  );
  expect(draft.baseFiles).toEqual(draft.files);

  config.current.uploadsEnabled = false;
  draft.content = "# Next edit";
  request.mockResolvedValueOnce(savedReceipt(read)).mockResolvedValueOnce(library.state.list);
  await library.save();
  expect(library.state.error).toBeNull();
  expect(request).toHaveBeenNthCalledWith(4, "skills.library.save", {
    skillId: read.entry.skillId,
    slug: read.entry.slug,
    expectedRevision: "b".repeat(64),
    content: "# Next edit",
    retainFiles: ["assets/image.png", "notes.txt", "new.txt"],
    files: [],
  });
});

it("hides pickers and prevents file reads while leaving manual editing available", async () => {
  const { library, config, request } = harness();
  const read = vi.fn(async () => new ArrayBuffer(1));
  config.current.uploadsEnabled = false;
  library.setImportOpen(true);
  const container = document.createElement("div");
  mountSolid(() => <SkillLibrary library={library} navigationActions={null} />, { container });
  expect(container.querySelector('input[type="file"]')).toBeNull();
  await library.importFiles([fileWithReader("SKILL.md", read)]);
  expect(read).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(library.state.error).toBe(uploadsDisabledMessage());
  library.create();
  expect(library.state.draft).not.toBeNull();
  library.state.draft!.content = "# Manual skill";
  library.state.draft!.slug = "manual";
  await library.save();
  expect(request).toHaveBeenCalledWith(
    "skills.library.save",
    expect.objectContaining({ content: "# Manual skill" }),
  );
});

it.each([
  { name: "SKILL.md", phase: "read" },
  { name: "skill.zip", phase: "read" },
  { name: "SKILL.md", phase: "save" },
])("rejects $name after uploads are disabled during $phase", async ({ name, phase }) => {
  const { library, config, request } = harness();
  const read = createDeferred<ArrayBuffer>();
  const reading = library.importFiles([fileWithReader(name, () => read.promise)]);
  if (phase === "read") {
    config.current.uploadsEnabled = false;
  }
  read.resolve(new TextEncoder().encode("# Skill").buffer);
  await reading;
  if (phase === "save") {
    expect(library.state.draft?.content).toBe("# Skill");
    config.current.uploadsEnabled = false;
    await library.save();
  } else {
    expect(library.state.draft).toBeNull();
  }
  expect(request).not.toHaveBeenCalled();
  expect(library.state.error).toBe(uploadsDisabledMessage());
});
