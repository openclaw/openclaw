import { constants } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { bindAgentToolExecutionLocation } from "../agents/agent-tool-metadata.js";
import { createToolSurfacePresentationForTest } from "../agents/tool-surface-plan.test-support.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createLibrarySkillWorkshopTool } from "../agents/tools/skill-workshop-tool-library.js";
import { listSkillLibrary, readSkillLibrary, saveSkillLibrary } from "../skills/library/service.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  libraryAuthority,
  type SkillLibraryRequestOwner,
} from "./server-methods/skills-library.js";
import {
  invalidateSkillAuthoringForOtherRequester,
  prepareGatewaySkillAuthoring,
  prepareGatewaySkillLibraryTurn,
} from "./skill-library-authoring.js";

const releases: Array<() => void> = [];
const temps = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const release of releases.splice(0).toReversed()) {
      release();
    }
    await closeStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
const content =
  "---\nname: ordinary\ndescription: An ordinary personal procedure\n---\n# Ordinary\nUse this procedure when asked.\n";
const readResult = (result: Awaited<ReturnType<AnyAgentTool["execute"]>>) =>
  JSON.parse(result.content.find((block) => block.type === "text")!.text!);
const file = (path: string, text: string) => ({ path, content: text });
const expired = { code: "AUTHORITY_EXPIRED" };
const forbidden = { code: "FORBIDDEN" };
const sessionKey = "agent:main:shared";
const prepare = (owner: SkillLibraryRequestOwner, isHumanTurn = true) =>
  prepareGatewaySkillAuthoring(owner, sessionKey, isHumanTurn);
const prepareTurn = (
  owner: SkillLibraryRequestOwner,
  before: () => Promise<void> = async () => {},
) => prepareGatewaySkillLibraryTurn({ owner, sessionKey, isHumanTurn: true }, before, () => {});
async function setup(requester: "alice" | "bob" = "alice") {
  vi.stubEnv("OPENCLAW_STATE_DIR", temps.make("personal-authoring-"));
  const alice = ensureProfileForEmail("alice@example.test");
  const bob = ensureProfileForEmail("bob@example.test");
  releases.push((await prepareUserProfileCatalog()).release);
  const request = (profileId: string): SkillLibraryRequestOwner => ({
    client: {
      authenticatedUserProfile: { profileId },
      connect: { scopes: ["operator.read", "operator.write"] },
    } as SkillLibraryRequestOwner["client"],
    context: { getRuntimeConfig: () => ({}) } as SkillLibraryRequestOwner["context"],
  });
  return { alice, bob, request, owner: request(requester === "alice" ? alice.id : bob.id) };
}
async function admitted(
  capability: NonNullable<Awaited<ReturnType<typeof prepareGatewaySkillAuthoring>>>,
  runId = "ordinary-turn",
  authority: Partial<Parameters<typeof withGatewayToolCallerIdentity>[0]> = {},
) {
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "test");
  releases.push(admission.close);
  const context = await admission.admit("embedded");
  capability.bind(context);
  const withCaller = <T>(call: () => T) =>
    withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey,
        operationalRunInstance: context.operationalRunInstance,
        receiptAuthority: () => true,
        ...authority,
      },
      call,
    );
  const invoke = (input: Parameters<typeof capability.invoke>[0]) =>
    withCaller(() => capability.invoke(input));
  return {
    close: admission.close,
    invoke,
    create: (slug: string) => invoke({ action: "create", slug, content }),
    update: (entry: { skillId: string; revision: string }, suffix: string) =>
      invoke({
        action: "update",
        skillId: entry.skillId,
        expectedRevision: entry.revision,
        content: content + suffix,
      }),
    assertWorkspaceCurrent: () => withCaller(() => capability.assertWorkspaceCurrent?.()),
    execute: (tool: ReturnType<typeof createLibrarySkillWorkshopTool>, input: unknown) =>
      withCaller(() => tool.execute("test", input)),
  };
}

function configureRoles(owner: SkillLibraryRequestOwner, role: "administrator" | "writer") {
  const definition = (scope: string) => ({
    scopes: [scope],
    agents: "*" as const,
    sessions: { others: "view" as const },
  });
  const definitions = {
    [role]: definition(role === "administrator" ? "operator.admin" : "operator.write"),
    reader: definition("operator.read"),
  };
  owner.context.getRuntimeConfig = () => ({ gateway: { roles: { default: role, definitions } } });
}

describe("human personal namespace authority", () => {
  it("checks workspace authority from committed profile facts without a main-thread read", async () => {
    const { alice, owner } = await setup();
    owner.client!.connect.scopes = ["operator.admin"];
    configureRoles(owner, "administrator");
    const run = await admitted((await prepare(owner))!);
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
    }
  });

  it("returns the actual slug and personal namespace edit permissions while retaining operator administration", async () => {
    const { bob, request, owner } = await setup();
    owner.client!.connect.scopes = ["operator.admin"];
    const other = await saveSkillLibrary(libraryAuthority(request(bob.id)), {
      slug: "bobs-slug",
      content,
      expectedRevision: null,
    });
    const capability = (await prepareTurn(owner))!;
    const run = await admitted(capability);
    const tool = createLibrarySkillWorkshopTool(capability);
    const read = readResult(
      await run.execute(tool, { action: "read", skill_id: other.entry.skillId }),
    );
    expect(read).toMatchObject({ slug: "bobs-slug", name: other.entry.name, canEdit: false });
    await expect(run.update(other.entry, "Unauthorized edit.\n")).rejects.toMatchObject(forbidden);
    expect((await listSkillLibrary(libraryAuthority(owner))).entries[0]?.canEdit).toBe(true);
    expect(await run.invoke({ action: "list" })).toMatchObject({
      entries: [expect.objectContaining({ skillId: other.entry.skillId, canEdit: false })],
    });
    const created = await run.create("my-slug");
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
    await expect(run.update(created.entry, "Team edit.\n")).rejects.toMatchObject(forbidden);
  });
  it("authors for the real requester inside another person's session and rejects a retained tool after close", async () => {
    const { bob, owner } = await setup("bob");
    const capability = (await prepare(owner))!;
    const run = await admitted(capability);
    const created = await run.create("ordinary");
    expect(created).toMatchObject({
      state: "published",
      target: "personal",
      entry: { ownerProfileId: bob.id },
      sessionActivation: "new-sessions",
    });
    expect((await listSkillLibrary(libraryAuthority(owner))).entries).toHaveLength(1);
    run.close();
    await expect(run.create("after-close")).rejects.toMatchObject(expired);
  });
  it("requires admission, refuses synthetic authority, and invalidates a mixed-person steer", async () => {
    const { alice, bob, owner } = await setup();
    expect(await prepare(owner, false)).toBeUndefined();
    expect(
      await prepare({
        ...owner,
        client: { ...owner.client!, internal: { syntheticClient: true } },
      }),
    ).toBeUndefined();
    const capability = (await prepare(owner))!;
    await expect(capability.invoke({ action: "list" })).rejects.toMatchObject(expired);
    const run = await admitted(capability);
    const alias = ensureProfileForEmail("alice-alias@example.test");
    linkEmail("alice-alias@example.test", alice.id);
    invalidateSkillAuthoringForOtherRequester(sessionKey, alias.id);
    await expect(run.invoke({ action: "list" })).resolves.toMatchObject({ entries: [] });
    invalidateSkillAuthoringForOtherRequester(sessionKey, bob.id);
    await expect(run.create("ambiguous")).rejects.toThrow("fresh attributed");
    expect((await listSkillLibrary(libraryAuthority(owner))).entries).toHaveLength(0);
  });
  it.each(["profile", "scopes"] as const)(
    "refuses a prepared session after replacing requester %s",
    async (change) => {
      const { bob, owner } = await setup();
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
      ).rejects.toMatchObject(expired);
    },
  );
  it("enforces current roles after session preparation and at publication after staging", async () => {
    const { alice, owner } = await setup();
    configureRoles(owner, "writer");
    await expect(
      prepareTurn(owner, async () => {
        setUserProfileRole(alice.id, "reader");
      }),
    ).rejects.toMatchObject(expired);
    setUserProfileRole(alice.id, "writer");
    const run = await admitted((await prepare(owner))!);
    const saving = run.create("revoked");
    setUserProfileRole(alice.id, "reader");
    await expect(saving).rejects.toMatchObject(forbidden);
    expect((await listSkillLibrary(libraryAuthority(owner))).entries).toHaveLength(0);
  });
});

it("serves worker Workshop through the same Gateway capability and rejects a lost turn claim", async () => {
  const { alice, owner } = await setup();
  const authority = libraryAuthority(owner);
  const capability = (await prepare(owner))!;
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
    return true;
  };
  const run = await admitted(capability, claim.runId, {
    receiptAuthority: assertCurrent,
    workerTurnClaim: claim,
  });
  const hostTool = createLibrarySkillWorkshopTool({ ...capability, invoke: run.invoke });
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
  const identity = {
    environmentId: "environment",
    credentialHash: "synthetic",
    bundleHash: "a".repeat(64),
    sessionId: claim.sessionId,
    runId: claim.runId,
    turnClaim: claim,
    ownerEpoch: 1,
    rpcSetVersion: 1,
    protocolFeatures: [],
    credentialExpiresAtMs: 1,
  };
  const response = <T>(payload: T) => ({
    type: "res" as const,
    id: "test",
    ok: true as const,
    payload,
  });
  const proxy = createWorkerGatewayToolProxies(await runtime.getSurface(identity), {
    invokeGatewayTool: async (input, options) =>
      response(
        await runtime.invoke(identity, input, {
          send: (frame) => options?.onUpdate?.(frame.payload.result),
        }),
      ),
    cancelGatewayTool: async (input) => response(runtime.cancel(input)),
  })[0]!;
  const createInput = () => ({
    action: "create",
    name: "worker-created",
    proposal_content: content,
    files: [
      { path: "scripts/edit.sh", content: "#!/bin/sh\nprintf original", executable: true },
      { path: "scripts/keep.sh", content: "#!/bin/sh\nprintf preserved", executable: true },
      { path: "data.bin", content: "AP+A", encoding: "base64" },
    ],
  });
  try {
    const result = await proxy.execute("create-1", createInput());
    expect(JSON.stringify(result)).toContain(alice.id);
    expect((await listSkillLibrary(authority)).entries).toHaveLength(1);
    expect(await proxy.execute("create-1", createInput())).toEqual(result);
    const entry = (await listSkillLibrary(authority)).entries[0]!;
    const readArtifact = async (id: string, artifact_path: string) =>
      readResult(
        await proxy.execute(id, { action: "read", skill_id: entry.skillId, artifact_path }),
      );
    const update = (id: string, patch: Record<string, unknown>, revision = entry.revision) =>
      proxy.execute(id, {
        action: "update",
        skill_id: entry.skillId,
        expected_revision: revision,
        ...patch,
      });
    expect(await readArtifact("read-helper", "scripts/edit.sh")).toMatchObject({
      slug: "worker-created",
      artifactPath: "scripts/edit.sh",
      content: "#!/bin/sh\nprintf original",
      contentIncluded: true,
    });
    expect(await readArtifact("read-binary", "data.bin")).toMatchObject({
      contentIncluded: false,
      omissionReason: "binary",
    });
    await update("edit-helper", { files: [file("scripts/edit.sh", "#!/bin/sh\nprintf changed")] });
    const edited = await readSkillLibrary(authority, entry.skillId);
    const executable = (path: string, text: string) =>
      expect.objectContaining({
        path,
        content: Buffer.from(text).toString("base64"),
        executable: true,
      });
    expect(edited).toMatchObject({
      content,
      files: expect.arrayContaining([
        expect.objectContaining({ path: "data.bin", content: "AP+A", encoding: "base64" }),
        executable("scripts/keep.sh", "#!/bin/sh\nprintf preserved"),
        executable("scripts/edit.sh", "#!/bin/sh\nprintf changed"),
      ]),
    });
    expect(await update("stale-edit", { files: [file("scripts/edit.sh", "stale")] })).toMatchObject(
      { details: { status: "error" } },
    );
    for (const [index, patch] of [
      { files: [file("SKILL.md", "wrong channel")] },
      { files: [file("a", "one"), file("A", "two")] },
      {
        files: [file("scripts/edit.sh", "conflict")],
        delete_files: ["scripts/edit.sh"],
      },
      { delete_files: ["SKILL.md"] },
      { delete_files: ["../escape"] },
      { delete_files: ["data.bin", "data.bin"] },
    ].entries()) {
      expect(await update(`invalid-${index}`, patch, edited.entry.revision)).toMatchObject({
        details: { status: "error" },
      });
    }
    await update("delete-helper", { delete_files: ["scripts/keep.sh"] }, edited.entry.revision);
    const removed = await readSkillLibrary(authority, entry.skillId);
    expect(removed.files.map((artifact) => artifact.path)).toEqual(["data.bin", "scripts/edit.sh"]);
    const unchanged = await update("empty-upserts", { files: [] }, removed.entry.revision);
    expect(readResult(unchanged)).toMatchObject({ state: "unchanged" });
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
  }
});
