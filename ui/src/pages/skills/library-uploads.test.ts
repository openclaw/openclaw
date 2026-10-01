/* @vitest-environment jsdom */
import { LitElement, html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SkillLibraryFile,
  SkillsLibraryReadResult,
  SkillsLibraryReceipt,
} from "../../../../packages/gateway-protocol/src/schema/skill-library.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import { uploadsDisabledMessage } from "../../lib/uploads.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { SkillLibraryController } from "./library-controller.ts";
import { renderSkillLibrary } from "./library-view.ts";

class LibraryHost extends LitElement {}
customElements.define(`test-skill-uploads-${crypto.randomUUID()}`, LibraryHost);

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
  const host = new LibraryHost();
  const gateway = new GatewayPageController(host, { getGateway: () => connection.gateway });
  const base = createApplicationConfigCapability({ resourceBasePath: "" });
  const config = { ...base, current: { ...base.current, uploadsEnabled: true } };
  const library = new SkillLibraryController(
    host,
    gateway,
    () => "main",
    async () => {},
    () => config,
  );
  document.body.append(host);
  library.list = {
    entries: [],
    profileId: "alice",
    multipleProfiles: true,
    defaultTarget: "personal",
    canManageWorkspace: false,
    defaultSelectionLimit: 64,
  };
  library.view = "mine";
  return { library, config, request };
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
afterEach(() => document.body.replaceChildren());

describe("skill library upload policy", () => {
  it("saves SKILL.md edits with uploads disabled using only retained support-file paths", async () => {
    const { library, config, request } = harness();
    const read = existingSkill();
    request.mockResolvedValueOnce(read);
    await library.open(read.entry.skillId);
    const draft = library.draft!;
    expect(draft.baseFiles[0]).not.toBe(draft.files[0]);
    config.current.uploadsEnabled = false;
    draft.content = "# Edited skill";
    request.mockResolvedValueOnce(savedReceipt(read)).mockResolvedValueOnce(library.list);
    await library.save();
    expect(library.error).toBeNull();
    expect(request).toHaveBeenNthCalledWith(2, "skills.library.save", {
      skillId: read.entry.skillId,
      expectedRevision: read.entry.revision,
      slug: read.entry.slug,
      content: "# Edited skill",
      files: [],
      retainFiles: ["assets/image.png"],
    });
    expect(draft.files).toEqual(read.files);
    expect(draft.baseFiles[0]).not.toBe(draft.files[0]);
    expect(draft.entry?.revision).toBe("b".repeat(64));
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
      const draft = library.draft!;
      const original = { ...draft.files[0]! };
      Object.assign(draft.files[0]!, change);
      config.current.uploadsEnabled = false;
      await library.save();
      expect(request).toHaveBeenCalledTimes(1);
      expect(library.error).toBe(uploadsDisabledMessage());
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
    const draft = library.draft!;
    draft.files[1]!.content = "Updated notes";
    const newFile = { path: "new.txt", content: "New notes", encoding: "utf8" as const };
    draft.files.push(newFile);
    config.current.uploadsEnabled = false;
    await library.save();
    expect(request).toHaveBeenCalledTimes(1);
    expect(library.error).toBe(uploadsDisabledMessage());

    config.current.uploadsEnabled = true;
    request.mockResolvedValueOnce(savedReceipt(read)).mockResolvedValueOnce(library.list);
    await library.save();
    expect(library.error).toBeNull();
    expect(request).toHaveBeenNthCalledWith(
      2,
      "skills.library.save",
      expect.objectContaining({
        retainFiles: ["assets/image.png"],
        files: [{ path: "notes.txt", content: "Updated notes", encoding: "utf8" }, newFile],
      }),
    );
    expect(draft.baseFiles).toEqual(draft.files);
    expect(draft.baseFiles[1]).not.toBe(draft.files[1]);

    config.current.uploadsEnabled = false;
    draft.content = "# Next edit";
    request.mockResolvedValueOnce(savedReceipt(read)).mockResolvedValueOnce(library.list);
    await library.save();
    expect(library.error).toBeNull();
    expect(request).toHaveBeenNthCalledWith(
      4,
      "skills.library.save",
      expect.objectContaining({
        expectedRevision: "b".repeat(64),
        content: "# Next edit",
        retainFiles: ["assets/image.png", "notes.txt", "new.txt"],
        files: [],
      }),
    );
  });

  it("hides pickers and prevents file reads while leaving manual editing available", async () => {
    const { library, config, request } = harness();
    const read = vi.fn(async () => new ArrayBuffer(1));
    config.current.uploadsEnabled = false;
    library.importOpen = true;
    const container = document.createElement("div");
    render(renderSkillLibrary(library, html``), container);
    expect(container.querySelector('input[type="file"]')).toBeNull();
    await library.importFiles([fileWithReader("SKILL.md", read)]);
    expect(read).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(library.error).toBe(uploadsDisabledMessage());
    library.create();
    expect(library.draft).not.toBeNull();
    library.draft!.content = "# Manual skill";
    library.draft!.slug = "manual";
    await library.save();
    expect(request).toHaveBeenCalledWith(
      "skills.library.save",
      expect.objectContaining({ content: "# Manual skill" }),
    );
  });

  it.each(["SKILL.md", "skill.zip"])(
    "rejects %s read completion after policy changes",
    async (name) => {
      const { library, config, request } = harness();
      const read = createDeferred<ArrayBuffer>();
      const reading = library.importFiles([fileWithReader(name, () => read.promise)]);
      config.current.uploadsEnabled = false;
      read.resolve(new TextEncoder().encode("# Skill").buffer);
      await reading;
      expect(request).not.toHaveBeenCalled();
      expect(library.draft).toBeNull();
      expect(library.error).toBe(uploadsDisabledMessage());
    },
  );

  it("does not save a file draft staged before uploads were disabled", async () => {
    const { library, config, request } = harness();
    await library.importFiles([
      fileWithReader("SKILL.md", async () => new TextEncoder().encode("# Skill").buffer),
    ]);
    expect(library.draft?.content).toBe("# Skill");
    config.current.uploadsEnabled = false;
    await library.save();
    expect(request).not.toHaveBeenCalled();
    expect(library.error).toBe(uploadsDisabledMessage());
  });
});
