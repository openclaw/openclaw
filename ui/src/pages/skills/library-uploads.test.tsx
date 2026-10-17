import { createRoot, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SkillLibraryFile,
  SkillsLibraryReadResult,
  SkillsLibraryReceipt,
} from "../../../../packages/gateway-protocol/src/schema/skill-library.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { uploadsDisabledMessage } from "../../lib/uploads.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
/* @vitest-environment jsdom */
import { mountSolid, cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { createSkillLibrary } from "./library-state.ts";
import { SkillLibrary, SkillLibraryDialogs } from "./library-view.tsx";

const disposals: Array<() => void> = [];

function harness() {
  const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
    throw new Error("request sent");
  });
  const connection = createApplicationGateway({
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    hello: gatewayHelloForMethods(["skills.library.save"]),
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  });
  const base = createApplicationConfigCapability({ resourceBasePath: "" });
  const config = { ...base, current: { ...base.current, uploadsEnabled: true } };
  const library = createRoot((dispose) => {
    disposals.push(dispose);
    const gateway = useGatewayPage({ getGateway: () => connection.gateway });
    return createSkillLibrary(gateway, () => config);
  });
  flush();
  library.state.list = {
    entries: [],
    profileId: "alice",
    multipleProfiles: true,
    defaultTarget: "personal",
    canManageWorkspace: false,
    defaultSelectionLimit: 64,
  };
  library.state.view = "mine";
  return { library, config, request, connection };
}
function fileWithReader(name: string, read: () => Promise<ArrayBuffer>) {
  const file = new File(["skill"], name);
  Object.defineProperty(file, "arrayBuffer", { value: read });
  return file;
}
function existingSkill(): SkillsLibraryReadResult {
  return {
    entry: {
      skillId: "12345678-1234-1234-1234-123456789abc",
      revision: "a".repeat(64),
      slug: "existing-skill",
      name: "existing-skill",
      description: "An existing skill with an image",
      ownerProfileId: "alice",
      authorProfileId: "alice",
      ownerLabel: "Alice",
      shared: false,
      enabled: true,
      removed: false,
      canEdit: true,
      createdAt: 1,
      updatedAt: 1,
    },
    content: "# Existing skill",
    files: [
      { path: "assets/image.png", content: "cGljdHVyZQ==", encoding: "base64", executable: false },
    ],
    revisions: [{ revision: "a".repeat(64), createdAt: 1 }],
  };
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
afterEach(() => {
  cleanupSolid();
  for (const dispose of disposals.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
});

describe("skill library upload policy", () => {
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

  it("keeps a replacement save locked when a previous connection's save fails", async () => {
    const { library, request, connection } = harness();
    const oldSave = createDeferred<SkillsLibraryReceipt>();
    const newSave = createDeferred<SkillsLibraryReceipt>();
    const read = existingSkill();
    const initialList = library.state.list;
    request
      .mockResolvedValueOnce(read)
      .mockReturnValueOnce(oldSave.promise)
      .mockResolvedValueOnce(read)
      .mockReturnValueOnce(newSave.promise)
      .mockResolvedValueOnce(initialList);
    await library.open(read.entry.skillId);
    library.state.draft!.content = "First connection edit";
    const savingOld = library.save();
    connection.publish({ ...connection.gateway.snapshot, phase: "reconnecting" });
    library.reset();
    connection.publish({ ...connection.gateway.snapshot, phase: "connected" });
    await library.open(read.entry.skillId);
    library.state.draft!.content = "Current connection edit";
    const savingNew = library.save();
    expect(library.state.busy).toBe(true);

    oldSave.reject(new Error("Previous connection failed"));
    await savingOld;
    expect(library.state.busy).toBe(true);
    expect(library.state.error).toBeNull();

    newSave.resolve(savedReceipt(read));
    await savingNew;
    expect(library.state.busy).toBe(false);
    expect(library.state.draft?.content).toBe("Current connection edit");
    expect(library.state.draft?.entry?.revision).toBe("b".repeat(64));
  });

  it.each([
    ["content", { content: "changed" }],
    ["encoding", { encoding: "utf8" }],
    ["executable metadata", { executable: true }],
    ["path", { path: "assets/renamed.png" }],
  ] satisfies Array<[string, Partial<SkillLibraryFile>]>)(
    "rejects changed support-file %s without silently stripping it when uploads are disabled",
    async (_name, change) => {
      const { library, config, request } = harness();
      const read = existingSkill();
      request.mockResolvedValueOnce(read);
      await library.open(read.entry.skillId);
      const draft = library.state.draft!;
      const original = { ...draft.files[0]! };
      draft.files = draft.files.map((file, index) => (index === 0 ? { ...file, ...change } : file));
      config.current.uploadsEnabled = false;
      await library.save();
      expect(request).toHaveBeenCalledTimes(1);
      expect(library.state.error).toBe(uploadsDisabledMessage());
      expect(draft.files[0]).toEqual({ ...original, ...change });
      expect(draft.baseFiles[0]).toEqual(original);
    },
  );

  it("uploads only changed or new support files and retains their saved baseline on the next edit", async () => {
    const { library, config, request } = harness();
    const read = existingSkill();
    read.files.push({ path: "notes.txt", content: "Original notes", encoding: "utf8" });
    request.mockResolvedValueOnce(read);
    await library.open(read.entry.skillId);
    const draft = library.state.draft!;
    const newFile = { path: "new.txt", content: "New notes", encoding: "utf8" as const };
    draft.files = [
      ...draft.files.map((file) =>
        file.path === "notes.txt" ? { ...file, content: "Updated notes" } : file,
      ),
      newFile,
    ];
    config.current.uploadsEnabled = false;
    await library.save();
    expect(request).toHaveBeenCalledTimes(1);
    expect(library.state.error).toBe(uploadsDisabledMessage());

    config.current.uploadsEnabled = true;
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
});
