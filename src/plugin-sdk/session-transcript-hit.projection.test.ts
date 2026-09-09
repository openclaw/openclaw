import { expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadCombinedSessionStoreForGateway } from "./session-transcript-hit.js";

it.each([
  {
    name: "all agents",
    options: {},
    expectedKeys: ["agent:main:visible", "agent:research:visible", "agent:retired:visible"],
  },
  {
    name: "one requested agent",
    options: { agentId: "main" },
    expectedKeys: ["agent:main:visible"],
  },
  {
    name: "configured agents",
    options: { configuredAgentsOnly: true },
    expectedKeys: ["agent:main:visible", "agent:research:visible"],
  },
])("returns complete non-incognito entries for $name", async ({ options, expectedKeys }) => {
  await withOpenClawTestState({ label: "plugin-transcript-projection" }, async () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { default: true }, research: {} } },
    };
    const skillsSnapshot = {
      prompt: "Saved plugin skill instructions",
      skills: [{ name: "plugin-fixture" }],
    };
    const systemPromptReport: NonNullable<SessionEntry["systemPromptReport"]> = {
      source: "run",
      generatedAt: 7,
      systemPrompt: { chars: 83, projectContextChars: 31, nonProjectContextChars: 52 },
      injectedWorkspaceFiles: [],
      skills: { promptChars: 30, entries: [{ name: "plugin-fixture", blockChars: 30 }] },
      tools: { listChars: 11, schemaChars: 19, entries: [] },
    };
    for (const agentId of ["main", "research", "retired"]) {
      replaceSessionEntrySync(
        { agentId, sessionKey: `agent:${agentId}:visible` },
        {
          sessionId: `${agentId}-visible`,
          updatedAt: 7,
          skillsSnapshot,
          systemPromptReport,
        },
      );
    }
    const incognitoScope = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-private",
    };
    replaceSessionEntrySync(incognitoScope, {
      sessionId: "private-session",
      updatedAt: 9,
      incognito: true,
      skillsSnapshot: { prompt: "Private plugin instructions", skills: [] },
      systemPromptReport,
    });
    expect(loadSessionEntry(incognitoScope)).toMatchObject({
      sessionId: "private-session",
      incognito: true,
    });

    const { store } = loadCombinedSessionStoreForGateway(cfg, options);

    expect(Object.keys(store).toSorted()).toEqual(expectedKeys);
    for (const entry of Object.values(store)) {
      expect.soft(entry.skillsSnapshot).toEqual(skillsSnapshot);
      expect.soft(entry.systemPromptReport).toEqual(systemPromptReport);
    }
  });
});
