import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { captureMethodCall } from "../../test/helpers/capture-method-call.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireGit } from "../agents/worktrees/git.js";
import { createManagedWorktreeOwnerPolicy } from "../agents/worktrees/owner-protection.js";
import { getRegistryWorktree } from "../agents/worktrees/registry.test-support.js";
import { ManagedWorktreeService, managedWorktrees } from "../agents/worktrees/service.js";
import { materializeManagedWorktreeFixtures } from "../agents/worktrees/service.test-support.js";
import type { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  listSessionPendingInputs,
  loadTranscriptEventsSync,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import { readPersistedMediaFacts } from "../media/media-facts.js";
import { resolveMediaReferenceLocalPath } from "../media/media-reference.js";
import { ProjectCloneError } from "../projects/project-clone-runtime.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import { captureSessionControllerSettlement } from "../sessions/session-controller.lifecycle.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createChatRunState } from "./server-chat-state.js";
import {
  controlUiClient,
  initializeRepository,
  removeOwnedSessionWorktree,
  settleWorkspaceRuns,
  successfulSessionRequest as request,
} from "./server.sessions.create.projects.test-support.js";
import { dispatchInboundMessageMock, testState } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const projectCloneMocks = vi.hoisted(() => ({
  assertSelected: vi.fn(),
  materialize: vi.fn(),
  prepareIdentity: vi.fn(),
}));
const titleMocks = vi.hoisted(() => ({ generate: vi.fn() }));

vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback: titleMocks.generate,
}));

vi.mock("../projects/project-clone.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../projects/project-clone.js")>();
  return { ...actual, materializeProjectClone: projectCloneMocks.materialize };
});
vi.mock("./project-github-identity.js", () => ({
  prepareGatewayProjectGitHubIdentity: projectCloneMocks.prepareIdentity,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts.close());

afterEach(async () => {
  for (const mock of [
    titleMocks.generate,
    ...Object.values(projectCloneMocks),
    dispatchInboundMessageMock,
  ]) {
    mock.mockReset();
  }
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
});

// Register after the resets so stacked teardown drains fixture stores first.
const { createSessionStoreDir, withSessionTestState } = setupGatewaySessionsHandlerTestHarness();

const readReadme = (dir: string) => fs.readFile(path.join(dir, "README.md"), "utf8");
const readEntry = (storePath: string, sessionKey: string) =>
  loadSessionEntry({ agentId: "main", sessionKey, storePath });
const removeWorktree = (id: string) =>
  managedWorktrees.remove({ id, reason: "test-cleanup", allowSnapshotLoss: true });
function mockDispatch() {
  dispatchInboundMessageMock.mockResolvedValue({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  });
}
function expectChatEvent(broadcast: ReturnType<typeof vi.fn>, fields: Record<string, unknown>) {
  expect(broadcast).toHaveBeenCalledWith(
    "chat",
    expect.objectContaining(fields),
    expect.anything(),
  );
}
function expectPreparedProject(
  entry: SessionEntry | null | undefined,
  sessionId: string,
  project: Awaited<ReturnType<typeof registerProjectRegistry>>,
  projectRoot: string,
  worktree: boolean,
) {
  expect(entry).toMatchObject({
    sessionId,
    projectId: project.id,
    ...(worktree
      ? { worktree: { canonicalWorkspaceDir: projectRoot } }
      : { spawnedCwd: projectRoot, sessionRoot: projectRoot }),
  });
}
async function remoteProjectFixture<T = Awaited<ReturnType<typeof registerProjectRegistry>>>(
  prefix: string,
  options: { sandboxed?: boolean; alias?: boolean; recordInput?: boolean } = {},
) {
  const root = tempDirs.make(prefix);
  const workspace = await initializeRepository(root, "workspace");
  const projectRoot = await initializeRepository(options.sandboxed ? workspace : root, "project");
  const selectedWorkspace = options.alias ? path.join(root, "workspace-alias") : workspace;
  if (options.alias) {
    await fs.symlink(workspace, selectedWorkspace, directoryLinkType);
  }
  testState.agentConfig = {
    workspace: selectedWorkspace,
    ...(options.sandboxed === undefined
      ? {}
      : { sandbox: { mode: options.sandboxed ? "all" : "off" } }),
  };
  const { storePath } = await createSessionStoreDir();
  const project = await registerProjectRegistry({ path: projectRoot, name: "Project" });
  const materialization = createDeferredCore<T>();
  projectCloneMocks.materialize.mockReturnValueOnce(materialization.promise);
  if (options.recordInput) {
    projectCloneMocks.prepareIdentity.mockResolvedValue({
      token: "protected-native-token",
      assertSelected: projectCloneMocks.assertSelected,
    });
    dispatchInboundMessageMock.mockImplementation(async (params: unknown) => {
      const { replyOptions } = params as Parameters<typeof dispatchInboundMessage>[0];
      await replyOptions?.userTurnTranscriptRecorder?.persistApproved();
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
  } else {
    mockDispatch();
  }
  return { storePath, projectRoot, project, materialization };
}

type CreatedSession = {
  entry: SessionEntry;
  key: string;
  runId: string;
  runStarted: boolean;
  sessionId: string;
};
function createSession(
  params: Record<string, unknown>,
  options: Parameters<typeof directSessionReq<CreatedSession>>[2] = controlUiClient,
) {
  return request<CreatedSession>("sessions.create", { agentId: "main", ...params }, options);
}
function createRemoteSession(
  context: Record<string, unknown>,
  params: Record<string, unknown> = { worktree: true, worktreeName: "retry-worktree" },
) {
  return createSession(
    {
      message: "Inspect the remote project",
      projectGitUrl: "https://github.com/openclaw/openclaw.git",
      ...params,
    },
    { ...controlUiClient, context },
  );
}

test.each([
  { mode: "ready", worktree: true, sandboxed: false, image: true, baseRef: "main" },
  { mode: "ready", worktree: false, sandboxed: true },
  { mode: "abort", worktree: true },
  { mode: "retry", worktree: false },
  { mode: "retry", worktree: true },
])(
  "remote project $mode (worktree=$worktree, sandboxed=$sandboxed)",
  async ({ mode, worktree, sandboxed, image, baseRef }) => {
    const ready = mode === "ready";
    if (ready) {
      vi.stubEnv("GH_TOKEN", "");
      vi.stubEnv("GITHUB_TOKEN", "");
    }
    const { storePath, projectRoot, project, materialization } = await remoteProjectFixture(
      `openclaw-remote-${mode}-`,
      { sandboxed, alias: ready, recordInput: ready },
    );
    const attachments = image
      ? [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "synthetic.png",
            content:
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
          },
        ]
      : undefined;
    const broadcast = vi.fn();
    if (mode === "abort") {
      rpcSourceTesting.clear();
    }
    const chatRunState = mode === "abort" ? createChatRunState() : undefined;
    const dedupe = new Map();
    const context = {
      broadcast,
      ...(ready ? {} : { dedupe }),
      ...(chatRunState ? { chatRunState } : {}),
    };
    const events: AgentEventPayload[] = [];
    const unsubscribe = ready ? onAgentEvent((event) => events.push(event)) : () => {};
    let key: string | undefined;
    try {
      const created = await createRemoteSession(
        context,
        ready
          ? {
              ...(attachments ? { attachments } : {}),
              projectGitUrl: "git@github.com:OpenClaw/OpenClaw.git",
              ...(worktree
                ? { worktree: true, worktreeName: "remote-startup", worktreeBaseRef: baseRef }
                : {}),
            }
          : worktree
            ? { worktree: true, worktreeName: "retry-worktree" }
            : {},
      );
      key = created.key;
      const { runId, sessionId } = created;
      if (ready) {
        expect(created).toMatchObject({
          key: expect.any(String),
          runId: expect.any(String),
          runStarted: true,
          sessionId: expect.any(String),
        });
        expect(created?.entry).not.toHaveProperty("pendingProjectGitUrl");
        expect(created?.entry).not.toHaveProperty("pendingWorktree");
        expect(readEntry(storePath, key)).toMatchObject({
          sessionId,
          pendingProjectGitUrl: "https://github.com/openclaw/openclaw.git",
          ...(worktree ? { pendingWorktree: { baseRef } } : {}),
        });
        await vi.waitFor(() => expect(projectCloneMocks.materialize).toHaveBeenCalledOnce());
        expect(projectCloneMocks.materialize).toHaveBeenCalledWith(
          expect.objectContaining({ gitUrl: "https://github.com/openclaw/openclaw.git" }),
          expect.objectContaining({
            signal: expect.any(AbortSignal),
            token: "protected-native-token",
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            runId,
            stream: "run_status",
            data: expect.objectContaining({ phase: "preparing_workspace" }),
          }),
        );
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        const transcriptScope = { agentId: "main", sessionKey: key, sessionId, storePath };
        const pending = await listSessionPendingInputs(transcriptScope);
        const committed = loadTranscriptEventsSync(transcriptScope)
          .map(asNullableRecord)
          .filter((event) => event?.type === "message");
        if (image) {
          expect(committed).toMatchObject([
            { message: { role: "user", idempotencyKey: `${runId}:user` } },
          ]);
          expect(pending).toEqual({ items: [], total: 0 });
          const startup = await request(
            "chat.startup",
            { sessionKey: key },
            { ...controlUiClient, context },
          );
          expect(startup).toMatchObject({
            messages: [{ role: "user" }],
            pendingInputs: { total: 0, items: [] },
          });
          expect(created).toMatchObject({ messageSeq: 1 });
          const media = readPersistedMediaFacts(
            expectDefined(asNullableRecord(committed[0]?.message), "committed initial input"),
          );
          expect(media).toMatchObject([{ contentType: "image/png" }]);
          expect(await fs.readFile(await resolveMediaReferenceLocalPath(media![0]!.url!))).toEqual(
            Buffer.from(attachments![0]!.content, "base64"),
          );
        }

        materialization.resolve(project);
        await settleWorkspaceRuns(context, storePath, key);
        expect(projectCloneMocks.assertSelected).toHaveBeenCalled();
        const error = broadcast.mock.calls.find(
          ([event, payload]) => event === "chat" && payload.state === "error",
        );
        expect(error?.[1]).toBeUndefined();
        expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
        const transcript = loadTranscriptEventsSync(transcriptScope).map(asNullableRecord);
        expect(
          transcript.filter((event) => asNullableRecord(event?.message)?.role === "user"),
        ).toHaveLength(1);
        expect(transcript.at(-1)).toMatchObject({ message: { idempotencyKey: `${runId}:user` } });
        expect(await listSessionPendingInputs(transcriptScope)).toEqual({ items: [], total: 0 });
        if (image) {
          expect(transcript.at(-1)?.id).toBe(committed[0]?.id);
          const persistedMessage = expectDefined(
            asNullableRecord(transcript.at(-1)?.message),
            "persisted initial input",
          );
          expect(readPersistedMediaFacts(persistedMessage)).toEqual(
            readPersistedMediaFacts(
              expectDefined(asNullableRecord(committed[0]?.message), "committed initial input"),
            ),
          );
        }
        const prepared = readEntry(storePath, key);
        expectPreparedProject(prepared, sessionId, project, projectRoot, worktree);
        if (worktree) {
          expect((await managedWorktrees.findLiveByOwner("session", key))?.baseRef).toBe("main");
          expect(prepared?.spawnedCwd).not.toBe(projectRoot);
          expect(await readReadme(prepared!.spawnedCwd!)).toBe("project\n");
          await removeWorktree(prepared!.worktree!.id);
        }
      } else if (mode === "abort") {
        expect(created?.runStarted).toBe(true);
        await vi.waitFor(() => expect(projectCloneMocks.materialize).toHaveBeenCalledOnce());
        const signal = rpcSourceTesting.get(runId)?.input.abortSignal;
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(projectCloneMocks.materialize).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ signal }),
        );
        expect(signal?.aborted).toBe(false);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();

        const aborted = await request<{ aborted: boolean; runIds: string[] }>(
          "chat.abort",
          { agentId: "main", sessionKey: key, runId },
          { ...controlUiClient, context },
        );
        expect(aborted).toMatchObject({ aborted: true, runIds: [runId] });
        expect(signal?.aborted).toBe(true);
        expectChatEvent(broadcast, { runId, sessionKey: key, state: "aborted" });

        materialization.resolve(project);
        await settleWorkspaceRuns(context, storePath, key);
        expect(dedupe.get(`chat:${runId}`)).toMatchObject({
          payload: { runId, summary: "aborted" },
        });
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(readEntry(storePath, key)).toMatchObject({
          sessionId,
          pendingProjectGitUrl: "https://github.com/openclaw/openclaw.git",
        });
        expect(readEntry(storePath, key)?.projectId).toBe(undefined);
        expect(chatRunState!.runs.get(runId)?.abortMarker).toBeDefined();
      } else {
        expect(created).toMatchObject({ runStarted: true, runId: expect.any(String) });
        const entryAfterCreation = readEntry(storePath, key);
        const failureMessage =
          "Git clone could not reach GitHub. Check the Gateway network connection and retry.";
        materialization.reject(new ProjectCloneError("network", failureMessage));
        await settleWorkspaceRuns(context, storePath, key);
        expectChatEvent(broadcast, {
          runId,
          sessionKey: key,
          state: "error",
          errorMessage: expect.stringContaining(failureMessage),
        });
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(readEntry(storePath, key)).toMatchObject({ sessionId });
        expect(readEntry(storePath, key)?.status).not.toBe("running");
        const entryAfterFailure = readEntry(storePath, key);
        // The first chat pane subscribes only after create-and-navigate. Its history
        // must recover the failure without receiving the already-emitted chat event.
        for (const method of ["chat.startup", "chat.history"] as const) {
          const history = await request(method, { sessionKey: key }, controlUiClient);
          expect(history).toMatchObject({
            sessionInfo: {
              sessionId,
              status: "failed",
              hasActiveRun: false,
              lastRunId: runId,
              lastRunError: expect.stringContaining(failureMessage),
            },
            messages: [
              expect.objectContaining({ role: "user" }),
              expect.objectContaining({
                role: "custom",
                customType: "run-failed-before-reply",
                display: true,
                content: expect.stringContaining(failureMessage),
              }),
            ],
          });
        }

        const retriedMaterialization = createDeferredCore<typeof project>();
        projectCloneMocks.materialize.mockReturnValueOnce(retriedMaterialization.promise);
        const restartedContext = { broadcast, dedupe: new Map() };

        try {
          const retried = await request<{ runId: string; status: string }>(
            "chat.send",
            {
              sessionKey: key,
              agentId: "main",
              message: "Retry the remote project",
              idempotencyKey: "remote-project-retry",
            },
            { ...controlUiClient, context: restartedContext },
          );
          expect(retried).toMatchObject({
            runId: "remote-project-retry",
            status: "started",
          });
          await vi.waitFor(() => expect(projectCloneMocks.materialize).toHaveBeenCalledTimes(2));
          expect(readEntry(storePath, key)?.lastRunError).toBe(undefined);
          expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
          for (const entry of [entryAfterCreation, entryAfterFailure, readEntry(storePath, key)]) {
            expect(entry).toMatchObject({
              sessionId,
              pendingProjectGitUrl: "https://github.com/openclaw/openclaw.git",
            });
          }

          retriedMaterialization.resolve(project);
          await settleWorkspaceRuns(restartedContext, storePath, key);
          const error = broadcast.mock.calls.find(
            ([event, payload]) =>
              event === "chat" &&
              payload.runId === "remote-project-retry" &&
              payload.state === "error",
          );
          expect(error?.[1]).toBeUndefined();
          expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
          const preparedEntry = readEntry(storePath, key);
          expectPreparedProject(preparedEntry, sessionId, project, projectRoot, worktree);
          expect(preparedEntry).not.toHaveProperty("pendingProjectGitUrl");
          expect(preparedEntry).not.toHaveProperty("pendingWorktree");
          if (preparedEntry?.worktree) {
            await removeWorktree(preparedEntry.worktree.id);
          }
        } finally {
          retriedMaterialization.resolve(project);
          await settleWorkspaceRuns(restartedContext, storePath, key, true);
        }
      }
    } finally {
      materialization.resolve(project);
      await settleWorkspaceRuns(context, storePath, key, true);
      unsubscribe();
    }
  },
);

test.for([false, true])(
  "concurrent sends retain one bound worktree after deferred setup (abort first=%s)",
  async (abortFirst, { signal }) => {
    const root = tempDirs.make("openclaw-session-worktree-concurrent-");
    const workspace = await initializeRepository(root, "workspace");
    testState.agentConfig = { workspace };
    const { storePath } = await createSessionStoreDir();
    const setup = path.join(workspace, ".openclaw");
    await fs.mkdir(setup);
    const firstStarted = path.join(setup, "first-started");
    const secondStarted = path.join(setup, "second-started");
    const starts = path.join(setup, "starts");
    const release = path.join(setup, "release");
    await fs.writeFile(
      path.join(setup, "setup-started.mjs"),
      `${fixtureReceiptClientSource(receipts.endpoint)}
sendReceipt(process.argv[2], "started");
`,
    );
    await fs.writeFile(
      path.join(setup, "worktree-setup.sh"),
      [
        "#!/bin/sh",
        'echo started >> "$OPENCLAW_SOURCE_TREE_PATH/.openclaw/starts"',
        'if [ -f "$OPENCLAW_SOURCE_TREE_PATH/.openclaw/first-started" ]; then attempt=second; else attempt=first; fi',
        'marker="$OPENCLAW_SOURCE_TREE_PATH/.openclaw/$attempt-started"',
        'touch "$marker"',
        `${JSON.stringify(process.execPath)} "$OPENCLAW_SOURCE_TREE_PATH/.openclaw/setup-started.mjs" "$marker"`,
        'while [ ! -f "$OPENCLAW_SOURCE_TREE_PATH/.openclaw/release" ]; do sleep 0.05; done',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const context = {
      broadcast: vi.fn(),
      chatRunState: createChatRunState(),
      dedupe: new Map(),
    };
    const options = { client: { connect: { scopes: ["operator.admin"] } } as never, context };
    mockDispatch();
    let key: string | undefined;
    const waitForSetup = (marker: string) =>
      withinTest(
        Promise.race([
          receipts.waitFor(marker, "started"),
          // Admission can settle before socket delivery; confirm its durable marker.
          Promise.resolve(
            captureSessionControllerSettlement({ scope: storePath, identities: [key] }),
          ).then(() => fs.access(marker)),
        ]),
        signal,
      );
    try {
      const created = await createSession(
        {
          message: "Start during setup",
          worktree: true,
          worktreeBaseRef: "main",
          label: "Concurrent setup",
        },
        options,
      );
      expect(created?.runStarted).toBe(true);
      key = created.key;
      await waitForSetup(firstStarted);
      expect(await fs.readFile(starts, "utf8")).toBe("started\n");
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(readEntry(storePath, key)?.pendingWorktree).toMatchObject({
        baseRef: "main",
        baseCommit: expect.any(String),
      });
      await request(
        "chat.send",
        {
          agentId: "main",
          sessionKey: key,
          message: "Continue after setup",
          idempotencyKey: "second-worktree-send",
        },
        options,
      );
      if (abortFirst) {
        await request("chat.abort", { sessionKey: key, runId: created.runId }, options);
        await waitForSetup(secondStarted);
        expect(await fs.readFile(starts, "utf8")).toBe("started\nstarted\n");
      }
      await fs.writeFile(release, "ready\n");
      await settleWorkspaceRuns(context, storePath, key);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(abortFirst ? 1 : 2);
      const entry = readEntry(storePath, key);
      expect(entry).not.toHaveProperty("pendingWorktree");
      expect(entry?.worktree?.canonicalWorkspaceDir).toBe(workspace);
      const owned = await managedWorktrees.findLiveByOwner("session", key!);
      expect(owned?.id).toBe(entry?.worktree?.id);
      await expect(readReadme(entry!.spawnedCwd!)).resolves.toBe("workspace\n");
      expect(
        context.broadcast.mock.calls.filter(
          ([event, payload]) => event === "chat" && payload.state === "error",
        ),
      ).toEqual([]);
    } finally {
      await fs.writeFile(release, "release setup\n");
      await settleWorkspaceRuns(context, storePath, key, true);
      await removeOwnedSessionWorktree(key);
    }
  },
);

test("sessions.create rejects conflicting, unsupported, and invalid remote project preparation before admission", async () => {
  const root = tempDirs.make("openclaw-session-remote-project-invalid-");
  const workspace = await initializeRepository(root, "workspace");
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  const validRemote = "https://github.com/openclaw/openclaw.git";
  const existing = await createSession({ key: "agent:main:existing-project-session" });

  for (const params of [
    { message: "Start", projectGitUrl: validRemote, projectId: "workspace:main" },
    { message: "Start", projectGitUrl: validRemote, cwd: workspace },
    { projectGitUrl: validRemote },
    { message: "Start", projectGitUrl: "   " },
    { message: "Start", projectGitUrl: "file:///tmp/untrusted-project" },
    { message: "Start", projectGitUrl: "https://token@github.com/openclaw/openclaw.git" },
    { key: existing?.key, message: "Start", projectGitUrl: validRemote },
  ]) {
    const created = await directSessionReq(
      "sessions.create",
      { agentId: "main", ...params },
      controlUiClient,
    );
    expect(created, JSON.stringify(params)).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  }

  expect(projectCloneMocks.materialize).not.toHaveBeenCalled();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
});

test("chat.send visibly rejects corrupt persisted project intent without default-workspace dispatch", async () => {
  const root = tempDirs.make("openclaw-session-remote-project-corrupt-");
  testState.agentConfig = { workspace: await initializeRepository(root, "workspace") };
  const { storePath } = await createSessionStoreDir();
  const created = await createSession({ key: "agent:main:corrupt-project-session" });
  const sessionKey = created.key;
  const entry = readEntry(storePath, sessionKey);
  expect(entry).toBeDefined();
  await replaceSessionEntry(
    { agentId: "main", sessionKey, storePath },
    { ...entry!, pendingProjectGitUrl: "https://token@github.com/openclaw/openclaw.git" },
  );
  const broadcast = vi.fn();
  const context = { broadcast };

  await request(
    "chat.send",
    {
      agentId: "main",
      sessionKey,
      message: "Do not use the default workspace",
      idempotencyKey: "corrupt-project-intent",
    },
    { ...controlUiClient, context },
  );
  await settleWorkspaceRuns(context, storePath, sessionKey);
  expectChatEvent(broadcast, {
    runId: "corrupt-project-intent",
    sessionKey,
    state: "error",
    errorMessage: expect.stringContaining("Saved project repository is invalid"),
  });
  expect(projectCloneMocks.materialize).not.toHaveBeenCalled();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
});

test("sessions.create terminalizes remote project preparation outside a sandboxed agent workspace", async () => {
  const root = tempDirs.make("openclaw-session-remote-project-sandbox-");
  const workspace = await initializeRepository(root, "workspace");
  const outside = await initializeRepository(root, "outside");
  testState.agentConfig = { workspace, sandbox: { mode: "all" } };
  const { storePath } = await createSessionStoreDir();
  const project = await registerProjectRegistry({ path: outside, name: "Outside" });
  const materialization = createDeferredCore<typeof project>();
  projectCloneMocks.materialize.mockReturnValueOnce(materialization.promise);
  const broadcast = vi.fn();
  const context = { broadcast };

  let key: string | undefined;
  try {
    const created = await createRemoteSession(context, {
      message: "Inspect the sandboxed project",
    });
    expect(created.runStarted).toBe(true);
    const { runId } = created;
    key = created.key;
    await vi.waitFor(() => expect(projectCloneMocks.materialize).toHaveBeenCalledOnce());
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();

    materialization.resolve(project);
    await settleWorkspaceRuns(context, storePath, key);
    expectChatEvent(broadcast, {
      runId,
      sessionKey: key,
      state: "error",
      errorMessage: expect.stringContaining(
        "sessions.create project is outside the sandboxed agent workspace",
      ),
    });
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(readEntry(storePath, key)?.projectId).toBe(undefined);
    expect(readEntry(storePath, key)?.status).not.toBe("running");
  } finally {
    materialization.resolve(project);
    await settleWorkspaceRuns(context, storePath, key, true);
  }
});

test.each(["workspace", "registered"])(
  "sessions.create starts in a sandboxed %s project through a workspace alias",
  async (kind) => {
    const root = tempDirs.make("openclaw-session-workspace-project-");
    const workspace = path.join(root, "workspace");
    const alias = path.join(root, "workspace-alias");
    await fs.mkdir(workspace);
    await fs.symlink(workspace, alias, directoryLinkType);
    testState.agentConfig = { workspace: alias, sandbox: { mode: "all" } };
    const { storePath } = await createSessionStoreDir();
    const projectRoot =
      kind === "workspace" ? workspace : await initializeRepository(workspace, "project");
    const projectId =
      kind === "workspace"
        ? "workspace:main"
        : (await registerProjectRegistry({ path: projectRoot })).id;

    const created = await createSession(
      { projectId },
      { client: { connect: { scopes: ["operator.write"] } } as never },
    );
    expect(created?.entry).toMatchObject({
      sessionRoot: projectRoot,
      spawnedCwd: projectRoot,
    });
    expect(loadSessionEntry({ sessionKey: created.key, storePath })).toMatchObject({
      sessionRoot: projectRoot,
      spawnedCwd: projectRoot,
    });
  },
);

test("sessions.create with an empty message preserves its owned checkout above the 100 cleanup target", async () => {
  await withSessionTestState(
    { layout: "state-only", prefix: "openclaw-session-worktree-target-" },
    async (state) => {
      const workspace = await initializeRepository(state.root, "workspace");
      const projectRoot = await initializeRepository(state.root, "project");
      await requireGit(projectRoot, ["tag", "selected-base"]);
      const baseCommit = await requireGit(projectRoot, ["rev-parse", "selected-base"]);
      await fs.writeFile(path.join(projectRoot, "README.md"), "newer project head\n");
      await requireGit(projectRoot, ["commit", "-am", "advance main beyond selected base"]);
      testState.agentConfig = { workspace };
      const { storePath } = await createSessionStoreDir();
      const project = await registerProjectRegistry({ path: projectRoot, name: "Project" });
      const kept = await materializeManagedWorktreeFixtures({
        env: state.env,
        stateDir: state.stateDir,
        repoRoot: workspace,
        names: Array.from({ length: 100 }, (_, index) => `kept-${index}`),
        now: Date.now(),
      });
      const key = "agent:main:worktree-above-cleanup-target";
      const scope = { agentId: "main", sessionKey: key, storePath };
      const originalCreate = captureMethodCall("createWithOutcome")(
        ManagedWorktreeService.prototype,
      );
      using _ = vi
        .spyOn(ManagedWorktreeService.prototype, "createWithOutcome")
        .mockImplementationOnce(async function (this: ManagedWorktreeService, params) {
          const outcome = await originalCreate(this, params);
          const record = outcome.record;
          // GC can run after allocation but before the session row is published.
          expect(loadSessionEntry(scope)).toBeUndefined();
          expect(
            await managedWorktrees.gc(createManagedWorktreeOwnerPolicy(getRuntimeConfig())),
          ).toMatchObject({ removed: [] });
          expect(await managedWorktrees.findLiveByOwner("session", key)).toEqual(record);
          expect(await readReadme(record.path)).toBe("project\n");
          return outcome;
        });
      const created = await request<{
        key: string;
        runStarted: boolean;
        worktree: { id: string; path: string; branch: string };
      }>(
        "sessions.create",
        {
          key,
          agentId: "main",
          message: "",
          projectId: project.id,
          worktree: true,
          worktreeBaseRef: "selected-base",
        },
        controlUiClient,
      );
      expect(created).toMatchObject({ key, runStarted: false });
      const worktree = created.worktree;
      const original = expectDefined(loadSessionEntry(scope), "created project session");
      expect(original).toMatchObject({
        projectId: project.id,
        sessionRoot: worktree.path,
        spawnedCwd: worktree.path,
        worktree: { id: worktree.id, repoRoot: projectRoot, canonicalWorkspaceDir: projectRoot },
      });
      expect(await managedWorktrees.findLiveByOwner("session", key)).toMatchObject({
        id: worktree.id,
        repoRoot: projectRoot,
        baseRef: "selected-base",
      });
      expect(
        await managedWorktrees.gc(createManagedWorktreeOwnerPolicy(getRuntimeConfig())),
      ).toMatchObject({ removed: [] });
      expect(getRegistryWorktree(process.env, worktree.id)).toBeDefined();
      expect(await requireGit(worktree.path, ["rev-parse", "HEAD"])).toBe(baseCommit);
      expect(await requireGit(worktree.path, ["branch", "--show-current"])).toBe(worktree.branch);
      expect(await readReadme(worktree.path)).toBe("project\n");
      expect(await managedWorktrees.listRegistryRecords()).toHaveLength(101);
      for (const record of kept) {
        expect(getRegistryWorktree(process.env, record.id)).toEqual(record);
        expect(await readReadme(record.path)).toBe("workspace\n");
      }
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    },
  );
});

test.each([
  {
    name: "projectId with raw placement",
    params: [
      { projectId: "workspace:main", cwd: "/tmp/repo" },
      { projectId: "workspace:main", execNode: "macbook" },
    ],
    message: "sessions.create projectId cannot be combined with cwd or execNode",
  },
  {
    name: "unknown project",
    params: [{ projectId: "missing" }],
    message: "unknown project id: missing",
  },
])("sessions.create rejects $name", async ({ params, message }) => {
  for (const value of params) {
    expect(await directSessionReq("sessions.create", value)).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message },
    });
  }
});

test("sessions.create reports an unavailable registered project with truthful recovery guidance", async () => {
  const root = tempDirs.make("openclaw-session-stale-project-");
  const repo = await initializeRepository(root, "project");
  const project = await registerProjectRegistry({ path: repo });
  await fs.rm(repo, { recursive: true, force: true });

  const created = await directSessionReq("sessions.create", { projectId: project.id });
  expect(created.ok).toBe(false);
  expect(created.error?.code).toBe("UNAVAILABLE");
  expect(created.error?.message).toMatch(
    /; update the agent workspace path or re-register the project$/u,
  );
});
