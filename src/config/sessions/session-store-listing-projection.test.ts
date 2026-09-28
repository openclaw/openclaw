import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
import { validateAcpResumeSessionOwnership } from "../../agents/subagents/spawn/acp-spawn-requester.js";
import { resolveMemorySessionTargets } from "../../plugin-sdk/memory-core-host-engine-sessions.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { formatSqliteSessionFileMarker } from "./legacy-sqlite-marker.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import { listSessionTranscriptInstances } from "./session-accessor.sqlite-entry.js";
import type { SessionEntry } from "./types.js";

// Whole-store listings that only read identity/metadata must not materialize every row's
// saved skills prompt. These tests count JSON.parse results that carry a prompt, so a listing
// that silently falls back to the "full" projection shows up as a store-size-dependent count.

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

const PROMPT = "skill catalog entry ".repeat(128);

function seedStore(count: number): string {
  const tempDir = tempDirs.make("openclaw-listing-projection-");
  const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  const base = Date.now() - 60_000;
  for (let index = 0; index < count; index += 1) {
    replaceSessionEntrySync({ sessionKey: `agent:main:listing-${index}`, storePath }, {
      sessionId: `listing-${index}`,
      updatedAt: base + index,
      skillsSnapshot: { prompt: PROMPT, skills: [{ name: `skill-${index}` }] },
    } as unknown as SessionEntry);
  }
  return storePath;
}

// The first read on a fresh connection runs the one-time canonical-key validation scan, which
// parses every row's complete entry_json. Warm it before counting so the assertions measure the
// listing itself, the way a long-lived gateway process experiences it.
function warmCanonicalValidation(storePath: string): void {
  listSessionTranscriptInstances(
    { agentId: "main", storePath, clone: false, projection: "list" },
    { includeAllWindows: true },
  );
}

async function countPromptParses<T>(
  run: () => Promise<T> | T,
): Promise<{ result: T; promptParses: number }> {
  const originalParse = JSON.parse;
  let promptParses = 0;
  const spy = vi.spyOn(JSON, "parse").mockImplementation(((
    text: string,
    reviver?: (this: unknown, key: string, value: unknown) => unknown,
  ) => {
    const parsed: unknown = originalParse.call(JSON, text, reviver);
    const prompt = (parsed as { skillsSnapshot?: { prompt?: unknown } } | null)?.skillsSnapshot
      ?.prompt;
    if (typeof prompt === "string") {
      promptParses += 1;
    }
    return parsed;
  }) as typeof JSON.parse);
  try {
    const result = await run();
    return { result, promptParses };
  } finally {
    spy.mockRestore();
  }
}

it("resolves a legacy sqlite marker without parsing the store's saved prompts", async () => {
  const resolveFor = async (count: number) => {
    const storePath = seedStore(count);
    warmCanonicalValidation(storePath);
    const config = { session: { store: storePath } } as OpenClawConfig;
    return await countPromptParses(() =>
      resolveAgentRunSessionTarget({
        agentId: "main",
        config,
        missingSessionKey: "create",
        sessionId: "listing-1",
        sessionFile: formatSqliteSessionFileMarker({
          agentId: "main",
          sessionId: "listing-1",
          storePath,
        }),
      }),
    );
  };
  const small = await resolveFor(3);
  const large = await resolveFor(40);
  expect(small.result.sessionKey).toBe("agent:main:listing-1");
  expect(large.result.sessionKey).toBe("agent:main:listing-1");
  // A full-projection listing would parse one prompt per row (40 here).
  expect(large.promptParses).toBe(small.promptParses);
  expect(large.promptParses).toBeLessThan(3);
});

it("lists transcript instances at the list projection without prompts, keeping full on request", async () => {
  const storePath = seedStore(12);
  warmCanonicalValidation(storePath);
  // Freshly written sessions have no transcript yet; list every window so rows are returned.
  const listed = await countPromptParses(() =>
    listSessionTranscriptInstances(
      { agentId: "main", storePath, clone: false, projection: "list" },
      { includeAllWindows: true },
    ),
  );
  expect(listed.result.length).toBeGreaterThanOrEqual(12);
  expect(listed.result.every((instance) => instance.entry.skillsSnapshot === undefined)).toBe(true);
  expect(listed.promptParses).toBe(0);

  const full = listSessionTranscriptInstances(
    { agentId: "main", storePath, clone: false },
    { includeAllWindows: true },
  );
  expect(full.some((instance) => instance.entry.skillsSnapshot?.prompt === PROMPT)).toBe(true);
});

it("scans ACP resume ownership without parsing saved prompts", async () => {
  const storePath = seedStore(25);
  warmCanonicalValidation(storePath);
  // No stored session records this resume id, so the scan walks every row before refusing.
  const { result, promptParses } = await countPromptParses(() =>
    validateAcpResumeSessionOwnership({
      cfg: { session: { store: storePath } } as OpenClawConfig,
      targetAgentId: "main",
      requesterSessionKey: "agent:main:listing-0",
      resumeSessionId: "unrecorded-resume-id",
    }),
  );
  expect(result.ok).toBe(false);
  // The listing and the per-row ACP metadata lookup must both stay metadata-only.
  expect(promptParses).toBe(0);
});

it("resolves memory session targets without parsing saved prompts", async () => {
  const storePath = seedStore(25);
  warmCanonicalValidation(storePath);
  const { promptParses } = await countPromptParses(() =>
    resolveMemorySessionTargets({ agentId: "main", storePath, sessionIds: ["listing-9"] }),
  );
  expect(promptParses).toBe(0);
});
