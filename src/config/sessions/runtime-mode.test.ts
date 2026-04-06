import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config.js";
import { loadSessionStore, saveSessionStore } from "../sessions.js";
import {
  getSessionPlanState,
  getSessionRuntimeMode,
  setSessionRuntimeMode,
  updateSessionPlanState,
} from "./runtime-mode.js";

function createTempStorePath() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-runtime-mode-"));
  return {
    root,
    storePath: path.join(root, "sessions.json"),
  };
}

describe("session runtime mode helpers", () => {
  const tempDirs = new Set<string>();

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("defaults missing sessions to auto mode", () => {
    const { root, storePath } = createTempStorePath();
    tempDirs.add(root);
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    expect(getSessionRuntimeMode("agent:main:main", cfg)).toBe("auto");
    expect(getSessionPlanState("agent:main:main", cfg)).toBeUndefined();
  });

  it("persists top-level runtime mode for non-ACP sessions", async () => {
    const { root, storePath } = createTempStorePath();
    tempDirs.add(root);
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const updated = await setSessionRuntimeMode("agent:main:main", "plan", cfg);

    expect(updated?.runtimeMode).toBe("plan");
    expect(getSessionRuntimeMode("agent:main:main", cfg)).toBe("plan");

    const store = loadSessionStore(storePath);
    expect(store["agent:main:main"]).toMatchObject({
      runtimeMode: "plan",
    });
  });

  it("mirrors ACP runtime mode and stores plan state updates", async () => {
    const { root, storePath } = createTempStorePath();
    tempDirs.add(root);
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    await saveSessionStore(storePath, {
      "agent:main:main": {
        sessionId: "session-1",
        updatedAt: 1,
        acp: {
          backend: "codex",
          agent: "main",
          runtimeSessionName: "runtime-1",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 1,
          runtimeOptions: {
            runtimeMode: "auto",
          },
        },
      },
    });

    await setSessionRuntimeMode("agent:main:main", "plan", cfg);
    const state = await updateSessionPlanState({
      sessionKey: "agent:main:main",
      cfg,
      mutate: () => ({
        content: "1. Draft\n2. Confirm",
        todos: [
          {
            id: "todo-1",
            text: "Draft the implementation plan",
            status: "in_progress",
          },
        ],
        enteredAt: 10,
        updatedAt: 11,
      }),
    });

    expect(state?.runtimeMode).toBe("plan");
    expect(state?.planState).toEqual({
      content: "1. Draft\n2. Confirm",
      todos: [
        {
          id: "todo-1",
          text: "Draft the implementation plan",
          status: "in_progress",
        },
      ],
      enteredAt: 10,
      updatedAt: 11,
    });

    const store = loadSessionStore(storePath);
    expect(store["agent:main:main"]).toMatchObject({
      runtimeMode: "plan",
      planState: {
        content: "1. Draft\n2. Confirm",
      },
      acp: {
        runtimeOptions: {
          runtimeMode: "plan",
        },
      },
    });
  });
});
