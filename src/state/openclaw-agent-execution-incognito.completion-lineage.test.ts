import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import { resolvePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import { createCompletionGrantLineageAdmission } from "../gateway/tool-resolution-completion.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";

// Exercise acquisition at the broker's two-worker floor.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 8,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
let env: NodeJS.ProcessEnv;
let actor: IncognitoAgentDatabaseExecution;

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-completion-lineage-") };
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  assert(opened);
  actor = opened;
});

afterAll(async () => {
  await actor?.close();
});

it("keeps durable completion lineage in its incognito requester's captured root", async () => {
  const sessionKey = "agent:main:dashboard:incognito-completion-lineage-root";
  const sessionId = "captured-root-requester";
  const childKey = "agent:main:subagent:captured-root-child";
  const childSessionId = "captured-root-child";
  await actor.sessions.create(authority, {
    sessionKey,
    entry: { sessionId, updatedAt: 1, incognito: true },
  });
  await replaceSessionEntry(
    { agentId: "main", sessionKey: childKey, env },
    {
      sessionId: childSessionId,
      updatedAt: 1,
      spawnedBy: sessionKey,
      completionOwnerSessionKey: sessionKey,
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      inheritedToolPolicyVersion: 1,
    },
  );
  const originalRoot = process.env.OPENCLAW_STATE_DIR;
  try {
    await withIncognitoSessionActor(actor, async () => {
      const lineage = createCompletionGrantLineageAdmission({
        cfg: {},
        context: {
          sessionKey,
          sessionId,
          modelProvider: "claude-cli",
          modelId: "opus",
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: childKey,
            sourceChannel: "internal",
            sourceTool: "subagent_announce",
          },
          trustedInternalHandoff: {
            kind: "subagent-completion",
            sourceSessionKey: childKey,
            sourceSessionId: childSessionId,
            targetSessionKey: sessionKey,
            targetSessionId: sessionId,
            provider: "claude-cli",
            model: "opus",
          },
        },
      });
      assert(lineage.admission);
      process.env.OPENCLAW_STATE_DIR = tempDirs.make("foreign-lineage-state-");
      const prepared = await lineage.admission.prepare();
      expect(prepared.isCurrent()).toBe(true);
      expect(prepared.current.sources).toMatchObject([
        { path: resolvePhysicalSessionStorePath({ agentId: "main", sessionKey: childKey, env }) },
      ]);
    });
  } finally {
    if (originalRoot === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalRoot;
    }
  }
});
