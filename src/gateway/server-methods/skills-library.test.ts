import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type {
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
  SkillsLibraryReceipt,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import {
  upsertSessionEntryCore,
  loadSessionEntry,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as fsSafe from "../../infra/fs-safe.js";
import * as libraryBundle from "../../skills/library/bundle.js";
import { seedSkillLibrarySelection } from "../../skills/library/selection.js";
import { mutateSkillLibrary, saveSkillLibrary } from "../../skills/library/service.js";
import type { SkillLibraryAuthority } from "../../skills/library/store.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  cleanupSessionStateForTest,
  useSessionStoreTempDirs,
} from "../../test-utils/session-state-cleanup.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayClient } from "./client-types.js";
import { skillsLibraryHandlers } from "./skills-library.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const temps = useSessionStoreTempDirs(afterAll, "library-session-projection-");
let currentStateDir: string | undefined;
afterEach(async () => {
  if (currentStateDir) {
    await cleanupSessionStateForTest({ stateDir: currentStateDir });
    currentStateDir = undefined;
  }
  vi.unstubAllEnvs();
});
const content =
  "---\nname: shared-session\ndescription: Session-pinned private procedure\n---\n# Session procedure\n";
const image = {
  path: "assets/pixel.png",
  content:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  encoding: "base64" as const,
};

function retainedFilesHarness() {
  const root = temps.make();
  currentStateDir = root;
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const alice = ensureProfileForEmail("alice@example.test");
  const bob = ensureProfileForEmail("bob@example.test");
  const cfg = { gateway: { uploads: { enabled: true } } };
  const actor = (profileId: string): SkillLibraryAuthority => ({
    profileId,
    scopes: ["operator.read", "operator.write"],
    getConfig: () => cfg,
    assertCurrent: () => {},
  });
  const methodRegistry = createGatewayMethodRegistry(
    ["skills.library.save", "skills.library.read"].map((name) => ({
      name,
      handler: skillsLibraryHandlers[name]!,
      scope: "operator.write" as const,
      owner: { kind: "core" as const, area: "skills" },
      profileAccess: "independent" as const,
    })),
  );
  const call = async (method: string, params: Record<string, unknown>, profileId = alice.id) => {
    const client: GatewayClient = {
      authenticatedUserProfile: { profileId, displayName: null, hasAvatar: false, updatedAt: 1 },
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        client: { id: "test", mode: "test", platform: "test", version: "1" },
      },
    };
    const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
    await handleGatewayRequest({
      req: { type: "req", id: "retained-files", method, params },
      respond,
      client,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () => cfg,
        getCommittedRuntimeConfig: () => cfg,
      } as GatewayRequestHandlerOptions["context"],
      methodRegistry,
    });
    return respond.mock.calls[0]!;
  };
  return { alice, bob, actor, cfg, call, root };
}

describe("skill library retained support files", () => {
  it("rejects client file creation at the real filesystem mutation admission", async () => {
    const { call, cfg, root } = retainedFilesHarness();
    const openRoot = fsSafe.root;
    let admissionReached = false;
    let imageCreated = false;
    using roots = vi.spyOn(fsSafe, "root").mockImplementation(async (directory, defaults) => {
      let creatingImage = false;
      const opened = await openRoot(directory, {
        ...defaults,
        assertBeforeMutation: () => {
          if (creatingImage) {
            admissionReached = true;
            cfg.gateway.uploads.enabled = false;
          }
          defaults?.assertBeforeMutation?.();
        },
      });
      const create = opened.create.bind(opened);
      opened.create = async (relativePath, data, options) => {
        creatingImage = relativePath.endsWith("pixel.png");
        try {
          // Keep the byte/string and streaming overloads intact in this pass-through.
          if (typeof data === "string" || Buffer.isBuffer(data)) {
            await create(relativePath, data, options);
          } else {
            await create(relativePath, data, options);
          }
          if (creatingImage) {
            imageCreated = true;
          }
        } finally {
          creatingImage = false;
        }
      };
      return opened;
    });
    const result = await call("skills.library.save", {
      slug: "file-policy",
      content,
      expectedRevision: null,
      files: [image],
    });
    expect.soft(result[0]).toBe(false);
    expect
      .soft(result[2])
      .toMatchObject({ code: "FORBIDDEN", details: { code: "UPLOADS_DISABLED" } });
    expect(roots).toHaveBeenCalled();
    expect(admissionReached).toBe(true);
    // A later denial and cleanup must not hide an earlier successful file creation.
    expect(imageCreated).toBe(false);
    const files = await fs.readdir(root, { recursive: true, withFileTypes: true });
    expect(files.filter((entry) => entry.isFile() && entry.name === "pixel.png")).toEqual([]);
  });

  it("does not publish client files when uploads turn off after real bundle staging", async () => {
    const { call, cfg, root } = retainedFilesHarness();
    const stage = libraryBundle.stageSkillLibraryBundle;
    using staged = vi
      .spyOn(libraryBundle, "stageSkillLibraryBundle")
      .mockImplementation(async (...args) => {
        const result = await stage(...args);
        cfg.gateway.uploads.enabled = false;
        return result;
      });
    const result = await call("skills.library.save", {
      slug: "late-policy",
      content,
      expectedRevision: null,
      files: [image],
    });
    expect.soft(result[0]).toBe(false);
    expect
      .soft(result[2])
      .toMatchObject({ code: "FORBIDDEN", details: { code: "UPLOADS_DISABLED" } });
    expect(staged).toHaveBeenCalledOnce();
    const files = await fs.readdir(root, { recursive: true, withFileTypes: true });
    expect(files.filter((entry) => entry.isFile() && entry.name === "pixel.png")).toEqual([]);
  });

  it("edits SKILL.md with uploads disabled while retaining exact image bytes and CAS", async () => {
    const { call, cfg } = retainedFilesHarness();
    const executable = { path: "scripts/example.sh", content: "echo example\n", executable: true };
    const created = await call("skills.library.save", {
      slug: "retained-files",
      content,
      expectedRevision: null,
      files: [image, executable],
    });
    expect(created[0]).toBe(true);
    const entry = (created[1] as SkillsLibraryReceipt).entry;
    cfg.gateway.uploads.enabled = false;
    const params = {
      skillId: entry.skillId,
      slug: entry.slug,
      expectedRevision: entry.revision,
      content: content + "Edited instructions.\n",
      retainFiles: [image.path, executable.path],
    };
    const saved = await call("skills.library.save", params);
    expect(saved[0]).toBe(true);
    const revision = (saved[1] as SkillsLibraryReceipt).entry.revision;
    expect(revision).not.toBe(entry.revision);
    const read = await call("skills.library.read", { skillId: entry.skillId });
    expect(read[0]).toBe(true);
    expect(read[1] as SkillsLibraryReadResult).toMatchObject({
      content: params.content,
      files: [image, { path: executable.path, encoding: "base64", executable: true }],
    });
    expect(Buffer.from((read[1] as SkillsLibraryReadResult).files[0]!.content, "base64")).toEqual(
      Buffer.from(image.content, "base64"),
    );
    const stale = await call("skills.library.save", params);
    expect(stale).toEqual([
      false,
      undefined,
      expect.objectContaining({
        details: { code: "SKILL_LIBRARY_CONFLICT", currentRevision: revision },
      }),
    ]);
    const upload = await call("skills.library.save", {
      ...params,
      expectedRevision: revision,
      retainFiles: [image.path],
      files: [{ ...executable, content: "echo changed\n" }],
    });
    expect(upload).toEqual([
      false,
      undefined,
      expect.objectContaining({
        details: { code: "UPLOADS_DISABLED" },
      }),
    ]);
    const unchanged = await call("skills.library.read", { skillId: entry.skillId });
    expect(unchanged[1]).toEqual(read[1]);

    cfg.gateway.uploads.enabled = true;
    const merged = await call("skills.library.save", {
      ...params,
      expectedRevision: revision,
      retainFiles: [image.path],
      files: [{ path: "notes.txt", content: "New support file" }],
    });
    expect(merged[0]).toBe(true);
    const mergedRead = await call("skills.library.read", { skillId: entry.skillId });
    expect((mergedRead[1] as SkillsLibraryReadResult).files).toEqual([
      { ...image, executable: false },
      {
        path: "notes.txt",
        content: Buffer.from("New support file").toString("base64"),
        encoding: "base64",
        executable: false,
      },
    ]);
  });

  it("rejects unbound, missing, duplicate, and excessive retained references without a write", async () => {
    const { call, cfg } = retainedFilesHarness();
    const created = await call("skills.library.save", {
      slug: "retained-files",
      content,
      expectedRevision: null,
      files: [image],
    });
    expect(created[0]).toBe(true);
    const entry = (created[1] as SkillsLibraryReceipt).entry;
    const params = {
      skillId: entry.skillId,
      slug: entry.slug,
      expectedRevision: entry.revision,
      content,
      retainFiles: [image.path],
    };
    cfg.gateway.uploads.enabled = false;
    for (const invalid of [
      { slug: entry.slug, content, expectedRevision: entry.revision, retainFiles: [image.path] },
      { ...params, expectedRevision: null },
      { ...params, retainFiles: ["missing.png"] },
      { ...params, retainFiles: ["SKILL.md"] },
      { ...params, retainFiles: [image.path, image.path] },
    ]) {
      expect(await call("skills.library.save", invalid)).toEqual([
        false,
        undefined,
        expect.objectContaining({
          details: { code: "SKILL_LIBRARY_INVALID_BUNDLE" },
        }),
      ]);
    }
    const excessive = await call("skills.library.save", {
      ...params,
      retainFiles: Array.from({ length: 256 }, (_, index) => `file-${index}`),
    });
    expect(excessive[0]).toBe(false);
    expect(excessive[2]?.code).toBe("INVALID_REQUEST");
    cfg.gateway.uploads.enabled = true;
    const overlap = await call("skills.library.save", { ...params, files: [image] });
    expect(overlap).toEqual([
      false,
      undefined,
      expect.objectContaining({
        details: { code: "SKILL_LIBRARY_INVALID_BUNDLE" },
      }),
    ]);
    const read = await call("skills.library.read", { skillId: entry.skillId });
    expect((read[1] as SkillsLibraryReadResult).entry.revision).toBe(entry.revision);
  });

  it("never retains another profile's private files or grants a shared reader write access", async () => {
    const { alice, bob, actor, cfg, call } = retainedFilesHarness();
    const saved = await saveSkillLibrary(actor(alice.id), {
      slug: "alice-files",
      content,
      expectedRevision: null,
      files: [image],
    });
    cfg.gateway.uploads.enabled = false;
    const params = {
      skillId: saved.entry.skillId,
      slug: saved.entry.slug,
      expectedRevision: saved.entry.revision,
      content: content + "Unauthorized edit.\n",
      retainFiles: [image.path],
    };
    expect(await call("skills.library.save", params, bob.id)).toEqual([
      false,
      undefined,
      expect.objectContaining({
        details: { code: "SKILL_LIBRARY_NOT_FOUND" },
      }),
    ]);
    await mutateSkillLibrary(actor(alice.id), {
      skillId: saved.entry.skillId,
      expectedRevision: saved.entry.revision,
      action: "share",
    });
    expect(await call("skills.library.save", params, bob.id)).toEqual([
      false,
      undefined,
      expect.objectContaining({
        details: { code: "SKILL_LIBRARY_FORBIDDEN" },
      }),
    ]);
    const read = await call("skills.library.read", { skillId: saved.entry.skillId });
    expect((read[1] as SkillsLibraryReadResult).content).toBe(content);
    expect((read[1] as SkillsLibraryReadResult).entry.revision).toBe(saved.entry.revision);
  });
});

describe("read-only session skill library projection", () => {
  it("exposes exact private pins to a shared-session reader without granting library access or changing selections", async () => {
    const root = temps.make();
    currentStateDir = root;
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const alice = ensureProfileForEmail("alice@example.test");
    const bob = ensureProfileForEmail("bob@example.test");
    const cfg = { agents: { entries: { main: { workspace: path.join(root, "workspace") } } } };
    const actor = (profileId: string): SkillLibraryAuthority => ({
      profileId,
      scopes: ["operator.read", "operator.write"],
      getConfig: () => cfg,
      assertCurrent: () => {},
    });
    const saved = await saveSkillLibrary(actor(alice.id), {
      slug: "alice-procedure",
      content,
      expectedRevision: null,
    });
    const bobSkill = await saveSkillLibrary(actor(bob.id), {
      slug: "bob-procedure",
      content,
      expectedRevision: null,
    });
    const pins = await seedSkillLibrarySelection(actor(alice.id));
    const key = "agent:main:library-session";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: key },
      {
        sessionId: "library-session",
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: alice.id },
        skillLibrarySelections: pins,
      },
    );
    const newer = await saveSkillLibrary(actor(alice.id), {
      skillId: saved.entry.skillId,
      slug: "alice-procedure",
      content: content + "New instructions.\n",
      expectedRevision: saved.entry.revision,
    });
    const call = async (method: string, params: Record<string, unknown>) => {
      const respond = vi.fn();
      await skillsLibraryHandlers[method]!({
        params,
        req: { type: "req", id: "test", method, params },
        client: {
          authenticatedUserProfile: { profileId: bob.id },
          connect: { scopes: ["operator.read", "operator.write"] },
        },
        context: { getRuntimeConfig: () => cfg },
        respond,
      } as unknown as GatewayRequestHandlerOptions);
      return respond.mock.calls[0]!;
    };
    const listed = await call("skills.library.list", { sessionKey: key });
    expect(listed[0]).toBe(true);
    const projection = listed[1] as SkillsLibraryListResult;
    expect(projection.entries.map((entry) => entry.skillId)).toEqual([bobSkill.entry.skillId]);
    expect(projection.session?.selections).toMatchObject([
      {
        skillId: saved.entry.skillId,
        revision: saved.entry.revision,
        slug: "alice-procedure",
        ownerLabel: alice.displayName ?? alice.id,
      },
    ]);
    expect(projection.session?.attachable.map((entry) => entry.skillId)).toEqual([
      bobSkill.entry.skillId,
    ]);
    expect(loadSessionEntry({ agentId: "main", sessionKey: key })?.skillLibrarySelections).toEqual(
      pins,
    );
    expect((await call("skills.library.read", { skillId: saved.entry.skillId }))[0]).toBe(false);
    expect(
      (
        await call("skills.library.read", {
          sessionKey: key,
          skillId: saved.entry.skillId,
          revision: newer.entry.revision,
        })
      )[0],
    ).toBe(false);
    const read = await call("skills.library.read", {
      sessionKey: key,
      skillId: saved.entry.skillId,
      revision: saved.entry.revision,
    });
    expect(read[0]).toBe(true);
    expect(read[1] as SkillsLibraryReadResult).toMatchObject({
      content,
      revisions: [{ revision: saved.entry.revision }],
      entry: { canEdit: false },
    });
    expect((read[1] as SkillsLibraryReadResult).revisions).toHaveLength(1);
    await patchSessionEntryCore({ agentId: "main", sessionKey: key }, () => ({
      visibility: "draft",
    }));
    expect((await call("skills.library.list", { sessionKey: key }))[0]).toBe(false);
  });
});
