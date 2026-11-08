import path from "node:path";
import { constants } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { bindAgentToolExecutionLocation } from "../agents/agent-tool-metadata.js";
import { buildSystemPromptToolingSection } from "../agents/system-prompt-tool-list.js";
import { createStubTool } from "../agents/test-helpers/agent-tool-stubs.js";
import { registerHeadlessToolSearchCatalog } from "../agents/tool-search-catalog.js";
import { buildToolSchemaDirectoryPrompt } from "../agents/tool-search-directory.js";
import type { ToolSearchCatalogRef } from "../agents/tool-search-types.js";
import { createToolSurfacePresentationForTest } from "../agents/tool-surface-plan.test-support.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createSkillLibraryTool } from "../agents/tools/skill-library-tool.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-admitted-read.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { listSkillLibrary, readSkillLibrary, saveSkillLibrary } from "../skills/library/service.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import type { OperatorScope } from "./operator-scopes.js";
import {
  libraryAuthority,
  type SkillLibraryRequestOwner,
} from "./server-methods/skills-library.js";
import {
  invalidateSkillAuthoringForOtherRequester,
  prepareGatewaySkillAuthoring,
  prepareGatewaySkillLibraryTurn,
  resolveGatewaySkillLibraryPromptGrant,
} from "./skill-library-authoring.js";
import { createWorkerConnectionIdentity } from "./worker-environments/connection-identity.test-support.js";

const catalogReleases: Array<() => void> = [];
const temps = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const release of catalogReleases.splice(0)) {
      release();
    }
    await closeStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
const content =
  "---\nname: ordinary\ndescription: An ordinary personal procedure\n---\n# Ordinary\nUse this procedure when asked.\n";
const sessionKey = "agent:main:shared";
const role = (scope: OperatorScope) => ({
  scopes: [scope],
  agents: "*" as const,
  sessions: { others: "view" as const },
});
const roles = (name: string, scope: OperatorScope) => ({
  gateway: {
    roles: {
      default: name,
      definitions: {
        [name]: role(scope),
        reader: role("operator.read"),
      },
    },
  },
});
const textResult = (
  result: Awaited<ReturnType<ReturnType<typeof createSkillLibraryTool>["execute"]>>,
) => JSON.parse(result.content.find((block) => block.type === "text")!.text!);
async function setup() {
  vi.stubEnv("OPENCLAW_STATE_DIR", temps.make("personal-authoring-"));
  const alice = ensureProfileForEmail("alice@example.test");
  const bob = ensureProfileForEmail("bob@example.test");
  catalogReleases.push((await prepareUserProfileCatalog()).release);
  const request = (profileId: string): SkillLibraryRequestOwner => ({
    client: {
      authenticatedUserProfile: { profileId },
      connect: { scopes: ["operator.read", "operator.write"] },
    } as SkillLibraryRequestOwner["client"],
    context: { getRuntimeConfig: () => ({}) } as SkillLibraryRequestOwner["context"],
  });
  return { alice, bob, request };
}
const authoring = async (owner: SkillLibraryRequestOwner) =>
  (await prepareGatewaySkillAuthoring(owner, sessionKey, true))!;
const prepareTurn = (owner: SkillLibraryRequestOwner, prepare = async () => {}) =>
  prepareGatewaySkillLibraryTurn({ owner, sessionKey, isHumanTurn: true }, prepare, () => {});
async function admitted(
  capability: NonNullable<Awaited<ReturnType<typeof prepareGatewaySkillAuthoring>>>,
  runId = "ordinary-turn",
) {
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "test");
  const context = await admission.admit("embedded");
  capability.bind(context);
  const withCaller = <T>(call: () => T) =>
    withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey,
        operationalRunInstance: context.operationalRunInstance,
        receiptAuthority: () => true,
      },
      call,
    );
  return {
    close: admission.close,
    [Symbol.dispose]: admission.close,
    invoke: (input: Parameters<typeof capability.invoke>[0]) =>
      withCaller(() => capability.invoke(input)),
    assertWorkspaceCurrent: () => withCaller(() => capability.assertWorkspaceCurrent?.()),
    execute: (tool: ReturnType<typeof createSkillLibraryTool>, input: unknown) =>
      withCaller(() => tool.execute("test", input)),
    context,
  };
}

describe("human personal namespace authority", () => {
  it("checks workspace authority from committed profile facts without a main-thread read", async () => {
    const { alice, request } = await setup();
    const owner = request(alice.id);
    owner.client!.connect.scopes = ["operator.admin"];
    owner.context.getRuntimeConfig = () => roles("administrator", "operator.admin");
    const run = await admitted(await authoring(owner));
    const db = requireNativeSqliteDatabase(openOpenClawStateDatabase().db);
    try {
      db.setAuthorizer(() => constants.SQLITE_DENY);
      await expect(run.assertWorkspaceCurrent()).resolves.toBeUndefined();
      db.setAuthorizer(null);
      setUserProfileRole(alice.id, "reader");
      db.setAuthorizer(() => constants.SQLITE_DENY);
      await expect(run.assertWorkspaceCurrent()).rejects.toThrow("current administrator authority");
    } finally {
      db.setAuthorizer(null);
      run.close();
    }
  });

  it("returns the actual slug and personal namespace edit permissions while retaining operator administration", async () => {
    const { alice, bob, request } = await setup();
    const owner = request(alice.id);
    owner.client!.connect.scopes = ["operator.admin"];
    const other = await saveSkillLibrary(libraryAuthority(request(bob.id)), {
      slug: "bobs-slug",
      content,
      expectedRevision: null,
    });
    const capability = (await prepareTurn(owner))!;
    using run = await admitted(capability);
    const tool = createSkillLibraryTool(capability);
    const read = textResult(
      await run.execute(tool, { action: "read", skill_id: other.entry.skillId }),
    );
    expect(read).toMatchObject({ slug: "bobs-slug", name: other.entry.name, canEdit: false });
    await expect(
      run.invoke({
        action: "update",
        skillId: other.entry.skillId,
        expectedRevision: other.entry.revision,
        content: content + "Unauthorized edit.\n",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await listSkillLibrary(libraryAuthority(owner))).entries[0]?.canEdit).toBe(true);
    expect(await run.invoke({ action: "list" })).toMatchObject({
      entries: [expect.objectContaining({ skillId: other.entry.skillId, canEdit: false })],
    });
    const created = await run.invoke({ action: "create", slug: "my-slug", content });
    if (!("entry" in created)) {
      throw new Error("Expected receipt");
    }
    expect(await run.invoke({ action: "read", skillId: created.entry.skillId })).toMatchObject({
      entry: { slug: "my-slug", canEdit: true },
    });
    await run.invoke({
      action: "transfer",
      skillId: created.entry.skillId,
      expectedRevision: created.entry.revision,
    });
    expect(await run.invoke({ action: "read", skillId: created.entry.skillId })).toMatchObject({
      entry: { ownerProfileId: null, canEdit: false },
    });
    await expect(
      run.invoke({
        action: "update",
        skillId: created.entry.skillId,
        expectedRevision: created.entry.revision,
        content: content + "Team edit.\n",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("authors for the real requester inside another person's session and rejects a retained tool after close", async () => {
    const { bob, request } = await setup();
    const owner = request(bob.id);
    const capability = await authoring(owner);
    using run = await admitted(capability);
    const created = await run.invoke({ action: "create", slug: "ordinary", content });
    expect(created).toMatchObject({
      state: "published",
      target: "personal",
      entry: { ownerProfileId: bob.id },
      sessionActivation: "new-sessions",
    });
    expect((await listSkillLibrary(libraryAuthority(owner))).entries).toHaveLength(1);
    run.close();
    await expect(
      run.invoke({ action: "create", slug: "after-close", content }),
    ).rejects.toMatchObject({ code: "AUTHORITY_EXPIRED" });
  });
  it("requires admission, refuses synthetic authority, and invalidates a mixed-person steer", async () => {
    const { alice, bob, request } = await setup();
    const owner = request(alice.id);
    expect(await prepareGatewaySkillAuthoring(owner, "agent:main:shared", false)).toBeUndefined();
    expect(
      await prepareGatewaySkillAuthoring(
        { ...owner, client: { ...owner.client!, internal: { syntheticClient: true } } },
        "agent:main:shared",
        true,
      ),
    ).toBeUndefined();
    const capability = await authoring(owner);
    await expect(capability.invoke({ action: "list" })).rejects.toMatchObject({
      code: "AUTHORITY_EXPIRED",
    });
    using run = await admitted(capability);
    const alias = ensureProfileForEmail("alice-alias@example.test");
    linkEmail("alice-alias@example.test", alice.id);
    invalidateSkillAuthoringForOtherRequester("agent:main:shared", alias.id);
    await expect(run.invoke({ action: "list" })).resolves.toMatchObject({ entries: [] });
    invalidateSkillAuthoringForOtherRequester("agent:main:shared", bob.id);
    await expect(run.invoke({ action: "create", slug: "ambiguous", content })).rejects.toThrow(
      "fresh attributed",
    );
    expect((await listSkillLibrary(libraryAuthority(owner))).entries).toHaveLength(0);
  });
  it.each(["profile", "scopes"] as const)(
    "refuses a prepared session after replacing requester %s",
    async (change) => {
      const { alice, bob, request } = await setup();
      const owner = request(alice.id);
      await expect(
        prepareTurn(owner, async () => {
          if (change === "profile") {
            owner.client!.authenticatedUserProfile = {
              profileId: bob.id,
              displayName: null,
              hasAvatar: false,
              updatedAt: 1,
            };
          } else {
            owner.client!.connect.scopes = ["operator.read"];
          }
        }),
      ).rejects.toMatchObject({ code: "AUTHORITY_EXPIRED" });
    },
  );
  it("enforces current roles after session preparation and at publication after staging", async () => {
    const { alice, request } = await setup();
    const owner = request(alice.id);
    owner.context.getRuntimeConfig = () => roles("writer", "operator.write");
    await expect(
      prepareTurn(owner, async () => {
        setUserProfileRole(alice.id, "reader");
      }),
    ).rejects.toMatchObject({ code: "AUTHORITY_EXPIRED" });
    setUserProfileRole(alice.id, "writer");
    using run = await admitted(await authoring(owner));
    const saving = run.invoke({ action: "create", slug: "revoked", content });
    setUserProfileRole(alice.id, "reader");
    await expect(saving).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await listSkillLibrary(libraryAuthority(owner))).entries).toHaveLength(0);
  });
});

it("serves the worker skill library through the same Gateway capability and rejects a lost turn claim", async () => {
  const { alice, request } = await setup();
  const capability = await authoring(request(alice.id));
  const run = await admitted(capability, "worker-personal-turn");
  const { createWorkerGatewayToolRuntime } =
    await import("./worker-environments/worker-gateway-tool-runtime.js");
  const { createWorkerWorkshopCallRetention } =
    await import("./worker-environments/worker-session-tool-executor.js");
  const { createWorkerGatewayToolProxies } = await import("../worker/worker-gateway-tools.js");
  const claim = {
    sessionId: "shared",
    runId: "worker-personal-turn",
    claimId: "claim",
    placementGeneration: 1,
    owner: { kind: "worker" as const, environmentId: "environment", ownerEpoch: 1 },
  };
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("claim lost");
    }
  };
  const hostTool = createSkillLibraryTool({
    ...capability,
    invoke: (input) =>
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:shared",
          operationalRunInstance: run.context.operationalRunInstance,
          receiptAuthority: () => {
            assertCurrent();
            return true;
          },
          workerTurnClaim: claim,
        },
        () => capability.invoke(input),
      ),
  });
  const retainCall = createWorkerWorkshopCallRetention();
  const retainedTool: AnyAgentTool = {
    ...hostTool,
    execute: (id, args, signal, onUpdate) =>
      retainCall(id, args, () => hostTool.execute(id, args, signal, onUpdate)),
  };
  bindAgentToolExecutionLocation(retainedTool, { kind: "gateway" });
  const runtime = createWorkerGatewayToolRuntime({
    assertCurrent,
    signal: new AbortController().signal,
    prepare: async () => ({
      tools: [retainedTool],
      presentation: createToolSurfacePresentationForTest(),
      policy: {
        workspaceOnly: true,
        readOnly: false,
        applyPatchEnabled: false,
        applyPatchWorkspaceOnly: true,
        imageSanitization: {},
      },
    }),
  });
  const identity = createWorkerConnectionIdentity(claim, {
    credentialHash: "synthetic",
    credentialExpiresAtMs: 1,
  });
  const proxy = createWorkerGatewayToolProxies(await runtime.getSurface(identity), {
    invokeGatewayTool: async (input, options) => ({
      type: "res",
      id: "test",
      ok: true,
      payload: await runtime.invoke(identity, input, {
        send: (frame) => options?.onUpdate?.(frame.payload.result),
      }),
    }),
    cancelGatewayTool: async (input) => ({
      type: "res",
      id: "test",
      ok: true,
      payload: runtime.cancel(input),
    }),
  })[0]!;
  try {
    const files = [
      { path: "scripts/edit.sh", content: "#!/bin/sh\nprintf original", executable: true },
      { path: "scripts/keep.sh", content: "#!/bin/sh\nprintf preserved", executable: true },
      { path: "data.bin", content: "AP+A", encoding: "base64" as const },
    ];
    const create = () => ({
      action: "create",
      name: "worker-created",
      proposal_content: content,
      files,
    });
    const result = await proxy.execute("create-1", create());
    expect(JSON.stringify(result)).toContain(alice.id);
    expect((await listSkillLibrary(libraryAuthority(request(alice.id)))).entries).toHaveLength(1);
    expect(await proxy.execute("create-1", create())).toEqual(result);
    const entry = (await listSkillLibrary(libraryAuthority(request(alice.id)))).entries[0]!;
    const read = async (artifact_path: string) =>
      textResult(
        await proxy.execute(artifact_path, {
          action: "read",
          skill_id: entry.skillId,
          artifact_path,
        }),
      );
    const update = (id: string, revision: string, patch: Record<string, unknown>) =>
      proxy.execute(id, {
        action: "update",
        skill_id: entry.skillId,
        expected_revision: revision,
        ...patch,
      });
    expect(await read("scripts/edit.sh")).toMatchObject({
      slug: "worker-created",
      artifactPath: "scripts/edit.sh",
      content: "#!/bin/sh\nprintf original",
      contentIncluded: true,
    });
    await update("edit-helper", entry.revision, {
      files: [{ path: "scripts/edit.sh", content: "#!/bin/sh\nprintf changed" }],
    });
    const edited = await readSkillLibrary(libraryAuthority(request(alice.id)), entry.skillId);
    expect(edited.content).toBe(content);
    expect(edited.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining(files[2]),
        expect.objectContaining({ ...files[1], encoding: "utf8" }),
        expect.objectContaining({
          ...files[0],
          content: "#!/bin/sh\nprintf changed",
          encoding: "utf8",
        }),
      ]),
    );
    expect(
      await update("stale-edit", entry.revision, {
        files: [{ path: "scripts/edit.sh", content: "stale" }],
      }),
    ).toMatchObject({ details: { status: "error" } });
    for (const [index, patch] of [
      { files: [{ path: "SKILL.md", content: "wrong channel" }] },
      {
        files: [
          { path: "a", content: "one" },
          { path: "A", content: "two" },
        ],
      },
      {
        files: [{ path: "scripts/edit.sh", content: "conflict" }],
        delete_files: ["scripts/edit.sh"],
      },
      { delete_files: ["../escape"] },
    ].entries()) {
      expect(await update(`invalid-${index}`, edited.entry.revision, patch)).toMatchObject({
        details: { status: "error" },
      });
    }
    await update("delete-helper", edited.entry.revision, {
      delete_files: ["scripts/keep.sh"],
    });
    const removed = await readSkillLibrary(libraryAuthority(request(alice.id)), entry.skillId);
    expect(removed.files.map((file) => file.path)).toEqual(["data.bin", "scripts/edit.sh"]);
    const unchanged = await update("empty-upserts", removed.entry.revision, {
      files: [],
    });
    expect(textResult(unchanged)).toMatchObject({ state: "unchanged" });
    current = false;
    await expect(
      proxy.execute("create-2", {
        action: "create",
        name: "lost-claim",
        proposal_content: content,
      }),
    ).rejects.toThrow("claim lost");
  } finally {
    await runtime.close();
    run.close();
  }
});

it("keeps the skill_library prompt across settle and refuses that turn at execution", async () => {
  const { alice, request } = await setup();
  const owner = request(alice.id);
  const settleSessionKey = "agent:main:skill-library-settle";
  const storePath = path.join(temps.make("skill-library-settle-"), "sessions.sqlite");
  const listingStore = { agentId: "main", storePath };
  await replaceSessionEntry(
    { agentId: "main", sessionKey: settleSessionKey, storePath },
    { sessionId: "skill-library-settle", updatedAt: 1 },
  );
  const grant = async (isHumanTurn: boolean) =>
    (await resolveGatewaySkillLibraryPromptGrant({
      owner,
      sessionKey: settleSessionKey,
      isHumanTurn,
      listingStore,
    }))!;
  const human = await grant(true);
  const settle = await grant(false);
  const nextHuman = await grant(true);
  const toolFor = (capability: NonNullable<Awaited<ReturnType<typeof grant>>>) =>
    createSkillLibraryTool(capability);
  const surface = (tool: ReturnType<typeof createSkillLibraryTool>) => {
    const catalogRef: ToolSearchCatalogRef = {};
    registerHeadlessToolSearchCatalog({
      catalogRef,
      tools: [createStubTool("tool_search"), tool],
    });
    const directory = buildToolSchemaDirectoryPrompt({ catalogRef });
    return {
      directory,
      section: buildSystemPromptToolingSection({
        includeToolGuidance: true,
        toolLines: ["- tool_search", "- skill_library"],
        toolSchemaDirectoryPrompt: directory,
        promptSurface: "openclaw_main",
        availableTools: new Set(["tool_search", "skill_library"]),
      }).join("\n"),
    };
  };
  const humanTool = toolFor(human);
  const settleTool = toolFor(settle);
  const humanSurface = surface(humanTool);
  expect(settleTool.description).toBe(humanTool.description);
  expect(settleTool.parameters).toEqual(humanTool.parameters);
  expect(toolFor(nextHuman).description).toBe(humanTool.description);
  expect(surface(settleTool)).toEqual(humanSurface);
  expect(surface(toolFor(nextHuman))).toEqual(humanSurface);
  expect(humanSurface.directory).toContain("- skill_library (core)");
  expect(humanSurface.section).toContain(
    "Author skills in the requesting person's personal library",
  );
  const refused = await settleTool.execute("settle-list", { action: "list" });
  expect(refused.details).toMatchObject({ gated: true });
  expect(refused.content).toContainEqual(
    expect.objectContaining({ type: "text", text: expect.stringContaining("no human requester") }),
  );
  await expect(settle.invoke({ action: "list" })).rejects.toMatchObject({
    code: "AUTHORITY_EXPIRED",
  });
  expect((await listSkillLibrary(libraryAuthority(owner))).entries).toHaveLength(0);
  expect(
    await resolveGatewaySkillLibraryPromptGrant({
      owner,
      sessionKey: "agent:main:skill-library-settle-unlisted",
      isHumanTurn: false,
    }),
  ).toBeUndefined();
  const synthetic = await resolveGatewaySkillLibraryPromptGrant({
    owner: {
      ...owner,
      client: { ...owner.client!, internal: { syntheticClient: true } },
    },
    sessionKey: settleSessionKey,
    isHumanTurn: true,
    sessionEntry: Object.freeze({ skillLibraryPromptListing: undefined }),
    listingStore,
  });
  expect(toolFor(synthetic!).description).toBe(humanTool.description);
  expect(synthetic?.turnRefusal).toContain("no human requester");
});
it("reloads a recorded skill_library listing for a settle after restart", async () => {
  const { alice, request } = await setup();
  const owner = request(alice.id);
  const listingSessionKey = "agent:main:skill-library-listing";
  const storePath = path.join(temps.make("skill-library-listing-"), "sessions.sqlite");
  await replaceSessionEntry(
    { agentId: "main", sessionKey: listingSessionKey, storePath },
    { sessionId: "skill-library-listing", updatedAt: 1 },
  );
  const live = await resolveGatewaySkillLibraryPromptGrant({
    owner,
    sessionKey: listingSessionKey,
    isHumanTurn: true,
    listingStore: { agentId: "main", storePath },
  });
  const saved = loadSessionEntry({ agentId: "main", sessionKey: listingSessionKey, storePath });
  expect(saved?.skillLibraryPromptListing).toEqual({
    multipleProfiles: live?.multipleProfiles,
    defaultTarget: live?.defaultTarget,
  });
  const restarted = await resolveGatewaySkillLibraryPromptGrant({
    owner,
    sessionKey: "agent:main:skill-library-listing-restart",
    isHumanTurn: false,
    storedListing: saved?.skillLibraryPromptListing,
  });
  expect(createSkillLibraryTool(restarted!).description).toBe(
    createSkillLibraryTool(live!).description,
  );
  expect(restarted?.turnRefusal).toContain("no human requester");
  const frozen = Object.freeze({ skillLibraryPromptListing: undefined });
  const frozenGrant = await resolveGatewaySkillLibraryPromptGrant({
    owner,
    sessionKey: "agent:main:skill-library-frozen",
    isHumanTurn: true,
    sessionEntry: frozen,
  });
  expect(createSkillLibraryTool(frozenGrant!).description).toBe(
    createSkillLibraryTool(live!).description,
  );
  expect(frozen.skillLibraryPromptListing).toBeUndefined();
  const borrowedKey = "agent:main:skill-library-borrowed";
  await replaceSessionEntry(
    { agentId: "main", sessionKey: borrowedKey, storePath },
    { sessionId: "skill-library-borrowed", updatedAt: 1 },
  );
  const borrowed: { skillLibraryPromptListing?: undefined } = {};
  const borrowedGrant = await resolveGatewaySkillLibraryPromptGrant({
    owner,
    sessionKey: borrowedKey,
    isHumanTurn: true,
    sessionEntry: borrowed,
    listingStore: { agentId: "main", storePath },
  });
  expect(borrowed.skillLibraryPromptListing).toBeUndefined();
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: borrowedKey, storePath })
      ?.skillLibraryPromptListing,
  ).toEqual({
    multipleProfiles: borrowedGrant?.multipleProfiles,
    defaultTarget: borrowedGrant?.defaultTarget,
  });
  const otherPath = path.join(temps.make("skill-library-other-store-"), "sessions.sqlite");
  const otherKey = listingSessionKey;
  await replaceSessionEntry(
    { agentId: "main", sessionKey: otherKey, storePath: otherPath },
    { sessionId: "skill-library-other-store", updatedAt: 1 },
  );
  expect(
    await resolveGatewaySkillLibraryPromptGrant({
      owner,
      sessionKey: otherKey,
      isHumanTurn: false,
      listingStore: { agentId: "main", storePath: otherPath },
    }),
  ).toBeUndefined();
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: otherKey, storePath: otherPath })
      ?.skillLibraryPromptListing,
  ).toBeUndefined();
});
