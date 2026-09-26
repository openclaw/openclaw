import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { expect } from "vitest";
import {
  loadExactSessionEntryCandidates,
  replaceSessionEntry,
  type SessionAccessScope,
} from "../../config/sessions/session-accessor.js";
import type { CapturedSessionEntryReadSource } from "../../config/sessions/session-accessor.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { drainAgentDatabaseResources } from "../../state/openclaw-agent-db-resources.js";
import {
  disposeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { resolveSessionStoreAgentId } from "../session-store-key.js";

type ChatDirectiveSessionState = {
  config: Record<string, unknown>;
  mainSessionKey: string;
  sessionEntry: Record<string, unknown>;
  sessionMissing: boolean;
  sessionIdsByKey: Map<string, string>;
  sessionId: string;
  storePath: string;
  transcriptPath: string;
};

export function readChatDirectiveConfig(
  state: Pick<ChatDirectiveSessionState, "config" | "mainSessionKey">,
): OpenClawConfig {
  return {
    ...state.config,
    session: {
      ...(state.config.session as Record<string, unknown> | undefined),
      mainKey: state.mainSessionKey,
    },
  };
}

export function createChatDirectiveSuiteResources() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chat-directive-suite-"));
  const databasePath = path.join(root, "openclaw-agent.sqlite");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  return {
    root,
    databasePath,
    env,
    // The caller retains cleanup ownership before opening can fail.
    open() {
      openOpenClawAgentDatabase({ agentId: "main", env, path: databasePath });
    },
    loadSessionEntry(
      state: ChatDirectiveSessionState,
      rawKey: string,
      opts?: { agentId?: string },
    ) {
      const canonicalKey =
        typeof state.sessionEntry.canonicalKey === "string"
          ? state.sessionEntry.canonicalKey
          : rawKey === "main"
            ? `agent:${opts?.agentId ?? "main"}:${state.mainSessionKey}`
            : rawKey || `agent:${opts?.agentId ?? "main"}:${state.mainSessionKey}`;
      const entry = state.sessionMissing
        ? undefined
        : {
            sessionId: state.sessionIdsByKey.get(rawKey) ?? state.sessionId,
            sessionFile: state.transcriptPath,
            ...state.sessionEntry,
          };
      const cfg = readChatDirectiveConfig(state);
      let captured: CapturedSessionEntryReadSource | undefined;
      loadExactSessionEntryCandidates({
        readSource: { agentId: "main", path: state.storePath },
        env,
        sessionKeys: [canonicalKey],
        readOnly: true,
        onReadSource: (source, physical) => {
          if (physical) {
            captured = {
              ...source,
              databaseIdentity: physical.identity,
              databaseBirthtime: physical.birthtime,
            };
          }
        },
      });
      const capturedReadSource = expectDefined(captured, "chat directive fixture database source");
      return {
        cfg,
        agentId: resolveSessionStoreAgentId(cfg, rawKey, opts?.agentId),
        storePath: state.storePath,
        store: entry ? { [canonicalKey]: entry } : {},
        entry,
        canonicalKey,
        storeKeys: [canonicalKey],
        readSource: { agentId: capturedReadSource.agentId, path: capturedReadSource.path },
        capturedReadSource,
        capturedReadSources: [capturedReadSource],
      };
    },
    async close() {
      await drainAgentDatabaseResources({ path: databasePath, agentId: "main" }, async () =>
        disposeOpenClawAgentDatabaseByPath(databasePath, { env }),
      );
      await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function seedChatDirectiveFileTranscript(
  scope: SessionAccessScope,
  sessionId: string,
  sessionFile: string,
) {
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: "/tmp",
    })}\n`,
    "utf-8",
  );
  // The accessor resolves transcript targets from the persisted store, not the mocked Gateway.
  await replaceSessionEntry(scope, {
    sessionId,
    updatedAt: Date.now(),
  });
}

export function expectClaimOnlyTranscriptMedia(
  message: unknown,
  expectedMedia: unknown[],
  forbiddenValues: string[],
) {
  const media = (
    message as { __openclaw?: { media?: Array<Record<string, unknown>> } } | undefined
  )?.["__openclaw"]?.media;
  expect(media).toEqual(expectedMedia);
  for (const fact of media ?? []) {
    expect(fact.url).toMatch(/^media:\/\/inbound\/[^?#]+$/u);
    expect(fact).not.toHaveProperty("path");
    expect(fact).not.toHaveProperty("workspaceDir");
    expect(fact).not.toHaveProperty("data");
  }
  const serialized = JSON.stringify(message);
  expect(serialized).not.toContain("base64");
  for (const value of forbiddenValues) {
    expect(serialized).not.toContain(value);
  }
}
