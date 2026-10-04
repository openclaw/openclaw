import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import type { SessionColdArchive } from "./session-cold-storage-state.js";
import { restoreSessionColdTranscript } from "./session-cold-storage.js";
import type { SessionHistoryWorkerDatabase } from "./session-transcript-worker.types.js";

const observed = vi.hoisted(() => ({
  nativeRead: vi.fn(),
  readMetadata: vi.fn<SessionHistoryWorkerDatabase["readColdMetadata"]>(),
  assertOwner: vi.fn(),
  release: vi.fn(),
  options: vi.fn<(options: OpenClawAgentDatabaseOptions) => void>(),
}));

vi.mock("../../state/openclaw-agent-db-readonly.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-agent-db-readonly.js")>()),
  withOpenClawAgentDatabaseReadOnly: observed.nativeRead,
}));
vi.mock("./session-transcript-worker-runtime.js", () => ({
  withSessionHistoryWorkerDatabase: async (
    options: OpenClawAgentDatabaseOptions,
    run: (
      owner: Pick<SessionHistoryWorkerDatabase, "assertCurrent" | "readColdMetadata">,
    ) => Promise<void>,
  ) => {
    observed.options(options);
    try {
      await run({ assertCurrent: observed.assertOwner, readColdMetadata: observed.readMetadata });
    } finally {
      observed.release();
    }
  },
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const archive: Omit<SessionColdArchive, "archive_blob"> = {
  session_id: "transcript",
  generation: "generation",
  archive_name: "archive.gz",
  archive_sha256: "0".repeat(64),
  event_count: 1,
  raw_bytes: 100,
  archive_bytes: 80,
  last_seq: 1,
  archived_at: 1,
  storage: "file",
};

beforeEach(() => {
  vi.resetAllMocks();
  observed.nativeRead.mockImplementation(() => {
    throw new Error("SQLite metadata ran on the calling thread");
  });
  observed.readMetadata.mockResolvedValue({ kind: "cold-metadata", archive: undefined });
});

function scope() {
  const target = {
    agentId: "main",
    sessionId: archive.session_id,
    env: { OPENCLAW_STATE_DIR: tempDirs.make("cold-preflight-") },
  };
  const databasePath = resolveOpenClawAgentSqlitePath(target);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.writeFileSync(databasePath, "original source");
  return target;
}

it.each([false, true])(
  "retains the captured source through worker metadata (queued: %s)",
  async (queued) => {
    const target = scope();
    const originalStateDir = target.env.OPENCLAW_STATE_DIR;
    const initial =
      createDeferredCore<Awaited<ReturnType<SessionHistoryWorkerDatabase["readColdMetadata"]>>>();
    const entered = createDeferredCore();
    observed.readMetadata.mockImplementationOnce(() => {
      entered.resolve();
      return initial.promise;
    });
    const pending = restoreSessionColdTranscript(target);
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "Metadata read was not dispatched");
      target.env.OPENCLAW_STATE_DIR = path.join(originalStateDir, "replacement");
      expect(observed.release).not.toHaveBeenCalled();
    } finally {
      initial.resolve({ kind: "cold-metadata", archive: queued ? archive : undefined });
      await expect(pending).resolves.toBeUndefined();
    }
    expect(observed.readMetadata).toHaveBeenCalledTimes(queued ? 2 : 1);
    for (const [request] of observed.readMetadata.mock.calls) {
      expect(request.env.OPENCLAW_STATE_DIR).toBe(originalStateDir);
    }
    expect(observed.options.mock.calls[0]?.[0].path).toBe(
      resolveOpenClawAgentSqlitePath({
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: originalStateDir },
      }),
    );
    expect(observed.nativeRead).not.toHaveBeenCalled();
    expect(observed.release).toHaveBeenCalledOnce();
  },
);

it.each([
  ...["caller", "owner", "file", "worker"].flatMap((authority) =>
    ["initial", "queued"].map((phase) => ({ authority, phase })),
  ),
  { authority: "caller", phase: "preparation" },
])("refuses restoration after $authority failure during $phase", async ({ authority, phase }) => {
  const target = scope();
  const refused = new Error("authority revoked");
  const assertCurrent = vi.fn();
  const revoke = () => {
    if (authority === "file") {
      const databasePath = resolveOpenClawAgentSqlitePath(target);
      fs.renameSync(databasePath, `${databasePath}.old`);
      fs.writeFileSync(databasePath, "replacement source");
    } else {
      (authority === "caller" ? assertCurrent : observed.assertOwner).mockImplementation(() => {
        throw refused;
      });
    }
  };
  if (phase === "queued") {
    observed.readMetadata.mockResolvedValueOnce({ kind: "cold-metadata", archive });
  }
  if (authority === "worker") {
    observed.readMetadata.mockRejectedValueOnce(refused);
  } else if (phase !== "preparation") {
    observed.readMetadata.mockImplementationOnce(async () => {
      revoke();
      return { kind: "cold-metadata", archive };
    });
  }
  const pending = restoreSessionColdTranscript(target, assertCurrent);
  if (phase === "preparation") {
    revoke();
  }
  if (authority === "worker") {
    await expect(pending).rejects.toBe(refused);
  } else {
    await expect(pending).rejects.toThrow(
      authority === "file" ? /Session store changed/ : refused.message,
    );
  }
  expect(observed.readMetadata).toHaveBeenCalledTimes(
    phase === "queued" ? 2 : phase === "initial" ? 1 : 0,
  );
  expect(observed.nativeRead).not.toHaveBeenCalled();
  expect(observed.release).toHaveBeenCalledTimes(phase === "preparation" ? 0 : 1);
});

it.each(["key", "path"])(
  "keeps incognito metadata selected by %s with its process-held owner",
  async (selection) => {
    const target = scope();
    observed.nativeRead.mockReturnValue({ found: true, value: undefined });
    await expect(
      restoreSessionColdTranscript({
        ...target,
        ...(selection === "key"
          ? { sessionKey: "agent:main:dashboard:incognito-test" }
          : { storePath: resolveIncognitoOpenClawAgentSqlitePath(target) }),
      }),
    ).resolves.toBeUndefined();
    expect(observed.nativeRead).toHaveBeenCalledOnce();
    expect(observed.readMetadata).not.toHaveBeenCalled();
  },
);
