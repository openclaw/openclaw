import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOpenClawPluginToolsForOptions } from "../agents/openclaw-plugin-tools.js";
import { finalizeOpenClawTools } from "../agents/openclaw-tools.finalize.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import {
  disposePluginRegistryInstances,
  resetPluginRuntimeStateForTest,
} from "../plugins/runtime.js";
import { closeSkillsWatchers } from "../skills/runtime/refresh.js";
import { workshopPluginConfig } from "../skills/test-support/workshop-config.test-support.js";
import { shareCoreWithWorkshopPluginForTest } from "../skills/test-support/workshop-plugin.test-support.js";
import { historicalWorkshopChangesSchema } from "../skills/test-support/workshop-schema.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";

const skill =
  "---\nname: deploy-notes\ndescription: Prepare a deployment receipt.\n---\nKeep the signed receipt.\n";
const reviewId = "11111111-1111-4111-8111-111111111111";
let state: OpenClawTestState;
let config: OpenClawConfig;
let root: string;
let registry: ReturnType<typeof loadOpenClawPlugins> | undefined;

type RequestOptions = GatewayRequestOptions;
async function dispatch(
  method: string,
  params: Record<string, unknown> = {},
  scopes = ["operator.admin"],
) {
  const respond = vi.fn<RequestOptions["respond"]>();
  await handleGatewayRequest({
    req: { type: "req", id: "workshop-contract", method, params },
    client: {
      connId: "workshop-contract",
      connect: {
        role: "operator",
        scopes,
        client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
        minProtocol: 1,
        maxProtocol: 1,
      },
    },
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => config,
      logGateway: { warn: vi.fn() },
    } as unknown as RequestOptions["context"],
    respond,
  });
  expect(respond).toHaveBeenCalledOnce();
  const response = respond.mock.calls[0];
  assert.isDefined(response);
  const [ok, payload, error] = response;
  return { ok, payload, error };
}

beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "workshop-rpc-contract-" });
  config = {
    agents: { ownership: "explicit", entries: { ops: { workspace: state.workspaceDir } } },
    skills: { load: { watch: false } },
    ...workshopPluginConfig(
      { autonomous: { mode: "off" } },
      { plugins: { enabled: true, allow: ["skill-workshop"] } },
    ),
  };
  await state.writeConfig(config);
  // The skills.workshop.* methods belong to the bundled skill-workshop plugin.
  await shareCoreWithWorkshopPluginForTest();
  registry = loadOpenClawPlugins({ config, cache: false, activate: true });
  root = path.join(state.agentDir("ops"), "workshop-skills");
  await fs.mkdir(path.join(root, "deploy-notes"), { recursive: true });
  await fs.writeFile(path.join(root, "deploy-notes", "SKILL.md"), skill);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (registry) {
    await disposePluginRegistryInstances(registry);
    registry = undefined;
  }
  resetPluginRuntimeStateForTest();
  await closeSkillsWatchers(true);
  await state?.cleanup();
});

describe("Workshop through Gateway authorization and dispatch", () => {
  it("lets operator.read list, read and page changes but refuses every mutation", async () => {
    const readScopes = ["operator.read"];
    expect(await dispatch("skills.workshop.list", { agentId: "ops" }, readScopes)).toMatchObject({
      ok: true,
      payload: {
        agentId: "ops",
        mode: "off",
        skills: [{ name: "deploy-notes", description: "Prepare a deployment receipt." }],
        archived: [],
      },
    });
    expect(
      await dispatch("skills.workshop.read", { agentId: "ops", name: "deploy-notes" }, readScopes),
    ).toMatchObject({
      ok: true,
      payload: { name: "deploy-notes", filePath: "SKILL.md", content: skill, files: ["SKILL.md"] },
    });
    expect(
      await dispatch("skills.workshop.changes", { agentId: "ops", limit: 1 }, readScopes),
    ).toMatchObject({ ok: true, payload: { changes: [] } });
    for (const [method, params] of [
      ["skills.workshop.archive", { name: "deploy-notes" }],
      ["skills.workshop.restore", { name: "deploy-notes" }],
      ["skills.workshop.undo", { runId: `skill-workshop-review:${reviewId}` }],
    ] as const) {
      expect(await dispatch(method, { agentId: "ops", ...params }, readScopes)).toEqual({
        ok: false,
        payload: undefined,
        error: {
          code: "FORBIDDEN",
          message: "missing scope: operator.admin",
          details: {
            code: "MISSING_SCOPE",
            missingScope: "operator.admin",
            requiredScopes: ["operator.admin"],
          },
        },
      });
    }
    expect(await fs.readFile(path.join(root, "deploy-notes", "SKILL.md"), "utf8")).toBe(skill);
  });

  it("archives and restores on disk as the user and exposes the persisted change feed", async () => {
    expect(
      await dispatch("skills.workshop.archive", {
        agentId: "ops",
        name: "deploy-notes",
        reason: "superseded",
      }),
    ).toMatchObject({
      ok: true,
      payload: {
        change: {
          agentId: "ops",
          skillName: "deploy-notes",
          action: "archive",
          actor: "user",
          summary: "archived: superseded",
        },
      },
    });
    await expect(fs.stat(path.join(root, "deploy-notes"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const [versionId] = await fs.readdir(path.join(root, ".archive", "deploy-notes"));
    expect(versionId).toMatch(/^\d{8}T\d{9}Z-archive$/);
    expect(
      await dispatch("skills.workshop.read", { agentId: "ops", name: "deploy-notes", versionId }),
    ).toMatchObject({ ok: true, payload: { content: skill } });
    expect(
      await dispatch("skills.workshop.restore", {
        agentId: "ops",
        name: "deploy-notes",
        versionId,
      }),
    ).toMatchObject({
      ok: true,
      payload: { change: { action: "restore", actor: "user", summary: "restored from archive" } },
    });
    expect(await fs.readFile(path.join(root, "deploy-notes", "SKILL.md"), "utf8")).toBe(skill);
    expect(await dispatch("skills.workshop.changes", { agentId: "ops", limit: 1 })).toMatchObject({
      ok: true,
      payload: { changes: [{ skillName: "deploy-notes", action: "restore", actor: "user" }] },
    });
  });

  it("lists and reads on-disk drafts for operator.read, and applies or discards them for admin only", async () => {
    // Drafts are plain directories under .drafts/; Doctor writes this same shape.
    const drafted = skill.replace(
      "Keep the signed receipt.",
      "Keep and attach the signed receipt.",
    );
    for (const [id, reason] of [
      ["deploy-notes-1a2b3c4d", "attach the receipt"],
      ["deploy-notes-5e6f7a8b", "unused idea"],
    ] as const) {
      await fs.mkdir(path.join(root, ".drafts", id), { recursive: true });
      await fs.writeFile(path.join(root, ".drafts", id, ".reason"), `${reason}\n`);
      await fs.writeFile(path.join(root, ".drafts", id, "SKILL.md"), drafted);
    }
    const readScopes = ["operator.read"];
    const listed = await dispatch("skills.workshop.list", { agentId: "ops" }, readScopes);
    expect(listed).toMatchObject({ ok: true });
    expect(
      (listed.payload as { drafts: Array<{ id: string }> }).drafts.toSorted((a, b) =>
        a.id.localeCompare(b.id),
      ),
    ).toEqual([
      {
        id: "deploy-notes-1a2b3c4d",
        skillName: "deploy-notes",
        summary: "attach the receipt",
        createdAtMs: expect.any(Number),
      },
      {
        id: "deploy-notes-5e6f7a8b",
        skillName: "deploy-notes",
        summary: "unused idea",
        createdAtMs: expect.any(Number),
      },
    ]);
    const first = { agentId: "ops", name: "deploy-notes", draftId: "deploy-notes-1a2b3c4d" };
    expect(await dispatch("skills.workshop.read", first, readScopes)).toMatchObject({
      ok: true,
      payload: {
        name: "deploy-notes",
        filePath: "SKILL.md",
        content: drafted,
        files: ["SKILL.md"],
      },
    });
    for (const method of ["skills.workshop.applyDraft", "skills.workshop.discardDraft"]) {
      expect(await dispatch(method, first, readScopes)).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
      });
    }
    expect(
      await dispatch("skills.workshop.applyDraft", { ...first, name: "other-skill" }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message:
          'Draft "deploy-notes-1a2b3c4d" is for skill "deploy-notes", not "other-skill". Reload the drafts.',
      },
    });

    expect(await dispatch("skills.workshop.applyDraft", first)).toMatchObject({
      ok: true,
      payload: {
        changes: [
          {
            skillName: "deploy-notes",
            action: "write_file",
            actor: "user",
            summary: "attach the receipt",
            versionId: expect.any(String),
          },
        ],
      },
    });
    expect(await fs.readFile(path.join(root, "deploy-notes", "SKILL.md"), "utf8")).toBe(drafted);
    await expect(fs.stat(path.join(root, ".drafts", first.draftId))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const second = { ...first, draftId: "deploy-notes-5e6f7a8b" };
    expect(await dispatch("skills.workshop.discardDraft", second)).toEqual({
      ok: true,
      payload: { changes: [] },
      error: undefined,
    });
    await expect(fs.stat(path.join(root, ".drafts", second.draftId))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await dispatch("skills.workshop.list", { agentId: "ops" })).toMatchObject({
      ok: true,
      payload: { drafts: [] },
    });
  });

  const reviewRunId = `skill-workshop-review:${reviewId}`;
  const otherRunId = "skill-workshop-review:22222222-2222-4222-8222-222222222222";
  function openReviewTool(name: string, runId: string) {
    config = workshopPluginConfig({ autonomous: { mode: "auto" } }, config);
    setRuntimeConfigSnapshot(config);
    const agentSessionKey = "agent:ops:internal-session-effects:review";
    const tools = resolveOpenClawPluginToolsForOptions({
      resolvedConfig: config,
      options: {
        config,
        agentDir: state.agentDir("ops"),
        workspaceDir: state.workspaceDir,
        agentSessionKey,
        runId,
        inputProvenance: {
          kind: "internal_system",
          sourceTool: "session_fork",
          sourceSessionKey: "agent:ops:contract",
        },
        runtimePluginToolOwnerId: "skill-workshop",
        assertInvocationCurrent: () => {},
      },
    });
    const tool = finalizeOpenClawTools({
      tools,
      config,
      hookAgentId: "ops",
      gatewayCallerAccountId: undefined,
      options: { agentSessionKey, beforeToolCallHookContext: { runId } },
    }).find((entry) => entry.name === "skill_workshop");
    assert.isDefined(tool);
    return (action: string, params: Record<string, string> = {}) =>
      tool.execute(action, { name, action, ...params });
  }

  function recorded(skillName: string, action: string, runId = reviewRunId) {
    return { skillName, action, actor: "review", runId };
  }

  it.each(["existing", "new", "interleaved"] as const)(
    "reverts the first change to the current skill across same-run creates (%s)",
    async (scenario) => {
      const name = scenario === "existing" ? "deploy-notes" : "release-notes";
      const doc = (body: string) =>
        skill.replace("deploy-notes", name).replace("Keep the signed receipt.", body);
      const review = openReviewTool(name, reviewRunId);
      if (scenario === "existing") {
        await review("view");
      } else {
        await review("create", { content: doc("First version.") });
      }
      await review("archive", { reason: "Replace the checklist." });
      if (scenario === "interleaved") {
        const independent = openReviewTool(name, otherRunId);
        await independent("create", { content: doc("Independent version.") });
        await independent("archive", { reason: "Retire that version." });
      }
      const final = doc("Rewritten checklist.");
      await review("create", { content: final });
      const target = { agentId: "ops", name };
      expect(await dispatch("skills.workshop.read", target)).toMatchObject({
        ok: true,
        payload: { content: final },
      });
      const writes = [
        recorded(name, "create"),
        ...(scenario === "interleaved"
          ? [recorded(name, "archive", otherRunId), recorded(name, "create", otherRunId)]
          : []),
        recorded(name, "archive"),
        ...(scenario === "existing" ? [] : [recorded(name, "create")]),
      ];
      expect(await dispatch("skills.workshop.changes", { agentId: "ops" })).toMatchObject({
        ok: true,
        payload: { changes: writes },
      });
      const undone = await dispatch("skills.workshop.undo", { agentId: "ops", runId: reviewRunId });
      if (scenario === "existing") {
        expect(undone).toMatchObject({
          ok: true,
          payload: { status: "undone", changes: [{ action: "restore" }] },
        });
        expect(await dispatch("skills.workshop.read", target)).toMatchObject({
          ok: true,
          payload: { content: skill },
        });
      } else {
        expect(undone).toMatchObject({
          ok: true,
          payload: { status: "undone", changes: [{ action: "archive" }] },
        });
        await expect(fs.stat(path.join(root, name))).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("restores the independent skill's bytes from before this review patched it", async () => {
    const name = "deploy-notes";
    const target = { agentId: "ops", name };
    const review = openReviewTool(name, reviewRunId);
    await review("view");
    await review("patch", { old_text: "signed receipt", new_text: "old checklist" });
    await review("archive", { reason: "Retire the old checklist." });
    const other = openReviewTool(name, otherRunId);
    const replacement = skill.replace("signed receipt", "independent checklist");
    await other("create", { content: replacement });
    const filePath = "templates/checklist.txt";
    const support = "Independent checklist.\n";
    await other("write_file", { file_path: filePath, content: support });
    await review("view");
    await review("patch", { old_text: "independent checklist", new_text: "revised checklist" });
    const writes = [
      recorded(name, "patch"),
      recorded(name, "write_file", otherRunId),
      recorded(name, "create", otherRunId),
      recorded(name, "archive"),
      recorded(name, "patch"),
    ];
    expect(await dispatch("skills.workshop.changes", { agentId: "ops" })).toMatchObject({
      ok: true,
      payload: { changes: writes },
    });
    expect(
      await dispatch("skills.workshop.undo", { agentId: "ops", runId: reviewRunId }),
    ).toMatchObject({
      ok: true,
      payload: { status: "undone", changes: [{ action: "restore" }] },
    });
    expect(await dispatch("skills.workshop.read", target)).toMatchObject({
      ok: true,
      payload: { content: replacement },
    });
    expect(await dispatch("skills.workshop.read", { ...target, filePath })).toMatchObject({
      ok: true,
      payload: { content: support },
    });
  });

  async function seedReviewChange(action: "create" | "patch" = "create") {
    const versionId = action === "patch" ? "20260101T000000000Z-patch" : null;
    if (versionId) {
      const saved = path.join(root, ".archive", "deploy-notes", versionId);
      await fs.mkdir(saved, { recursive: true });
      await fs.writeFile(
        path.join(saved, "SKILL.md"),
        skill.replace("Keep the signed receipt.", "Keep the original checklist."),
      );
    }
    openOpenClawStateDatabase();
    await closeStateDatabaseForTest();
    const db = new DatabaseSync(state.statePath("state", "openclaw.sqlite"));
    try {
      db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
      db.exec(historicalWorkshopChangesSchema);
      db.prepare(
        "INSERT INTO skill_workshop_changes (cursor_id, change_id, agent_id, skill_name, action, actor, summary, version_id, run_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        1,
        `review-${action}`,
        "ops",
        "deploy-notes",
        action,
        "review",
        "reviewed receipt procedure",
        versionId,
        `skill-workshop-review:${reviewId}`,
        1,
      );
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  }

  it("allows admin to undo a persisted review, once", async () => {
    await seedReviewChange();
    const params = { agentId: "ops", runId: `skill-workshop-review:${reviewId}` };
    expect(await dispatch("skills.workshop.undo", params)).toMatchObject({
      ok: true,
      payload: {
        status: "undone",
        changes: [{ action: "archive", actor: "user", runId: `skill-workshop-undo:${reviewId}` }],
      },
    });
    await expect(fs.stat(path.join(root, "deploy-notes"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await dispatch("skills.workshop.undo", params)).toMatchObject({
      ok: true,
      payload: { status: "already-undone", changes: [] },
    });
  });

  it("still undoes the original review creation after a deliberate restore", async () => {
    await seedReviewChange();
    const target = { agentId: "ops", name: "deploy-notes" };
    expect(await dispatch("skills.workshop.archive", target)).toMatchObject({ ok: true });
    expect(await dispatch("skills.workshop.restore", target)).toMatchObject({ ok: true });
    expect(await dispatch("skills.workshop.read", target)).toMatchObject({
      ok: true,
      payload: { content: skill },
    });
    expect(
      await dispatch("skills.workshop.undo", {
        agentId: target.agentId,
        runId: `skill-workshop-review:${reviewId}`,
      }),
    ).toMatchObject({ ok: true, payload: { status: "undone", changes: [{ action: "archive" }] } });
    await expect(fs.stat(path.join(root, target.name))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["create", "patch"] as const)(
    "preserves an operator-created replacement when undoing the original review %s",
    async (action) => {
      await seedReviewChange(action);
      const target = { agentId: "ops", name: "deploy-notes" };
      const undo = { agentId: target.agentId, runId: `skill-workshop-review:${reviewId}` };
      expect(await dispatch("skills.workshop.archive", target)).toMatchObject({ ok: true });
      if (action === "create") {
        expect(await dispatch("skills.workshop.undo", undo)).toMatchObject({
          ok: true,
          payload: { status: "already-undone", changes: [] },
        });
      }

      const draftId = "deploy-notes-1a2b3c4d";
      const draft = path.join(root, ".drafts", draftId);
      const replacement = skill.replace("Keep the signed receipt.", "Use the new checklist.");
      const filePath = "templates/checklist.txt";
      const checklist = "Verify the deployment.\n";
      await fs.mkdir(path.join(draft, "templates"), { recursive: true });
      await fs.writeFile(path.join(draft, "SKILL.md"), replacement);
      await fs.writeFile(path.join(draft, filePath), checklist);
      expect(await dispatch("skills.workshop.applyDraft", { ...target, draftId })).toMatchObject({
        ok: true,
        payload: { changes: [{ action: "create", actor: "user" }] },
      });
      const changes = { agentId: target.agentId };
      const before = await dispatch("skills.workshop.changes", changes);
      expect(before.ok).toBe(true);

      const result = await dispatch("skills.workshop.undo", undo);
      expect(await dispatch("skills.workshop.read", target)).toMatchObject({
        ok: true,
        payload: { content: replacement },
      });
      expect(await dispatch("skills.workshop.read", { ...target, filePath })).toMatchObject({
        ok: true,
        payload: { content: checklist },
      });
      expect(result).toMatchObject({
        ok: true,
        payload: { status: "already-undone", changes: [] },
      });
      expect(await dispatch("skills.workshop.changes", changes)).toEqual(before);
    },
  );

  it("returns protocol validation, unknown-agent, and library refusals as INVALID_REQUEST", async () => {
    for (const [method, params] of [
      ["skills.workshop.list", { unexpected: true }],
      ["skills.workshop.changes", { limit: -1 }],
      ["skills.workshop.read", {}],
      ["skills.workshop.archive", {}],
      ["skills.workshop.restore", {}],
      ["skills.workshop.undo", {}],
    ] as const) {
      expect(await dispatch(method, params)).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: expect.stringContaining(`invalid ${method} params`),
        },
      });
    }
    expect(await dispatch("skills.workshop.list", { agentId: "ghost" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: 'unknown agent id "ghost"' },
    });
    expect(
      await dispatch("skills.workshop.archive", { agentId: "ops", name: "ghost" }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message:
          'No workshop skill named "ghost". Call action=list to see skills, or action=create to add one.',
      },
    });
    expect(
      await dispatch("skills.workshop.undo", {
        agentId: "ops",
        runId: `skill-workshop-review:${reviewId}`,
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: `No skill changes recorded for review skill-workshop-review:${reviewId}.`,
      },
    });
  });

  it("answers all retired proposal and curator methods with actionable Workshop guidance", async () => {
    const proposals = [
      "list",
      "inspect",
      "historyStatus",
      "historyScan",
      "create",
      "update",
      "revise",
      "requestRevision",
      "apply",
      "reject",
      "quarantine",
      "events.list",
      "evaluate",
    ];
    const curators = ["status", "pin", "unpin", "restore"];
    for (const method of proposals.map((name) => `skills.proposals.${name}`)) {
      expect(await dispatch(method, { proposalId: "retired", anything: true })).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message:
            "Skill Workshop proposals are retired. Workshop changes apply immediately and are undoable: use skills.workshop.list/changes/read/archive/restore (CLI: openclaw skills workshop ...).",
        },
      });
    }
    for (const method of curators.map((name) => `skills.curator.${name}`)) {
      expect(await dispatch(method, {})).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message:
            "Skill curator methods are retired. Use skills.workshop.list for Workshop skills, usage, and saved versions, and skills.workshop.archive/restore to change them (CLI: openclaw skills workshop ...).",
        },
      });
    }
  });
});
