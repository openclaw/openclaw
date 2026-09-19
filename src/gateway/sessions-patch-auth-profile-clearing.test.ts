import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../sessions/model-overrides.js";
import { projectSessionsPatchEntry } from "./sessions-patch.js";

const MAIN_SESSION_KEY = "agent:main:main";
const OPENAI_GPT_ID = "gpt-5.4";
const EMPTY_CFG = {} as OpenClawConfig;

type Patch = Parameters<typeof projectSessionsPatchEntry>[0]["patch"];
type PatchResult = Awaited<ReturnType<typeof projectSessionsPatchEntry>>;

async function runPatch(patch: Patch, existingEntry?: SessionEntry): Promise<PatchResult> {
  return projectSessionsPatchEntry({
    cfg: EMPTY_CFG,
    existingEntry,
    isLabelInUse: () => false,
    storeKey: MAIN_SESSION_KEY,
    patch,
  });
}

function expectPatchOk(result: PatchResult): SessionEntry {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.entry;
}

function expectPatchError(result: PatchResult, message: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(`Expected patch failure containing: ${message}`);
  }
  expect(result.error.message).toContain(message);
}

function sessionEntry(overrides: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "sess",
    updatedAt: 1,
    ...overrides,
  } as SessionEntry;
}

describe("session patch auth profile clearing", () => {
  test("clears the saved auth profile selection", async () => {
    const entry = expectPatchOk(
      await runPatch(
        { key: MAIN_SESSION_KEY, authProfileId: null },
        sessionEntry({
          sessionId: "sess-clear-auth-profile",
          authProfileOverride: "openai:old",
          authProfileOverrideSource: "user",
          authProfileOverrideCompactionCount: 3,
          modelFallback: {
            prevModel: OPENAI_GPT_ID,
            prevProvider: "openai",
            prevAuthProfileOverride: "openai:old",
            prevAuthProfileOverrideSource: "user",
            prevAuthProfileOverrideCompactionCount: 3,
            ts: 1,
            source: "agent-patch",
          },
        }),
      ),
    );

    expect(entry.authProfileOverride).toBeUndefined();
    expect(entry.authProfileOverrideSource).toBeUndefined();
    expect(entry.authProfileOverrideCompactionCount).toBeUndefined();
    expect(entry.liveModelSwitchPending).toBe(true);
    expect(entry.modelFallback).not.toHaveProperty("prevAuthProfileOverride");
    expect(entry.modelFallback).not.toHaveProperty("prevAuthProfileOverrideSource");
    expect(entry.modelFallback).not.toHaveProperty("prevAuthProfileOverrideCompactionCount");
  });

  test("rejects clearing and selecting an auth profile together", async () => {
    const result = await runPatch({
      key: MAIN_SESSION_KEY,
      authProfileId: null,
      model: "openai/gpt-5.6@openai:new",
    });

    expectPatchError(result, "cannot clear and select an auth profile in the same patch");
  });

  test("rejects auth profile clearing for model-locked sessions", async () => {
    const result = await runPatch(
      { key: MAIN_SESSION_KEY, authProfileId: null },
      sessionEntry({
        modelSelectionLocked: true,
        authProfileOverride: "openai:locked",
        authProfileOverrideSource: "user",
      }),
    );

    expectPatchError(result, MODEL_SELECTION_LOCKED_MESSAGE);
  });
});
