import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type {
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
  SkillsLibraryReceipt,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  upsertSessionEntryCore,
  loadSessionEntry,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { assertNoRetainedSessionSharingReads } from "../../config/sessions/session-accessor.sqlite-diagnostics.test-support.js";
import {
  addSessionMemberInWorker,
  removeSessionMemberInWorker,
} from "../../config/sessions/session-sharing-store.async.js";
import * as fsSafe from "../../infra/fs-safe.js";
import * as libraryBundle from "../../skills/library/bundle.js";
import { seedSkillLibrarySelection } from "../../skills/library/selection.js";
import { mutateSkillLibrary, saveSkillLibrary } from "../../skills/library/service.js";
import type { SkillLibraryAuthority } from "../../skills/library/store.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  cleanupSessionStateForTest,
  useSessionStoreTempDirs,
} from "../../test-utils/session-state-cleanup.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { handleGatewayRequest } from "../server-methods.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import * as sessionAuthorization from "../session-sharing-authorization-async.js";
import type { GatewayClient } from "./client-types.js";
import { skillsLibraryHandlers } from "./skills-library.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const temps = useSessionStoreTempDirs(afterAll, "library-session-projection-");
let currentStateDir: string | undefined;
afterEach(async () => {
  try {
    assertNoRetainedSessionSharingReads();
  } finally {
    if (currentStateDir) {
      await cleanupSessionStateForTest({ stateDir: currentStateDir });
      currentStateDir = undefined;
    }
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
  }
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
      authenticatedUserProfile: gatewayProfile(profileId),
      connect: gatewayConnect(["operator.read", "operator.write"], {
        id: "test",
        mode: "test",
        version: "1",
      }),
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
      files: [image, { ...executable, encoding: "utf8" }],
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
        content: "New support file",
        encoding: "utf8",
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

describe("session skill library projection and activation", () => {
  it.each(["pins", "plugin ownership"])(
    "does not disclose a selected revision after %s changes during its file read",
    async (change) => {
      const { alice, actor, cfg, call } = retainedFilesHarness();
      setRuntimeConfigSnapshot(cfg);
      const saved = await saveSkillLibrary(actor(alice.id), {
        slug: "selected-revision",
        content,
        expectedRevision: null,
      });
      const key = "agent:main:selected-revision";
      const scope = { agentId: "main", sessionKey: key };
      await upsertSessionEntryCore(scope, {
        sessionId: "selected-revision",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: alice.id },
        skillLibrarySelections: await seedSkillLibrarySelection(actor(alice.id)),
      });
      const readManifest = libraryBundle.readSkillLibraryManifestTree;
      using manifest = vi
        .spyOn(libraryBundle, "readSkillLibraryManifestTree")
        .mockImplementation(async (...args) => {
          const files = await readManifest(...args);
          await patchSessionEntryCore(scope, () =>
            change === "pins"
              ? { skillLibrarySelections: [] }
              : { pluginOwnerId: "replacement-plugin" },
          );
          return files;
        });
      const response = await call("skills.library.read", {
        sessionKey: key,
        skillId: saved.entry.skillId,
        revision: saved.entry.revision,
      });
      expect(manifest).toHaveBeenCalledOnce();
      expect(loadSessionEntry(scope)).toMatchObject(
        change === "pins"
          ? { skillLibrarySelections: [] }
          : { pluginOwnerId: "replacement-plugin" },
      );
      expect(response[0]).toBe(false);
      expect(response[1]).toBeUndefined();
    },
  );

  it.each(["success", "missing session", "invalid selection"])(
    "releases activation authorization after %s",
    async (outcome) => {
      const { alice, cfg } = retainedFilesHarness();
      setRuntimeConfigSnapshot(cfg);
      const key = "agent:main:library-activation";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        { sessionId: "library-activation", updatedAt: 1 },
      );
      const params = {
        sessionKey: outcome === "missing session" ? "agent:main:missing" : key,
        action: "detach",
        ...(outcome === "invalid selection"
          ? {}
          : { skillId: "00000000-0000-0000-0000-000000000000" }),
      };
      const resolve = sessionAuthorization.resolveSessionMutationAuthorizationAsync;
      const release = vi.fn<() => void>();
      using resolved = vi
        .spyOn(sessionAuthorization, "resolveSessionMutationAuthorizationAsync")
        .mockImplementation(async (request) => {
          const result = await resolve(request);
          if (!result.authorization?.release) {
            throw new Error("Expected a retained activation authorization");
          }
          release.mockImplementation(result.authorization.release);
          return { ...result, authorization: { ...result.authorization, release } };
        });
      try {
        const respond = vi.fn();
        await skillsLibraryHandlers["skills.library.activate"]!({
          params,
          req: { type: "req", id: "activation", method: "skills.library.activate", params },
          client: {
            authenticatedUserProfile: { profileId: alice.id },
            connect: { scopes: ["operator.read", "operator.write"] },
          },
          context: { getRuntimeConfig: () => cfg },
          respond,
        } as unknown as GatewayRequestHandlerOptions);
        expect(respond).toHaveBeenCalledWith(
          outcome === "success",
          outcome === "success" ? expect.objectContaining({ selections: [] }) : undefined,
          outcome === "success" ? undefined : expect.any(Object),
        );
        expect(resolved).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
      } finally {
        release();
      }
    },
  );

  it("exposes exact private pins only while session access remains current", async () => {
    const root = temps.make();
    currentStateDir = root;
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const alice = ensureProfileForEmail("alice@example.test");
    const bob = ensureProfileForEmail("bob@example.test");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const cfg = { agents: { entries: { main: { workspace: path.join(root, "workspace") } } } };
    setRuntimeConfigSnapshot(cfg);
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
    const executeRead = stateReads.executeExistingOpenClawStateRead;
    using reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const listed = await call("skills.library.list", { sessionKey: key, scope: "team" });
    expect(listed[0]).toBe(true);
    const projection = listed[1] as SkillsLibraryListResult;
    expect(projection.entries).toEqual([]);
    expect(
      reads.mock.calls.filter(
        ([, command]) => command.type === "skillLibrary.read" && command.input.kind === "list",
      ),
    ).toHaveLength(1);
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
    const scope = { agentId: "main", sessionKey: key };
    await patchSessionEntryCore(scope, () => ({ visibility: "read-only" }));
    await addSessionMemberInWorker(scope, { identityId: bob.id, addedBy: alice.id });
    await saveSkillLibrary(actor(bob.id), {
      skillId: bobSkill.entry.skillId,
      slug: bobSkill.entry.slug,
      content: content + "Updated instructions.\n",
      expectedRevision: bobSkill.entry.revision,
    });
    let revoked = false;
    reads.mockImplementation(async (...args) => {
      const result = await executeRead(...args);
      const [, command] = args;
      if (command.type === "skillLibrary.read" && command.input.kind === "pins") {
        await removeSessionMemberInWorker(scope, bob.id);
        revoked = true;
      }
      return result;
    });
    const revokedList = await call("skills.library.list", { sessionKey: key });
    expect(revoked).toBe(true);
    expect(revokedList[0]).toBe(false);
    expect(revokedList[1]).toBeUndefined();
    expect(revokedList[2]).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
    const missingPin = await call("skills.library.read", {
      sessionKey: key,
      skillId: saved.entry.skillId,
      revision: newer.entry.revision,
    });
    expect(missingPin[2]).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
    await patchSessionEntryCore({ agentId: "main", sessionKey: key }, () => ({
      visibility: "draft",
    }));
    expect((await call("skills.library.list", { sessionKey: key }))[0]).toBe(false);
  });
});
