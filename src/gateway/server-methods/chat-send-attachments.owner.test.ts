import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import * as sandboxWorkspace from "../../agents/sandbox/context.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { initializeGitFixture } from "../../agents/worktrees/git-fixture.test-support.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { insertRegistryWorktree, updateRegistryWorktree } from "../../agents/worktrees/registry.js";
import { makeWorktreeRecord } from "../../agents/worktrees/service.test-support.js";
import * as staging from "../../auto-reply/reply/stage-sandbox-media.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { abortChatRunById } from "../chat-abort.js";
import * as attachments from "../chat-attachments.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { readLocalWorkspaceProjection } from "../worker-environments/local-workspace-store.test-support.js";
import { prepareChatSendAttachments } from "./chat-send-attachments.js";
import {
  attachmentConfig,
  attachmentParams,
  prepareAttachmentFixture,
} from "./chat-send-attachments.test-support.js";
import { prepareAndAdmitChatSend } from "./chat-send-setup.js";
import { expectRpcError } from "./rpc-response.test-support.js";
import type { RespondFn } from "./types.js";

const it = test.extend<{ state: OpenClawTestState }>({
  state: async ({ task }, use) => {
    await withOpenClawTestState({ label: task.name }, async (state) => {
      await loadOrCreateProcessDeviceIdentityAsync();
      await use(state);
    });
  },
});

async function createUpload(
  state: OpenClawTestState,
  cfg: OpenClawConfig,
  params: ReturnType<typeof attachmentParams>,
  respond = vi.fn<RespondFn>(),
) {
  await state.writeConfig(cfg);
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  const setup = await prepareAndAdmitChatSend({ client: null, context, respond, params });
  assert(setup, "chat admission failed");
  const { admission } = setup;
  let prepared: Awaited<ReturnType<typeof prepareChatSendAttachments>> | undefined;
  return {
    ...setup,
    context,
    respond,
    get prepared() {
      return prepared;
    },
    prepare: () =>
      prepareChatSendAttachments({ ...setup, respond, context }).then((result) => {
        prepared = result;
        return result;
      }),
    async cleanup() {
      admission.cleanupAdmittedRun();
      clearAgentRunContext(params.idempotencyKey, admission.lifecycleGeneration);
      if (prepared?.ok) {
        await attachments.discardPreparedInboundMedia(prepared.value.offloadedRefs);
      }
    },
  };
}

async function unexpectedWorkspaceAccess(): Promise<never> {
  throw new Error("unexpected workspace access");
}

it("stages a non-PDF upload above 50 MiB when mediaMaxMb admits it", async ({ state }) => {
  const cfg = attachmentConfig(state, { mediaMaxMb: 51 });
  const size = 50 * 1024 * 1024 + 1;
  const { result, respond } = await prepareAttachmentFixture({
    params: attachmentParams("large-upload", "large.txt", Buffer.alloc(size, "x")),
    session: { cfg },
    abortCleanup: vi.fn(),
  });

  expect(respond.mock.calls).toEqual([]);
  assert(result.ok, "admitted attachment was not staged");
  const media = result.value.mediaPathOffloads[0]!;
  expect(media.path).toMatch(/^media\/inbound\/openclaw-staged-/u);
  await expect(fs.stat(path.resolve(media.workspaceDir!, media.path!))).resolves.toMatchObject({
    size,
  });
});

it.for(["off", "all"] as const)(
  "prepares both owners' global attachments with sandbox %s",
  async (mode, { state }) => {
    const cfg = attachmentConfig(state, { mode, global: true });
    const paths: string[] = [];
    for (const agentId of ["main", "work"]) {
      const bytes = `${agentId} attachment contents`;
      const fileName = "notes café 雪 🦞.txt";
      const { result, respond } = await prepareAttachmentFixture({
        params: attachmentParams(`media-${agentId}`, fileName, bytes, {
          agentId,
          sessionKey: "global",
        }),
        session: { cfg, sessionKey: "global", agentId },
      });
      expect(respond.mock.calls).toEqual([]);
      assert(result.ok, "attachment preparation failed");
      const media = result.value.mediaPathOffloads[0]!;
      expect(media.fileName).toBe(fileName);
      const file = path.resolve(media.workspaceDir!, media.path!);
      expect(await fs.readFile(file, "utf8")).toBe(bytes);
      paths.push(file);
      if (mode === "all") {
        expect(file.startsWith(state.path("sandboxes"))).toBe(true);
      }
    }
    expect(paths[0]).not.toBe(paths[1]);
  },
);

it("stages managed session follow-ups in their projection and rejects unrelated workspaces", async ({
  state,
}) => {
  const repository = await initializeGitFixture(state.root, "repository", "README.md", "base");
  const checkout = state.path("checkout");
  await requireGit(repository, ["worktree", "add", "--quiet", "-b", "openclaw/guest", checkout]);
  const sessionKey = "agent:main:dashboard:managed-attachment";
  const worktree = makeWorktreeRecord(repository, "00000000-0000-4000-8000-000000000001", {
    name: "guest",
    repoFingerprint: "synthetic-attachment-repository",
    path: checkout,
    branch: "openclaw/guest",
    baseRef: "main",
    ownerId: sessionKey,
  });
  await insertRegistryWorktree(process.env, worktree);
  const cfg = {
    worktreeAcceleration: false,
    agents: {
      entries: { main: { workspace: state.workspaceDir } },
      defaults: {
        skipBootstrap: true,
        sandbox: { mode: "off", backend: "docker", workspaceAccess: "none" },
      },
    },
  } satisfies OpenClawConfig;
  setRuntimeConfigSnapshot(cfg);
  const entry = {
    sessionId: "managed-attachment-session",
    updatedAt: 1,
    sandbox: "required" as const,
    spawnedCwd: checkout,
    worktree: { id: worktree.id, branch: worktree.branch, repoRoot: repository },
  };
  await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
  for (const selection of ["cwd", "workspace", "unrelated", "removed"] as const) {
    if (selection === "removed") {
      await updateRegistryWorktree(process.env, worktree.id, { removedAt: 2 });
    }
    const selectedEntry = {
      ...entry,
      spawnedCwd: selection === "cwd" || selection === "removed" ? checkout : state.workspaceDir,
      ...(selection === "workspace"
        ? { spawnedBy: "agent:main:parent", spawnedWorkspaceDir: checkout }
        : {}),
    };
    const { result, respond } = await prepareAttachmentFixture({
      params: attachmentParams(`managed-${selection}`, "comment.txt", "Comment", { sessionKey }),
      session: {
        cfg,
        sessionKey,
        agentId: "main",
        entry: { ...entry, spawnedCwd: state.workspaceDir },
      },
      admission: { admittedSessionEntry: selectedEntry },
      abortCleanup() {},
      context: { logGateway: createSubsystemLogger("test/managed-media") },
    });
    if (selection === "unrelated" || selection === "removed") {
      expect(result.ok).toBe(false);
      expectRpcError(respond, {
        code: "UNAVAILABLE",
        message: expect.stringContaining("Local sandbox managed workspace owner changed"),
      });
      continue;
    }
    expect(respond.mock.calls).toEqual([]);
    assert(result.ok, "managed attachment preparation failed");
    const media = result.value.mediaPathOffloads[0]!;
    const projection = await readLocalWorkspaceProjection(worktree.id);
    expect(projection?.session_key).toBe(sessionKey);
    expect(media.workspaceDir).toBe(projection?.projection_path);
    expect(media.workspaceDir).not.toBe(state.workspaceDir);
    expect(media.workspaceDir).not.toBe(checkout);
    expect(await fs.readFile(path.resolve(media.workspaceDir!, media.path!), "utf8")).toBe(
      "Comment",
    );
    await expect(fs.stat(path.resolve(checkout, media.path!))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
});

it.for([
  { canTransfer: true, stopped: false },
  { canTransfer: false, stopped: false },
  { canTransfer: false, stopped: true },
  { canTransfer: true, stopped: true },
])("routes chat uploads: %j", async ({ canTransfer, stopped }, { state }) => {
  const cfg = attachmentConfig(state, { sandboxRoot: "sandbox" });
  const runId = "remote-attachment";
  const upload = await createUpload(
    state,
    cfg,
    attachmentParams(runId, "input.txt", "original upload", { agentId: "main" }),
  );
  const { respond } = upload;
  const release = registerAgentWorkspaceAccess(state.workspaceDir, {
    ...(canTransfer ? { prepareTurnAttachments: vi.fn(async () => undefined) } : {}),
    bridge: {
      readFile: unexpectedWorkspaceAccess,
      writeFile: unexpectedWorkspaceAccess,
      stat: unexpectedWorkspaceAccess,
    },
  });
  if (stopped) {
    release();
  }
  const sandboxSpy = vi.spyOn(sandboxWorkspace, "ensureSandboxWorkspaceForSession");
  try {
    const prepared = await upload.prepare();
    if (canTransfer && stopped) {
      expect(prepared.ok).toBe(false);
      expect(sandboxSpy).not.toHaveBeenCalled();
      expectRpcError(respond, { code: "UNAVAILABLE" });
      return;
    }
    assert(prepared.ok, "attachment preparation failed");
    const source = prepared.value.offloadedRefs[0]!.path;
    const media = prepared.value.mediaPathOffloads[0]!;
    expect(await fs.readFile(source, "utf8")).toBe("original upload");
    if (canTransfer) {
      expect(media).toMatchObject({ path: source, fileName: "input.txt" });
      expect(sandboxSpy).not.toHaveBeenCalled();
    } else {
      expect(sandboxSpy).toHaveBeenCalled();
      expect(media.workspaceDir?.startsWith(state.path("sandbox"))).toBe(true);
      expect(await fs.readFile(path.join(media.workspaceDir!, media.path!), "utf8")).toBe(
        "original upload",
      );
    }
  } finally {
    release();
    sandboxSpy.mockRestore();
    await upload.cleanup();
  }
});

it.for([
  ["signal-only TXT cleanup", false, "signal", "abort", "aborted", "stage"],
  ["managed-PDF cancellation without fallback", true, "signal", "abort", "aborted", "stage"],
  ["ordinary TXT failure with aborted signal", false, "signal", "ordinary", "unavailable", "stage"],
  ["RPC abort precedence over later TXT failure", false, "marker", "ordinary", "aborted", "stage"],
  ["ordinary managed-PDF host-path fallback", true, "none", "ordinary", "fallback", "stage"],
  ["unsandboxed cleanup before cancellation", false, "signal", "abort", "aborted", "sandbox-null"],
  ["managed-PDF pass-through cleanup", true, "signal", "abort", "aborted", "pass-through"],
  ["TXT failure before late abort", false, "late-marker", "ordinary", "unavailable", "stage"],
] as const)(
  "%s",
  async ([_name, pdf, interruption, stageError, outcome, preparation], { state }) => {
    const cfg = attachmentConfig(state, {
      mode: preparation === "sandbox-null" ? "off" : "all",
      ...(preparation === "pass-through" ? { mediaMaxMb: 51 } : {}),
    });
    const runId = "attachment-cancellation";
    const bytes =
      preparation === "pass-through"
        ? Buffer.alloc(staging.SANDBOX_MEDIA_MAX_BYTES + 1, " ")
        : Buffer.from(pdf ? "%PDF-1.4\n% synthetic attachment\n%%EOF\n" : "synthetic attachment");
    if (preparation === "pass-through") {
      bytes.write("%PDF-1.4\n% synthetic attachment\n");
      bytes.write("%%EOF\n", bytes.length - 6);
    }
    let inboundPath: string | undefined;
    const filesPresentAtResponse: boolean[] = [];
    const respond = vi.fn<RespondFn>(() => {
      filesPresentAtResponse.push(inboundPath !== undefined && existsSync(inboundPath));
    });
    const upload = await createUpload(
      state,
      cfg,
      attachmentParams(runId, pdf ? "notes.pdf" : "notes.txt", bytes, {
        agentId: "main",
        message: "read the attached file",
      }),
      respond,
    );
    expect(respond).not.toHaveBeenCalled();
    const { admission, context } = upload;
    const signal = admission.activeRunAbort.controller.signal;
    const ordinaryFailure = new Error("synthetic staging filesystem failure");
    const stageRelease = createDeferred();
    const cleanupRelease = createDeferred();
    const discard = attachments.discardPreparedInboundMedia;
    const parse = attachments.parseMessageWithAttachments;
    const ensureSandbox = sandboxWorkspace.ensureSandboxWorkspaceForSession;
    const preparationEntered = createDeferred();
    const parseSpy = vi
      .spyOn(attachments, "parseMessageWithAttachments")
      .mockImplementation(async (...args) => {
        const result = await parse(...args);
        inboundPath = result.offloadedRefs[0]?.path;
        if (preparation === "pass-through") {
          preparationEntered.resolve();
          await stageRelease.promise;
        }
        return result;
      });
    const sandboxSpy =
      preparation === "sandbox-null"
        ? vi
            .spyOn(sandboxWorkspace, "ensureSandboxWorkspaceForSession")
            .mockImplementation(async (...args) => {
              const result = await ensureSandbox(...args);
              if (result !== null) {
                throw new Error("the unsandboxed fixture unexpectedly provisioned a workspace");
              }
              preparationEntered.resolve();
              await stageRelease.promise;
              return result;
            })
        : undefined;
    const discardSpy = vi
      .spyOn(attachments, "discardPreparedInboundMedia")
      .mockImplementation(async (...args) => {
        await cleanupRelease.promise;
        await discard(...args);
      });
    const stageSpy = vi.spyOn(staging, "stageSandboxMedia").mockImplementation(async ({ ctx }) => {
      inboundPath = ctx.media?.[0]?.path;
      preparationEntered.resolve();
      await stageRelease.promise;
      throw stageError === "abort" ? signal.reason : ordinaryFailure;
    });
    const preparing = upload.prepare();
    const abort = () =>
      abortChatRunById(createChatAbortOps(context), {
        runId,
        sessionKey: upload.session.sessionKey,
        stopReason: "rpc",
      });

    try {
      await awaitGateBeforeSettlement(
        preparationEntered.promise,
        preparing,
        "attachment preparation completed before reaching the held boundary",
      );
      if (preparation !== "stage") {
        expect(stageSpy).not.toHaveBeenCalled();
      }
      assert(inboundPath, "the real attachment parser did not create an inbound file");
      if (interruption === "marker") {
        expect(abort()).toEqual({ aborted: true });
      } else if (interruption === "signal") {
        admission.activeRunAbort.controller.abort(createAgentRunDirectAbortError());
      }
      expect(signal.aborted).toBe(interruption === "signal" || interruption === "marker");
      expect(context.chatRunState.hasAbortMarker(runId)).toBe(interruption === "marker");
      stageRelease.resolve();

      if (outcome === "fallback") {
        const result = await preparing;
        assert(result.ok, "ordinary managed-PDF fallback failed");
        expect(result.value.mediaPathOffloads).toEqual([
          {
            path: inboundPath,
            contentType: "application/pdf",
            fileName: "notes.pdf",
            workspaceDir: path.dirname(inboundPath),
          },
        ]);
        expect((await fs.readFile(inboundPath)).equals(bytes)).toBe(true);
        expect(discardSpy).not.toHaveBeenCalled();
        expect(respond).not.toHaveBeenCalled();
        return;
      }

      // Cancellation must retain admission until the real abandoned-file
      // cleanup settles; neither a PDF fallback nor an early response owns it.
      await vi.waitFor(() => expect(discardSpy).toHaveBeenCalledOnce());
      expect(upload.prepared).toBeUndefined();
      expect(admission.gatewayWorkAdmission.isActive()).toBe(true);
      expect(respond).not.toHaveBeenCalled();
      expect(existsSync(inboundPath)).toBe(true);
      if (interruption === "late-marker") {
        expect.soft(abort()).toEqual({ aborted: false });
        expect.soft(signal.aborted).toBe(false);
        expect.soft(context.chatRunState.hasAbortMarker(runId)).toBe(false);
        expect(admission.gatewayWorkAdmission.isActive()).toBe(true);
      }
      cleanupRelease.resolve();
      expect(await preparing).toEqual({ ok: false });
      expect(admission.gatewayWorkAdmission.isActive()).toBe(false);
      expect(filesPresentAtResponse).toEqual([false]);
      expect(respond).toHaveBeenCalledOnce();
      if (interruption === "late-marker") {
        expect
          .soft(vi.mocked(context.broadcast).mock.calls.filter(([event]) => event === "chat"))
          .toHaveLength(0);
        expect.soft(context.logGateway.error).toHaveBeenCalledOnce();
      }
      if (outcome === "aborted") {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            runId,
            status: "timeout",
            summary: "aborted",
            stopReason: "rpc",
          }),
          undefined,
          { runId },
        );
        if (preparation === "stage" && stageError === "abort") {
          expect(stageSpy).toHaveBeenCalledWith(expect.objectContaining({ abortSignal: signal }));
        }
      } else {
        expectRpcError(respond, {
          code: "UNAVAILABLE",
          message: expect.stringContaining(ordinaryFailure.message),
        });
      }
    } finally {
      stageRelease.resolve();
      cleanupRelease.resolve();
      try {
        await preparing;
      } finally {
        stageSpy.mockRestore();
        sandboxSpy?.mockRestore();
        parseSpy.mockRestore();
        discardSpy.mockRestore();
        await upload.cleanup();
      }
    }
  },
);
