import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { onTestFinished, beforeEach, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { retainSessionEntryWorkerPublication } from "../../config/sessions/session-accessor.sqlite-entry-worker-publication.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { listManagedImageRecordEntries } from "../managed-image-record-store.js";
import { loadSessionEntryAsync } from "../session-entry-load.test-support.js";
import {
  AUDIO_BYTES,
  PNG_BYTES,
  gateMediaOpen,
  useMediaState,
  writeMedia,
} from "./chat-media-fixture.test-support.js";
import {
  captureWebchatReplyMediaScope,
  prepareWebchatReplyMediaForDisplay,
} from "./chat-reply-media.js";

const SESSION_KEY = "agent:main:webchat:direct:media-authority";
const session = { agentId: "main", sessionKey: SESSION_KEY };

let state: OpenClawTestState;
const getState = useMediaState(true);

beforeEach(() => {
  state = getState();
  setRuntimeConfigSnapshot({});
});

async function captureScope(cfg: OpenClawConfig = {}) {
  const scope = await captureWebchatReplyMediaScope({ ...session, cfg });
  onTestFinished(scope.release);
  return scope;
}

it.each([
  ["permissionMode", "metadata"],
  ["execNode", "content"],
  ["sessionRoot", "content"],
  ["spawnedCwd", "content"],
  ["spawnedWorkspaceDir", "content"],
  ["abort", "content"],
] as const)(
  "cleans earlier image files and records when %s changes during audio %s preparation",
  async (change, phase) => {
    const selected = state.statePath("worktrees", "selected");
    const workspace = state.statePath("workspace");
    const outbound = state.statePath("media", "outbound");
    const originals = state.statePath("media", "outgoing", "originals");
    for (const directory of [outbound, originals]) {
      await fs.mkdir(directory, { recursive: true });
    }
    const imageSource = await writeMedia(path.join(selected, "chart.png"));
    const audioSource = await writeMedia(path.join(workspace, "speech.mp3"), AUDIO_BYTES);
    const cfg: OpenClawConfig = {
      tools: { allow: ["read"], fs: { workspaceOnly: true } },
      agents: { entries: { main: { workspace } } },
    };
    setRuntimeConfigSnapshot(cfg);
    const target = {
      ...session,
      storePath: (await loadSessionEntryAsync(SESSION_KEY, { agentId: "main" })).storePath,
    };
    const entry: SessionEntry = {
      sessionId: "cross-phase-media-authority",
      lifecycleRevision: "initial",
      permissionMode: "full",
      [change === "spawnedCwd" || change === "spawnedWorkspaceDir" ? change : "sessionRoot"]:
        selected,
      updatedAt: 1,
    };
    await replaceSessionEntry(target, entry);
    const scope = await captureScope(cfg);
    expect(scope.workspace).toEqual({ remote: false, workspaceDir: selected });
    const gate = gateMediaOpen(audioSource, phase === "metadata" ? 1 : 2);
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
      await gate.opened;
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
          [change]:
            change === "permissionMode"
              ? "workspace"
              : change === "execNode"
                ? "remote-test-node"
                : workspace,
        });
      }
      authorityChanged = true;
    } finally {
      if (!authorityChanged) {
        controller.abort();
      }
      gate.release();
      await settled;
    }
    await expect(delivery).rejects.toThrow(
      change === "abort" ? "aborted" : "Session media access changed",
    );
    gate.assertUnread();
    expect(await fs.readdir(outbound)).toEqual([]);
    expect(await fs.readdir(originals)).toEqual([]);
    expect(await listManagedImageRecordEntries({ stateDir: state.stateDir })).toEqual([]);
    expect(await fs.readFile(imageSource)).toEqual(PNG_BYTES);
    expect(await fs.readFile(audioSource)).toEqual(AUDIO_BYTES);
  },
);

it("preserves already-produced text after its turn is aborted", async () => {
  const scope = await captureScope();
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
    ...session,
    storePath: (await loadSessionEntryAsync(SESSION_KEY, { agentId: "main" })).storePath,
  };
  await replaceSessionEntry(target, {
    sessionId: "media-publication",
    lifecycleRevision: "initial",
    updatedAt: 1,
  });
  const scope = await captureScope();
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const identity = readOpenClawAgentDatabaseIdentity(database).identity;
  assert(typeof identity === "string", "Expected durable session store");
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
