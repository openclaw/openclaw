import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getLogger } from "../../logging/logger.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { purgeAgentSessionStoreEntries } from "./cleanup-service.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  replaceSessionEntry,
} from "./session-accessor.js";
import { appendTranscriptEventSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await state.cleanup();
});
const store = (name: string) => {
  const storePath = state.statePath(name);
  return { storePath, cfg: { session: { store: storePath } } };
};

it.each(["fixed selector", "retired schema owner"])(
  "purges only the deleted agent's state with a %s",
  async (kind) => {
    const storePath = state.statePath(kind === "fixed selector" ? "shared.json" : "shared.sqlite");
    const cfg = {
      agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
      session: { store: storePath },
    } satisfies Parameters<typeof purgeAgentSessionStoreEntries>[0];
    await state.writeConfig(cfg);
    if (kind === "retired schema owner") {
      openOpenClawAgentDatabase({ agentId: "retired", path: storePath });
    }
    const scopes = ["main", "ops"].map((agentId) => ({
      agentId,
      sessionId: `${agentId}-session`,
      sessionKey: `agent:${agentId}:chat`,
      storePath,
    }));
    for (const scope of scopes) {
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
      appendTranscriptEventSync(scope, { type: "proof", data: scope.agentId });
    }

    await expect(purgeAgentSessionStoreEntries(cfg, "ops")).resolves.toBe(false);

    expect(loadSessionEntry(scopes[0]!)).toMatchObject({ sessionId: "main-session" });
    expect(loadTranscriptEventsSync(scopes[0]!)).toEqual([{ type: "proof", data: "main" }]);
    expect(loadSessionEntry(scopes[1]!)).toBeUndefined();
    expect(loadTranscriptEventsSync(scopes[1]!)).toEqual([]);
    if (kind === "fixed selector") {
      expect(fs.existsSync(storePath)).toBe(false);
    }
  },
);

it("treats an absent store as an already successful purge", async () => {
  const { storePath, cfg } = store("absent.json");
  await expect(purgeAgentSessionStoreEntries(cfg, "ops")).resolves.toBe(false);
  expect(
    fs.existsSync(resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "ops" }).path),
  ).toBe(false);
  expect(fs.existsSync(storePath)).toBe(false);
});

it("records a bounded warning and failure fact when storage purge fails", async () => {
  const { storePath, cfg } = store("corrupt.sqlite");
  fs.writeFileSync(storePath, "not a sqlite database");
  const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
  const onFailure = vi.fn();

  await expect(purgeAgentSessionStoreEntries(cfg, "ops", { onFailure })).resolves.toBe(true);

  const failure = {
    path: storePath,
    reason: expect.stringMatching(/purge session entries:.*not a database/i),
  };
  expect(onFailure).toHaveBeenCalledWith(failure);

  expect(warn).toHaveBeenCalledWith("session store purge failed during agent deletion", {
    agentId: "ops",
    error: expect.any(Error),
    storePath,
    ...failure,
  });
});
