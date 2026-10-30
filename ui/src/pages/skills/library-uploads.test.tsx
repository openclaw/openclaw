import { createRoot, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type {
  SkillLibraryFile,
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
  SkillsLibraryReceipt,
} from "../../../../packages/gateway-protocol/src/schema/skill-library.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import { registerSkillsBrowserEnglish } from "../../i18n/locales/en-skills-browser.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { uploadsDisabledMessage } from "../../lib/uploads.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
/* @vitest-environment jsdom */
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { trackSolidRoot } from "../../test-helpers/solid-cleanup.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createSkillLibrary, type SkillLibraryModel } from "./library-state.ts";
import { SkillLibrary, SkillLibraryDialogs } from "./library-view.tsx";
import { connectedGateway, libraryEntry, libraryList, requestFor } from "./skills.test-support.ts";

registerSkillsBrowserEnglish();

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
function mountLibrary(library: SkillLibraryModel, dialogsOnly = false) {
  return mountSolid(() =>
    dialogsOnly ? (
      <SkillLibraryDialogs library={library} />
    ) : (
      <SkillLibrary library={library} navigationActions={null} />
    ),
  );
}
function buttonIn(container: Element, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label,
  )!;
}
function reconnect(context: Pick<ReturnType<typeof harness>, "library" | "connection">) {
  const { connection, library } = context;
  connection.publish({ ...connection.gateway.snapshot, phase: "reconnecting" });
  library.reset();
  connection.publish({ ...connection.gateway.snapshot, phase: "connected" });
}
function nextRequest<T>(request: ReturnType<typeof requestFor>) {
  const pending = createDeferred<T>();
  request.mockReturnValueOnce(pending.promise);
  return pending;
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

it.each([
  { action: "disable", outcome: "error" },
  { action: "share", outcome: "success" },
] as const)(
  "retains the library editor and reconciles a held $action after $outcome",
  async ({ action, outcome }) => {
    onTestFinished(installDialogPolyfill());
    const { library, request, read, draft } = await openSkill();
    library.edit((state) => {
      state.list = { ...state.list!, entries: [read.entry] };
    });
    const mutation = createDeferred<SkillsLibraryReceipt>();
    const reload = createDeferred<SkillsLibraryListResult>();
    request.mockReturnValueOnce(mutation.promise).mockReturnValueOnce(reload.promise);
    const mounted = mountLibrary(library);
    flush();
    await waitForFast(() =>
      expect(mounted.container.querySelector(".settings-row")).not.toBeNull(),
    );
    const dialog = mounted.container.querySelector(".skill-reader-dialog")!;
    const { dialog: nativeDialog } = await getRenderedModalDialog(mounted.container);
    const row = mounted.container.querySelector(".settings-row")!;
    const button = (label: string) => buttonIn(dialog, label);
    const before = action === "disable" ? "Disable" : "Share with team";
    const after = action === "disable" ? "Enable" : "Make private";
    button(before).click();
    expect(request).toHaveBeenNthCalledWith(2, "skills.library.mutate", {
      action,
      skillId: read.entry.skillId,
      expectedRevision: read.entry.revision,
    });
    await waitForFast(() => {
      expect(button(after).disabled).toBe(true);
      expect(row.textContent).toContain(action === "disable" ? "Disabled" : "Shared with team");
      expect(nativeDialog.open).toBe(true);
    });
    if (outcome === "error") {
      mutation.reject(new Error("Synthetic rejected library update"));
      await waitForFast(() => {
        expect(button(before).disabled).toBe(false);
        expect(row.textContent).toContain(action === "disable" ? "Enabled" : "Private");
        expect(dialog.textContent).toContain("Synthetic rejected library update");
      });
    } else {
      const receipt = savedReceipt(read);
      receipt.entry.shared = true;
      mutation.resolve(receipt);
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
      expect(button(after).disabled).toBe(true);
      reload.resolve({ ...libraryList(false), entries: [receipt.entry] });
      await waitForFast(() => {
        expect(button(after).disabled).toBe(false);
        expect(draft.entry!.revision).toBe(receipt.entry.revision);
      });
    }
    expect(mounted.container.querySelector(".skill-reader-dialog")).toBe(dialog);
    expect(mounted.container.querySelector(".settings-row")).toBe(row);
  },
);

it("keeps removal confirmation outside mutation presentation", async () => {
  const { library, request } = await openSkill();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const mounted = mountLibrary(library, true);
  flush();
  const remove = buttonIn(mounted.container, "Remove skill");
  remove.click();
  flush();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(remove.disabled).toBe(false);
  expect(library.state.busy).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(["files", "clawhub"])(
  "keeps %s import presentation locked through owner settlement",
  async (kind) => {
    const { library, request } = harness();
    library.setImportOpen(true);
    library.state.importSlug = "imported-skill";
    if (kind === "clawhub") {
      library.state.importSource = { slug: "@fixture/calendar" };
    }
    const mounted = mountLibrary(library);
    flush();
    const dialog = mounted.container.querySelector(".skill-reader-dialog")!;
    const submit = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const reading = createDeferred<ArrayBuffer>();
    const imported = createDeferred<SkillsLibraryReceipt>();
    const reload = createDeferred<SkillsLibraryListResult>();
    if (kind === "clawhub") {
      request.mockReturnValueOnce(imported.promise).mockReturnValueOnce(reload.promise);
    }
    const operation =
      kind === "files"
        ? library.importFiles([fileWithReader("SKILL.md", () => reading.promise)])
        : library.importClawHub("imported-skill", "@fixture/calendar");
    await waitForFast(() => {
      expect(submit.disabled).toBe(true);
      expect(submit.textContent).toContain("Loading");
    });
    if (kind === "files") {
      reading.resolve(new TextEncoder().encode("# Imported skill").buffer);
    } else {
      const receipt = savedReceipt(existingSkill());
      imported.resolve(receipt);
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      const create = buttonIn(mounted.container, "Create skill");
      expect(create.disabled).toBe(true);
      reload.resolve({ ...libraryList(false), entries: [receipt.entry] });
    }
    await operation;
    await waitForFast(() => {
      expect(mounted.container.querySelector('[name="library-import-slug"]')).toBeNull();
      if (kind === "files") {
        expect(
          mounted.container.querySelector<HTMLTextAreaElement>('[name="library-content"]')?.value,
        ).toBe("# Imported skill");
      } else {
        expect(mounted.container.textContent).toContain("existing-skill");
      }
    });
  },
);
it("disables import while disconnected without losing the local selection", () => {
  const { library, connection } = harness();
  library.setImportOpen(true);
  library.state.importSelection = [new File(["# Skill"], "SKILL.md")];
  const view = mountLibrary(library, true);
  flush();
  const submit = view.container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(submit.disabled).toBe(false);
  connection.publish({ ...connection.gateway.snapshot, phase: "reconnecting" });
  flush();
  expect(submit.disabled).toBe(true);
  expect(library.state.importSelection).toHaveLength(1);
});

it.each(["detail", "list"] as const)(
  "retains %s controls through failed reads and retry",
  async (kind) => {
    onTestFinished(installDialogPolyfill());
    const { library, request } = harness();
    const detail = kind === "detail";
    if (!detail) {
      library.state.list = null;
    }
    const view = mountLibrary(library, detail);
    let skillId = libraryEntry().skillId;
    const run = () => (detail ? library.open(skillId) : library.load());
    const result = (text: string) =>
      detail
        ? { ...existingSkill(), content: text }
        : { ...libraryList(false), entries: [libraryEntry({ description: text })] };
    const item = () => view.container.querySelector(detail ? "textarea" : ".settings-row");
    const locked = () =>
      detail
        ? view.container.querySelector<HTMLTextAreaElement>("textarea")?.readOnly
        : view.container.querySelector<HTMLButtonElement>(".settings-row button")?.disabled;
    const text = () =>
      detail
        ? view.container.querySelector<HTMLTextAreaElement>("textarea")?.value
        : item()?.textContent;
    const expectText = (value: string) =>
      detail ? expect(text()).toBe(value) : expect(text()).toContain(value);
    const first = nextRequest<SkillsLibraryReadResult | SkillsLibraryListResult>(request);
    const opening = run();
    flush();
    expect(item()).toBeNull();
    if (detail) {
      expect(view.container.querySelector(".skill-reader-dialog")).toBeNull();
      await run();
      expect(request).toHaveBeenCalledTimes(1);
    } else {
      expect(view.container.querySelector('[role="status"]')?.textContent).toContain("Loading");
      library.create();
      expect(library.state.draft).toBeNull();
      view.container.querySelector<HTMLInputElement>('input[name="library-search"]')!.focus();
    }
    first.resolve(result("Initial skill"));
    await opening;
    await waitForFast(() => expectText("Initial skill"));
    const retained = item();
    const dialog = detail ? (await getRenderedModalDialog(view.container)).dialog : null;
    skillId = "replacement-skill";
    const refresh = () => (detail ? run() : buttonIn(view.container, "Refresh").click());
    const failure = nextRequest<SkillsLibraryReadResult | SkillsLibraryListResult>(request);
    void refresh();
    flush();
    expect(locked()).toBe(true);
    expectText("Initial skill");
    failure.reject(new Error("Library unavailable"));
    await waitForFast(() => {
      expect(locked()).toBe(false);
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Library unavailable",
      );
    });
    expect(item()).toBe(retained);
    expect(view.container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    if (dialog) {
      expect(dialog.open).toBe(true);
    } else {
      expect(document.activeElement).toBe(
        view.container.querySelector('input[name="library-search"]'),
      );
    }
    request.mockResolvedValueOnce(result("Updated skill"));
    void refresh();
    await waitForFast(() => expectText("Updated skill"));
    expect(item()).toBe(retained);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    if (!detail) {
      const pending = nextRequest<SkillsLibraryListResult>(request);
      const reloading = run();
      flush();
      view.unmount();
      const remounted = mountLibrary(library);
      flush();
      expect(remounted.container.querySelector(".settings-row")?.textContent).toContain(
        "Updated skill",
      );
      expect(
        remounted.container.querySelector<HTMLButtonElement>(".settings-row button")?.disabled,
      ).toBe(true);
      pending.resolve({ ...libraryList(false), entries: [libraryEntry()] });
      await reloading;
    }
  },
);

it.each([
  { operation: "list", outcome: "error" },
  { operation: "read", outcome: "error" },
  { operation: "save", outcome: "error" },
  { operation: "save", outcome: "success" },
] as const)(
  "retires stale $operation $outcome without changing its successor",
  async ({ operation, outcome }) => {
    type Result = SkillsLibraryListResult | SkillsLibraryReadResult | SkillsLibraryReceipt;
    const { library, request, connection } = harness();
    const read = existingSkill();
    const list = library.state.list!;
    const view = operation === "read" ? mountLibrary(library, true) : null;
    const flag = operation === "list" ? "loading" : "busy";
    async function begin(content: string) {
      if (operation === "save") {
        request.mockResolvedValueOnce(read);
        await library.open(read.entry.skillId);
        library.state.draft!.content = content;
      }
      const result = nextRequest<Result>(request);
      const pending =
        operation === "list"
          ? library.load()
          : operation === "read"
            ? library.open(read.entry.skillId)
            : library.save();
      return { result, pending };
    }
    const old = await begin("Old edit");
    if (outcome === "success") {
      await waitForFast(() => expect(library.saving()).toBe(true));
    }
    reconnect({ library, connection });
    await waitForFast(() => expect(library.saving()).toBe(false));
    const current = await begin("Current edit");
    const result =
      operation === "list"
        ? { ...list, profileId: "bob" }
        : operation === "read"
          ? { ...read, content: "Current edit" }
          : savedReceipt(read);
    if (operation === "read") {
      current.result.resolve(result);
      await current.pending;
    }
    if (outcome === "error") {
      old.result.reject(new Error("Previous connection failed"));
    } else {
      old.result.resolve(savedReceipt(read));
    }
    await old.pending;
    expect(library.state).toMatchObject({ [flag]: operation !== "read", error: null });
    if (operation === "save") {
      expect(library.state.draft).toMatchObject({ content: "Current edit", entry: read.entry });
      request.mockResolvedValueOnce(list);
    }
    current.result.resolve(result);
    await current.pending;
    expect(library.state).toMatchObject({ [flag]: false, error: null });
    if (operation === "list") {
      expect(library.state.list?.profileId).toBe("bob");
    } else {
      expect(library.state.draft).toMatchObject({
        content: "Current edit",
        entry: { revision: operation === "read" ? read.entry.revision : "b".repeat(64) },
      });
    }
    if (view) {
      await waitForFast(() => {
        expect(view.container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
          "Current edit",
        );
        expect(view.container.querySelector('[role="alert"]')).toBeNull();
      });
    }
  },
);

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

it("settles support-file saves after caller retirement and retains their baseline on the next edit", async () => {
  const { library, config, request, read, draft } = await openSkill([
    { path: "notes.txt", content: "Original notes", encoding: "utf8" },
  ]);
  const newFile = { path: "new.txt", content: "New notes", encoding: "utf8" as const };
  draft.files = [draft.files[0]!, { ...draft.files[1]!, content: "Updated notes" }, newFile];
  const pending = nextRequest<SkillsLibraryReceipt>(request);
  request.mockResolvedValueOnce(library.state.list);
  const saving = createRoot((dispose) => {
    const operation = library.save();
    library.retire();
    dispose();
    return operation;
  });
  pending.resolve(savedReceipt(read));
  await saving;
  expect(library.state.busy).toBe(false);
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
