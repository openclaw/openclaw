import { describe, expect, it } from "vitest";
import {
  findSessionAccessorBoundaryViolations,
  findSessionAccessorWriteBoundaryViolations,
  migratedSessionAccessorFiles,
  migratedSessionAccessorWriteFiles,
} from "../../scripts/check-session-accessor-boundary.mjs";

describe("session accessor boundary guard", () => {
  it("ratchets only the files migrated by the session accessor slices", () => {
    expect(migratedSessionAccessorFiles).toEqual(
      new Set([
        "src/agents/embedded-agent-runner/run/attempt.ts",
        "src/commands/export-trajectory.ts",
        "src/commands/health.ts",
        "src/commands/sandbox-explain.ts",
        "src/commands/sessions-tail.ts",
        "src/commands/sessions.ts",
        "src/commands/status.agent-local.ts",
        "src/commands/status.summary.ts",
        "src/config/sessions/combined-store-gateway.ts",
        "src/cron/isolated-agent/delivery-target.ts",
        "src/cron/service/timer.ts",
        "src/gateway/session-utils.ts",
        "src/gateway/sessions-resolve.ts",
        "src/gateway/server-methods/sessions.ts",
        "src/infra/outbound/message-action-tts.ts",
      ]),
    );
  });

  it("ratchets only the auto-reply files migrated to session accessor writes", () => {
    expect(migratedSessionAccessorWriteFiles).toEqual(
      new Set([
        "src/agents/command/attempt-execution.shared.ts",
        "src/agents/embedded-agent-runner/run.ts",
        "src/agents/embedded-agent-runner/run/attempt.ts",
        "src/auto-reply/reply/abort-cutoff.runtime.ts",
        "src/auto-reply/reply/agent-runner-cli-dispatch.ts",
        "src/auto-reply/reply/agent-runner-execution.ts",
        "src/auto-reply/reply/agent-runner-memory.ts",
        "src/auto-reply/reply/agent-runner.ts",
        "src/auto-reply/reply/body.ts",
        "src/auto-reply/reply/commands-acp/lifecycle.ts",
        "src/auto-reply/reply/commands-reset.ts",
        "src/auto-reply/reply/directive-handling.impl.ts",
        "src/auto-reply/reply/directive-handling.persist.ts",
        "src/auto-reply/reply/dispatch-from-config.runtime.ts",
        "src/auto-reply/reply/followup-runner.ts",
        "src/auto-reply/reply/get-reply.ts",
        "src/auto-reply/reply/model-selection.ts",
        "src/auto-reply/reply/session-reset-model.ts",
        "src/auto-reply/reply/session-updates.ts",
        "src/auto-reply/reply/session-usage.ts",
      ]),
    );
  });

  it("flags legacy reader imports", () => {
    expect(
      findSessionAccessorBoundaryViolations(`
        import { loadSessionStore, readSessionEntries as readEntries } from "../config/sessions.js";
        import { readSessionEntry, readSessionStoreReadOnly } from "../config/sessions/store-load.js";
      `),
    ).toEqual([
      { line: 2, reason: 'imports legacy session store reader "loadSessionStore"' },
      { line: 2, reason: 'imports legacy session store reader "readSessionEntries"' },
      { line: 3, reason: 'imports legacy session store reader "readSessionEntry"' },
      { line: 3, reason: 'imports legacy session store reader "readSessionStoreReadOnly"' },
    ]);
  });

  it("flags direct and namespace legacy reader calls", () => {
    expect(
      findSessionAccessorBoundaryViolations(`
        loadSessionStore(storePath);
        sessions.readSessionEntries(storePath);
        sessions["loadSessionStore"](storePath);
        readSessionStoreReadOnly(storePath);
        resolveSessionStoreEntry({ store, sessionKey });
      `),
    ).toEqual([
      { line: 2, reason: 'calls legacy session store reader "loadSessionStore"' },
      { line: 3, reason: 'references legacy session store reader "readSessionEntries"' },
      { line: 4, reason: 'references legacy session store reader "loadSessionStore"' },
      { line: 5, reason: 'calls legacy session store reader "readSessionStoreReadOnly"' },
      { line: 6, reason: 'calls legacy session store reader "resolveSessionStoreEntry"' },
    ]);
  });

  it("flags aliased namespace reader references", () => {
    expect(
      findSessionAccessorBoundaryViolations(`
        const load = sessions.loadSessionStore;
        const { readSessionEntries: readEntries } = sessions;
        const { loadSessionStore } = sessions;
      `),
    ).toEqual([
      { line: 2, reason: 'references legacy session store reader "loadSessionStore"' },
      { line: 3, reason: 'aliases legacy session store reader "readSessionEntries"' },
      { line: 4, reason: 'aliases legacy session store reader "loadSessionStore"' },
    ]);
  });

  it("allows migrated accessor reads", () => {
    expect(
      findSessionAccessorBoundaryViolations(`
        import { listSessionEntries } from "../config/sessions/session-accessor.js";
        listSessionEntries({ storePath });
      `),
    ).toEqual([]);
  });

  it("flags legacy writer imports and calls", () => {
    expect(
      findSessionAccessorWriteBoundaryViolations(`
        import { applySessionStoreEntryPatch, updateSessionStore, updateSessionStoreEntry as updateEntry } from "../config/sessions.js";
        updateSessionStore(storePath, () => undefined);
        sessions.updateSessionStoreEntry({ storePath, sessionKey, update });
        applySessionStoreEntryPatch({ storePath, sessionKey, patch });
      `),
    ).toEqual([
      { line: 2, reason: 'imports legacy session store writer "applySessionStoreEntryPatch"' },
      { line: 2, reason: 'imports legacy session store writer "updateSessionStore"' },
      { line: 2, reason: 'imports legacy session store writer "updateSessionStoreEntry"' },
      { line: 3, reason: 'calls legacy session store writer "updateSessionStore"' },
      { line: 4, reason: 'references legacy session store writer "updateSessionStoreEntry"' },
      { line: 5, reason: 'calls legacy session store writer "applySessionStoreEntryPatch"' },
    ]);
  });

  it("allows migrated accessor writes", () => {
    expect(
      findSessionAccessorWriteBoundaryViolations(`
        import { updateSessionEntry } from "../config/sessions/session-accessor.js";
        updateSessionEntry({ storePath, sessionKey }, () => undefined);
      `),
    ).toEqual([]);
  });

  it("ignores comments and strings that describe legacy readers", () => {
    expect(
      findSessionAccessorBoundaryViolations(`
        // loadSessionStore and readSessionEntries used to be called here.
        const description = "loadSessionStore";
      `),
    ).toEqual([]);
  });
});
