import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../../config/sessions/session-incognito-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withChannelReadAuthority } from "../../shared/channel-read-authority.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { listManagedImageRecordEntries } from "../managed-image-record-store.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { loadSessionEntry } from "../session-utils.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import {
  captureWebchatReplyMediaScope,
  prepareWebchatReplyMediaForDisplay,
} from "./chat-reply-media.js";
import { createChatSendReplyFinalizationAuthority } from "./chat-send-delivery-authority.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
const AUDIO_BYTES = Buffer.from([0xff, 0xfb, 0x90, 0]);
const SESSION_KEY = "agent:main:webchat:direct:media-authority";

let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
  setRuntimeConfigSnapshot({});
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
  await drainGlobalSingletonLifecycleState();
  await state.cleanup();
});

it.each([
  ["permission", "metadata"],
  ["placement", "content"],
  ["abort", "content"],
] as const)(
  "cleans earlier image files and records when %s changes during audio %s preparation",
  async (change, phase) => {
    const selected = state.statePath("worktrees", "selected");
    const workspace = state.statePath("workspace");
    const outbound = state.statePath("media", "outbound");
    const originals = state.statePath("media", "outgoing", "originals");
    for (const directory of [selected, workspace, outbound, originals]) {
      await fs.mkdir(directory, { recursive: true });
    }
    const imageSource = path.join(selected, "chart.png");
    const audioSource = path.join(workspace, "speech.mp3");
    await fs.writeFile(imageSource, PNG_BYTES);
    await fs.writeFile(audioSource, AUDIO_BYTES);
    const cfg: OpenClawConfig = {
      tools: { allow: ["read"], fs: { workspaceOnly: true } },
      agents: { entries: { main: { workspace } } },
    };
    const target = {
      sessionKey: SESSION_KEY,
      sessionId: "cross-phase-media-authority",
      agentId: "main",
      storePath: loadSessionEntry(SESSION_KEY, { agentId: "main" }).storePath,
    };
    const entry: SessionEntry = {
      sessionId: target.sessionId,
      lifecycleRevision: "initial",
      permissionMode: "full",
      sessionRoot: selected,
      updatedAt: 1,
    };
    await replaceSessionEntry(target, entry);
    const scope = captureWebchatReplyMediaScope({
      cfg,
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionLoadOptions: { agentId: "main" },
    });
    const opened = createDeferred();
    const release = createDeferred();
    const audioReadCounts: Array<() => number> = [];
    const nativeOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await nativeOpen(...args);
      if (String(args[0]) === audioSource) {
        const read = vi.spyOn(handle, "read");
        audioReadCounts.push(() => read.mock.calls.length);
        if (audioReadCounts.length === (phase === "metadata" ? 1 : 2)) {
          opened.resolve();
          await release.promise;
        }
      }
      return handle;
    });
    const controller = new AbortController();
    const delivery = prepareWebchatReplyMediaForDisplay({
      scope,
      abortSignal: controller.signal,
      inputs: [
        { kind: "raw", payload: { mediaUrls: [imageSource] } },
        { kind: "raw", payload: { mediaUrls: [audioSource], trustedLocalMedia: true } },
      ],
    });
    const settled = delivery.then(
      () => undefined,
      () => undefined,
    );
    let authorityChanged = false;
    try {
      await opened.promise;
      const staged = await fs.readdir(outbound);
      expect(staged).toHaveLength(1);
      expect(await fs.readFile(path.join(outbound, staged[0]!))).toEqual(PNG_BYTES);
      const records = await listManagedImageRecordEntries({ stateDir: state.stateDir });
      expect(records).toHaveLength(phase === "content" ? 1 : 0);
      expect(await fs.readdir(originals)).toHaveLength(phase === "content" ? 1 : 0);
      if (change === "abort") {
        controller.abort();
      } else {
        await replaceSessionEntry(target, {
          ...entry,
          ...(change === "permission" ? { permissionMode: "workspace" } : {}),
          ...(change === "placement" ? { execNode: "remote-test-node" } : {}),
        });
      }
      authorityChanged = true;
    } finally {
      if (!authorityChanged) {
        controller.abort();
      }
      release.resolve();
      await settled;
    }
    await expect(delivery).rejects.toThrow(
      change === "abort" ? "aborted" : "Session media access changed",
    );
    expect(audioReadCounts.length).toBeGreaterThan(0);
    expect(audioReadCounts.reduce((total, count) => total + count(), 0)).toBe(0);
    expect(await fs.readdir(outbound)).toEqual([]);
    expect(await fs.readdir(originals)).toEqual([]);
    expect(await listManagedImageRecordEntries({ stateDir: state.stateDir })).toEqual([]);
    expect(await fs.readFile(imageSource)).toEqual(PNG_BYTES);
    expect(await fs.readFile(audioSource)).toEqual(AUDIO_BYTES);
  },
);

it("preserves already-produced text after its turn is aborted", async () => {
  const scope = captureWebchatReplyMediaScope({
    cfg: {},
    agentId: "main",
    sessionKey: SESSION_KEY,
  });
  const controller = new AbortController();
  controller.abort();
  const { assistantContent } = await prepareWebchatReplyMediaForDisplay({
    scope,
    abortSignal: controller.signal,
    inputs: [{ kind: "raw", payload: { text: "Completed before cancellation." } }],
  });
  expect(assistantContent).toEqual([{ type: "text", text: "Completed before cancellation." }]);
});

it.each([
  ["permission", "read", false],
  ["placement", "read", true],
  ["placement", "acceptance", false],
  ["unchanged", "acceptance", false],
] as const)(
  "retains the selected actor when %s is checked during media %s",
  async (change, phase, differentRoot) => {
    const actor = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: "main",
      env: state.env,
      authority: { assertCurrent() {} },
    });
    assert(actor);
    const sessionKey = "agent:main:dashboard:incognito-media-authority";
    const workspace = state.workspaceDir;
    await fs.mkdir(workspace, { recursive: true });
    const mediaSource = path.join(workspace, phase === "read" ? "retained.mp3" : "retained.png");
    await fs.writeFile(mediaSource, phase === "read" ? AUDIO_BYTES : PNG_BYTES);
    await actor.sessions.create(
      { assertCurrent() {} },
      {
        sessionKey,
        entry: {
          sessionId: "retained-media",
          updatedAt: 1,
          incognito: true,
          permissionMode: "full",
          sessionRoot: workspace,
        },
      },
    );
    const opened = createDeferred();
    const release = createDeferred();
    const nativeOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await nativeOpen(...args);
      if (phase === "read" && String(args[0]) === mediaSource) {
        opened.resolve();
        await release.promise;
      }
      return handle;
    });
    const placements = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
    const ambient = differentRoot
      ? await createOpenClawTestState({ layout: "state-only", applyEnv: false })
      : undefined;
    if (ambient) {
      openOpenClawStateDatabase({ env: ambient.env });
    }
    const sql = observeHostDataSql();
    try {
      const run = () =>
        withIncognitoSessionActor(actor, async () => {
          const scope = captureWebchatReplyMediaScope({
            cfg: { agents: { entries: { main: { workspace } } } },
            agentId: "main",
            sessionKey,
            sessionLoadOptions: { agentId: "main" },
          });
          const changeAuthority = async () => {
            if (change === "permission") {
              await patchSessionEntryCore(
                { agentId: "main", env: state.env, storePath: actor.path, sessionKey },
                () => ({ permissionMode: "workspace" }),
              );
            } else if (change === "placement") {
              await placements.startDispatch({
                agentId: "main",
                sessionKey,
                sessionId: "retained-media",
                executionMode: "worker-turn",
              });
            }
          };
          const prepared = withChannelReadAuthority(
            () => {},
            async () => {
              const result = await prepareWebchatReplyMediaForDisplay({
                scope,
                inputs: [
                  { kind: "raw", payload: { mediaUrls: [mediaSource], trustedLocalMedia: true } },
                ],
              });
              if (phase === "acceptance") {
                await changeAuthority();
              }
              return result;
            },
          );
          const settled = prepared.catch(() => undefined);
          try {
            if (phase === "read") {
              await opened.promise;
              await changeAuthority();
            }
          } finally {
            release.resolve();
            await settled;
          }
          if (change === "unchanged") {
            await expect(prepared).resolves.toMatchObject({
              persistedAssistantContent: [expect.objectContaining({ type: "image" })],
            });
          } else {
            await expect(prepared).rejects.toThrow("Session media access changed");
          }
        });
      if (ambient) {
        await withEnvAsync(ambient.envVars, run);
      } else {
        await run();
      }
      expect(sql.queries).toEqual([]);
    } finally {
      release.resolve();
      sql.restore();
      await actor.close();
      await ambient?.cleanup();
    }
  },
);

it("keeps explicit actor absence out of native media discovery", () => {
  const sql = observeHostDataSql();
  try {
    expect(() =>
      withIncognitoSessionBinding(
        {
          kind: "absent",
          agentId: "main",
          env: state.env,
          authority: { assertCurrent() {} },
        },
        () =>
          captureWebchatReplyMediaScope({
            cfg: {},
            agentId: "main",
            sessionKey: "agent:main:dashboard:incognito-missing-media",
            sessionLoadOptions: { agentId: "main", env: state.env },
          }),
      ),
    ).toThrow("No incognito session owner");
    expect(sql.queries).toEqual([]);
    expect(captureOpenClawAgentDatabaseExecution.listIncognito(state.env)).toEqual([]);
  } finally {
    sql.restore();
  }
});

it("revokes untagged text finalization when its captured session rotates or actor closes", async () => {
  const actor = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env: state.env,
    authority: { assertCurrent() {} },
  });
  assert(actor);
  const sessionKey = "agent:main:dashboard:incognito-text-finalization";
  await actor.sessions.create(
    { assertCurrent() {} },
    {
      sessionKey,
      entry: {
        sessionId: "text-finalization",
        lifecycleRevision: "initial",
        updatedAt: 1,
        incognito: true,
      },
    },
  );
  const sql = observeHostDataSql();
  try {
    const capture = () =>
      withIncognitoSessionBinding({ actor }, () =>
        createChatSendReplyFinalizationAuthority(
          {
            accountId: undefined,
            context: createDirectChatContext(),
            terminalEntry: undefined,
            emitFirstAssistantServerTiming() {},
            session: {
              agentId: "main",
              backingSessionId: "text-finalization",
              cfg: {},
              clientRunId: "text-finalization-run",
              sessionKey,
              sessionLoadOptions: { agentId: "main", env: state.env },
            },
          },
          [{ text: "Already prepared text" }],
        ),
      );
    const original = capture();
    expect(original.deliveryAuthorized()).toBe(true);
    await withIncognitoSessionActor(actor, () =>
      patchSessionEntryCore(
        { agentId: "main", env: state.env, storePath: actor.path, sessionKey },
        () => ({ lifecycleRevision: "rotated" }),
      ),
    );
    expect(original.deliveryAuthorized).toThrow("generation is no longer current");
    const current = capture();
    expect(current.deliveryAuthorized()).toBe(true);
    await actor.close();
    expect(current.deliveryAuthorized).toThrow("Incognito session ended");
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
    await actor.close();
  }
});

it("keeps unbound private media scope on the native owner without acquiring an actor", async () => {
  const sessionKey = "agent:main:dashboard:incognito-native-media";
  await replaceSessionEntry(
    {
      sessionKey,
      agentId: "main",
      env: state.env,
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    },
    {
      sessionId: "native-private-media",
      updatedAt: 1,
      incognito: true,
      permissionMode: "workspace",
      sessionRoot: state.workspaceDir,
    },
  );
  expect(captureOpenClawAgentDatabaseExecution.listIncognito(state.env)).toEqual([]);
  const scope = captureWebchatReplyMediaScope({
    cfg: {},
    agentId: "main",
    sessionKey,
    sessionLoadOptions: { agentId: "main", env: state.env },
  });
  expect(scope.sessionEntry?.sessionId).toBe("native-private-media");
  expect(scope.workspace).toEqual({ remote: false, workspaceDir: state.workspaceDir });
  expect(() => scope.assertCurrent()).not.toThrow();
  expect(captureOpenClawAgentDatabaseExecution.listIncognito(state.env)).toEqual([]);
});
