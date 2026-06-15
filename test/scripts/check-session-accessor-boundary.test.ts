import { describe, expect, it } from "vitest";
import {
  findSessionAccessorBoundaryViolations,
  migratedBundledPluginSessionAccessorFiles,
  migratedSessionAccessorFiles,
} from "../../scripts/check-session-accessor-boundary.mjs";

describe("session accessor boundary guard", () => {
  it("ratchets only the files migrated by the session accessor slices", () => {
    expect(migratedSessionAccessorFiles).toEqual(
      new Set([
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

  it("ratchets only the bundled plugin files migrated by this slice", () => {
    expect(migratedBundledPluginSessionAccessorFiles).toEqual(
      new Set([
        "extensions/discord/src/monitor/native-command-model-picker-apply.ts",
        "extensions/discord/src/monitor/thread-session-close.ts",
        "extensions/telegram/src/bot-handlers.runtime.ts",
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
      { line: 2, reason: 'imports legacy session store access "loadSessionStore"' },
      { line: 2, reason: 'imports legacy session store access "readSessionEntries"' },
      { line: 3, reason: 'imports legacy session store access "readSessionEntry"' },
      { line: 3, reason: 'imports legacy session store access "readSessionStoreReadOnly"' },
    ]);
  });

  it("flags direct and namespace legacy access calls", () => {
    expect(
      findSessionAccessorBoundaryViolations(`
        loadSessionStore(storePath);
        sessions.readSessionEntries(storePath);
        sessions["loadSessionStore"](storePath);
        readSessionStoreReadOnly(storePath);
        resolveSessionStoreEntry({ store, sessionKey });
      `),
    ).toEqual([
      { line: 2, reason: 'calls legacy session store access "loadSessionStore"' },
      { line: 3, reason: 'references legacy session store access "readSessionEntries"' },
      { line: 4, reason: 'references legacy session store access "loadSessionStore"' },
      { line: 5, reason: 'calls legacy session store access "readSessionStoreReadOnly"' },
      { line: 6, reason: 'calls legacy session store access "resolveSessionStoreEntry"' },
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
      { line: 2, reason: 'references legacy session store access "loadSessionStore"' },
      { line: 3, reason: 'aliases legacy session store access "readSessionEntries"' },
      { line: 4, reason: 'aliases legacy session store access "loadSessionStore"' },
    ]);
  });

  it("flags legacy whole-store writes", () => {
    expect(
      findSessionAccessorBoundaryViolations(`
        import { saveSessionStore, updateSessionStore } from "../config/sessions.js";
        saveSessionStore(storePath, store);
        updateSessionStore(storePath, update);
      `),
    ).toEqual([
      { line: 2, reason: 'imports legacy session store access "saveSessionStore"' },
      { line: 2, reason: 'imports legacy session store access "updateSessionStore"' },
      { line: 3, reason: 'calls legacy session store access "saveSessionStore"' },
      { line: 4, reason: 'calls legacy session store access "updateSessionStore"' },
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

  it("ignores comments and strings that describe legacy readers", () => {
    expect(
      findSessionAccessorBoundaryViolations(`
        // loadSessionStore and readSessionEntries used to be called here.
        const description = "loadSessionStore";
      `),
    ).toEqual([]);
  });
});
