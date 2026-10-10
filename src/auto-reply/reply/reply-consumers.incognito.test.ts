import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.entry-mutation.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../../config/sessions/session-incognito-binding.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { IncognitoSessionEndedError } from "../../state/incognito-session-error.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import { openIncognitoTestActor } from "../../state/openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { readSessionFallbackModelAsync } from "../../status/session-fallback-model.js";
import { createShouldEmitToolResult } from "./agent-runner-helpers.js";
import { buildExportSessionReply } from "./commands-export-session.js";
import { handleNameCommand } from "./commands-name.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { prepareNativeReplyToolAuthorityRead } from "./reply-tool-authority.native-read.js";

const exportPrompt = vi.hoisted(() =>
  vi.fn(async () => ({ systemPrompt: "synthetic", tools: [] })),
);
vi.mock("./commands-system-prompt.js", () => ({
  resolveCommandsSystemPromptBundle: exportPrompt,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-reply-consumers-") };
  actor = await openIncognitoTestActor(env, authority);
});
afterAll(async () => {
  await actor?.close();
  await closeOpenClawStateDatabaseAsync();
});

async function create(name: string, fields: Partial<InternalSessionEntry> = {}) {
  const scope = {
    agentId: actor.agentId,
    storePath: actor.path,
    sessionKey: `agent:main:dashboard:incognito-${name}`,
  };
  const result = await actor.sessions.create(authority, {
    sessionKey: scope.sessionKey,
    entry: {
      sessionId: name,
      updatedAt: 100,
      lifecycleRevision: "initial",
      incognito: true,
      ...fields,
    },
  });
  assert(result.entry);
  return { scope, entry: result.entry };
}

it("uses live actor preferences for a retained progress callback without host SQL", async () => {
  const { scope } = await create("progress", { verboseLevel: "off" });
  const sql = observeHostDataSql();
  try {
    await withIncognitoSessionActor(actor, async () => {
      const visible = createShouldEmitToolResult({ ...scope, resolvedVerboseLevel: "off" });
      expect(visible()).toBe(false);
      await updateSessionEntry(scope, () => ({ verboseLevel: "full" }));
      expect(visible()).toBe(true);
      await updateSessionEntry(scope, () => ({ verboseLevel: "off" }));
      expect(visible()).toBe(false);
    });
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

it("retains actor classification authority and refuses a changed generation without native reads", async () => {
  const { scope, entry } = await create("tool-authority");
  const sql = observeHostDataSql();
  try {
    const prepared = await withIncognitoSessionActor(actor, async () =>
      prepareNativeReplyToolAuthorityRead(
        {
          ...scope,
          canonicalKey: scope.sessionKey,
          source: undefined,
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
        },
        () => {},
      ),
    );
    prepared.assertPrepared([]);
    await withIncognitoSessionActor(actor, () =>
      updateSessionEntry(scope, () => ({ lifecycleRevision: "replacement" })),
    );
    expect(() => prepared.assertPrepared([])).toThrow("generation is no longer current");
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

it("renames and reads the selected actor session without trusting a stale command entry", async () => {
  const { scope, entry } = await create("name", { label: "Before" });
  const params = {
    ...scope,
    cfg: {},
    ctx: { CommandSource: "text" },
    command: { commandBodyNormalized: "/name After", isAuthorizedSender: true },
    sessionEntry: entry,
    sessionStore: { [scope.sessionKey]: entry },
  } as HandleCommandsParams;
  const sql = observeHostDataSql();
  try {
    await withIncognitoSessionActor(actor, async () => {
      expect((await handleNameCommand(params, true))?.reply?.text).toContain("After");
      expect(params.sessionEntry?.label).toBe("After");
      params.command.commandBodyNormalized = "/name";
      expect((await handleNameCommand(params, true))?.reply?.text).toContain(
        "Current session name: After",
      );
      expect(
        (await actor.sessions.read(authority, { sessionKey: scope.sessionKey })).entry?.label,
      ).toBe("After");
    });
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

it("reads the completed fallback model from the actor transcript", async () => {
  const { scope, entry } = await create("fallback", {
    status: "done",
    lastRunId: "fallback-run",
    fallbackNotice: {
      kind: "active",
      selectedModel: "openai/selected",
      activeModel: "openai/fallback",
      reason: "rate_limit",
    },
  });
  await withIncognitoSessionActor(actor, () =>
    appendTranscriptMessage(
      { ...scope, sessionId: entry.sessionId },
      {
        message: {
          role: "assistant",
          content: "Synthetic answer",
          stopReason: "stop",
          provider: "openai",
          model: "fallback",
          __openclaw: { runId: "fallback-run" },
        },
      },
    ),
  );
  const sql = observeHostDataSql();
  try {
    await withIncognitoSessionActor(actor, async () => {
      expect(
        await readSessionFallbackModelAsync({
          sessionScope: scope,
          sessionEntry: entry,
          selectedProvider: "openai",
          selectedModel: "selected",
        }),
      ).toEqual({ modelProvider: "openai", model: "fallback" });
    });
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

it("refuses an export whose source changes during prompt preparation without writing an artifact", async () => {
  const { scope, entry } = await create("export");
  const workspaceDir = tempDirs.make("incognito-export-output-");
  const entered = createDeferredCore<void>();
  const release = createDeferredCore<void>();
  exportPrompt.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return { systemPrompt: "synthetic", tools: [] };
  });
  const params = {
    ...scope,
    cfg: {},
    workspaceDir,
    command: { commandBodyNormalized: "/export-session", senderIsOwner: true },
    sessionEntry: entry,
  } as HandleCommandsParams;
  const sql = observeHostDataSql();
  try {
    await withIncognitoSessionActor(actor, async () => {
      const exporting = buildExportSessionReply(params);
      const rejected = expect(exporting).rejects.toThrow("generation is no longer current");
      await entered.promise;
      try {
        await updateSessionEntry(scope, () => ({ lifecycleRevision: "replacement" }));
      } finally {
        release.resolve();
      }
      await rejected;
    });
    expect(await fs.readdir(workspaceDir)).toEqual([]);
    expect(sql.queries).toEqual([]);
  } finally {
    release.resolve();
    sql.restore();
  }
});

it("keeps explicit absence empty and retained loss terminal without creating another actor", async () => {
  const emptyEnv = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-reply-absent-") };
  const scope = {
    agentId: "main",
    env: emptyEnv,
    sessionKey: "agent:main:dashboard:incognito-absent",
  };
  await withIncognitoSessionBinding({ kind: "absent", ...scope, authority }, async () => {
    const visible = createShouldEmitToolResult({ ...scope, resolvedVerboseLevel: "full" });
    expect(visible()).toBe(false);
    expect(
      await readSessionFallbackModelAsync({
        sessionScope: scope,
        selectedProvider: "openai",
        selectedModel: "selected",
      }),
    ).toBeUndefined();
  });
  expect(captureOpenClawAgentDatabaseExecution.listIncognito(emptyEnv)).toHaveLength(0);
  await withIncognitoSessionActor(actor, async () => {
    expect(
      createShouldEmitToolResult({
        sessionKey: "agent:main:dashboard:incognito-no-row",
        storePath: actor.path,
        resolvedVerboseLevel: "full",
        verboseLevelOverride: "full",
      })(),
    ).toBe(false);
  });
  const { scope: live } = await create("ended");
  const visible = withIncognitoSessionBinding({ actor }, () =>
    createShouldEmitToolResult({ ...live, resolvedVerboseLevel: "full" }),
  );
  await actor.close();
  expect(visible).toThrow(IncognitoSessionEndedError);
});
