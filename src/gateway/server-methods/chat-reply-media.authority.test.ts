import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { listManagedImageRecordEntries } from "../managed-image-record-store.js";
import { loadSessionEntry } from "../session-utils.js";
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
});

afterEach(async () => {
  vi.restoreAllMocks();
  await drainGlobalSingletonLifecycleState();
  await state.cleanup();
});

it.each([
  ["permission", "metadata"],
  ["permission", "content"],
  ["placement", "metadata"],
  ["placement", "content"],
  ["abort", "metadata"],
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
      agents: { list: [{ id: "main", workspace }] },
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
    const deliverySettled = delivery.then(
      () => undefined,
      () => undefined,
    );
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
    } finally {
      release.resolve();
      await deliverySettled;
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
