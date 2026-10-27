import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";

export const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
export const AUDIO_BYTES = Buffer.from([0xff, 0xfb, 0x90, 0]);

export function useMediaState(cleanSessions = false) {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ layout: "state-only" });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (cleanSessions) {
      await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
    }
    await drainGlobalSingletonLifecycleState();
    await state.cleanup();
  });
  return () => state;
}

export async function writeMedia(source: string, bytes = PNG_BYTES) {
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, bytes);
  return source;
}

export function gateMediaOpen(source: string, atOpen?: number) {
  const opened = createDeferred();
  const release = createDeferred();
  const reads: Array<() => number> = [];
  const open = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === source) {
      const read = vi.spyOn(handle, "read");
      reads.push(() => read.mock.calls.length);
      if (atOpen === undefined || reads.length === atOpen) {
        opened.resolve();
        await release.promise;
      }
    }
    return handle;
  });
  return {
    opened: opened.promise,
    release: release.resolve,
    assertUnread: () => {
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.reduce((count, read) => count + read(), 0)).toBe(0);
    },
  };
}
