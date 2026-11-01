import fs from "node:fs/promises";
import path from "node:path";
import { onTestFinished, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { retainSessionEntryWorkerPublication } from "../../config/sessions/session-accessor.sqlite-entry-worker-publication.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { listManagedImageRecordEntries } from "../managed-image-record-store.js";
import { loadSessionEntryAsync } from "../session-entry-load.test-support.js";
import {
  captureWebchatReplyMediaScope,
  prepareWebchatReplyMediaForDisplay,
} from "./chat-reply-media.js";

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
  await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
  await drainGlobalSingletonLifecycleState();
  await state.cleanup();
});

it.each([
  ["permission", "metadata"],
  ["placement", "content"],
  ["session root", "content"],
  ["spawned cwd", "content"],
  ["spawned workspace", "content"],
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
    setRuntimeConfigSnapshot(cfg);
    const target = {
      sessionKey: SESSION_KEY,
      sessionId: "cross-phase-media-authority",
      agentId: "main",
      storePath: (await loadSessionEntryAsync(SESSION_KEY, { agentId: "main" })).storePath,
    };
    const entry: SessionEntry = {
      sessionId: target.sessionId,
      lifecycleRevision: "initial",
      permissionMode: "full",
      ...(change === "spawned cwd"
        ? { spawnedCwd: selected }
        : change === "spawned workspace"
          ? { spawnedWorkspaceDir: selected }
          : { sessionRoot: selected }),
      updatedAt: 1,
    };
    await replaceSessionEntry(target, entry);
    const scope = await captureWebchatReplyMediaScope({
      cfg,
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionLoadOptions: { agentId: "main" },
    });
    expect(scope.workspace).toEqual({ remote: false, workspaceDir: selected });
    onTestFinished(scope.release);
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
          ...(change === "session root" ? { sessionRoot: workspace } : {}),
          ...(change === "spawned cwd" ? { spawnedCwd: workspace } : {}),
          ...(change === "spawned workspace" ? { spawnedWorkspaceDir: workspace } : {}),
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
  const cfg: OpenClawConfig = {};
  setRuntimeConfigSnapshot(cfg);
  const scope = await captureWebchatReplyMediaScope({
    cfg,
    agentId: "main",
    sessionKey: SESSION_KEY,
  });
  onTestFinished(scope.release);
  const controller = new AbortController();
  controller.abort();
  const { assistantContent } = await prepareWebchatReplyMediaForDisplay({
    scope,
    abortSignal: controller.signal,
    inputs: [{ kind: "raw", payload: { text: "Completed before cancellation." } }],
  });
  expect(assistantContent).toEqual([{ type: "text", text: "Completed before cancellation." }]);
});

it("joins a publication staged after media authority was captured", async () => {
  const target = {
    sessionKey: SESSION_KEY,
    agentId: "main",
    storePath: (await loadSessionEntryAsync(SESSION_KEY, { agentId: "main" })).storePath,
  };
  await replaceSessionEntry(target, {
    sessionId: "media-publication",
    lifecycleRevision: "initial",
    updatedAt: 1,
  });
  const scope = await captureWebchatReplyMediaScope({
    cfg: {},
    agentId: "main",
    sessionKey: SESSION_KEY,
  });
  onTestFinished(scope.release);
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const identity = readOpenClawAgentDatabaseIdentity(database).identity;
  if (typeof identity !== "string") {
    throw new Error("Expected durable session store");
  }
  const publication = retainSessionEntryWorkerPublication({
    ...target,
    databaseIdentity: identity,
  });
  publication.begin([SESSION_KEY], []);
  const delivery = prepareWebchatReplyMediaForDisplay({
    scope,
    inputs: [{ kind: "raw", payload: { text: "Completed reply." } }],
  });
  try {
    // The pending writer rolls back; its retained policy facts remain authoritative.
    publication.settle(undefined, false);
    await expect(delivery).resolves.toMatchObject({
      assistantContent: [{ type: "text", text: "Completed reply." }],
    });
  } finally {
    publication.settle(undefined, false);
  }
});
