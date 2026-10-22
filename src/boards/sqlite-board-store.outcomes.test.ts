import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { BoardWidgetPutResult } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { withSqliteWorkerCleanupFailure } from "../infra/sqlite-worker-broker-reply.js";
import { SqliteWorkerError, type SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { BoardValidationError } from "./board-layout.js";
import {
  boardFixture,
  closeBoardDatabases,
  htmlWidget,
} from "./board-store.fixtures.test-support.js";
import type { BoardWriteOperations, BoardWriteOutcome } from "./sqlite-board-operations.js";
import { SqliteBoardStore } from "./sqlite-board-store.js";

const boundary = vi.hoisted(() => ({
  execute: vi.fn(
    async (
      _command: Parameters<SqliteWorkerStore<BoardWriteOperations>["execute"]>[0],
    ): Promise<BoardWriteOutcome<BoardWidgetPutResult>> => {
      throw new Error("Expected the test to supply a worker outcome");
    },
  ),
  close: vi.fn(async () => {}),
}));

vi.mock("../state/openclaw-agent-worker-store.js", () => ({
  openOpenClawAgentSqliteWorkerStore: async () => ({
    async run<T>(
      operation: (scope: Pick<SqliteWorkerStore<BoardWriteOperations>, "execute">) => Promise<T>,
      assertCurrent: () => void,
    ) {
      assertCurrent();
      return operation({ execute: boundary.execute });
    },
    close: () => boundary.close(),
  }),
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeBoardDatabases();
    cleanup();
  }),
);

beforeEach(() => {
  boundary.execute.mockReset();
  boundary.close.mockReset().mockResolvedValue(undefined);
});

function fixture() {
  const { storeOptions, sessionKey, database } = boardFixture(
    tempDirs.make("board-publication-outcome-"),
    "agent:main:original",
  );
  const store = new SqliteBoardStore({
    ...storeOptions,
    resolveSession: (target) => ({ agentId: "main", path: database.path, ...target }),
  });
  const params = htmlWidget(sessionKey, "status", "<p>committed</p>");
  const change = { sessionKey, storePath: database.path };
  const changes: SessionRowChange[] = [];
  onTestFinished(sessionChanges.subscribe((published) => changes.push(published)));
  function expectPublication(expected: SessionRowChange[]) {
    expect(changes).toEqual(expected);
    expect(boundary.execute).toHaveBeenCalledOnce();
    expect(boundary.close).toHaveBeenCalledOnce();
  }
  return { store, params, change, expectPublication };
}

function failureOutcome(kind: "native" | "transported" | "cleanup") {
  const error = new SqliteWorkerError("Native Board outcome is unknown", "outcome-unknown");
  if (kind === "cleanup") {
    return ["Native cleanup failed", "Later cleanup failed"].reduce<Error>(
      (failure, message) => withSqliteWorkerCleanupFailure(failure, new Error(message)),
      error,
    );
  }
  // Broker retirement/settlement is owned by sqlite-worker-request-custody and
  // sqlite-worker-broker-reply.cleanup tests. Here only the delivered error matters.
  return kind === "native"
    ? error
    : Object.assign(new Error(error.message), { name: error.name, code: error.code });
}

it.each(["native", "transported", "cleanup"] as const)(
  "invalidates the original Board without replay after %s failure",
  async (kind) => {
    const { store, params, change, expectPublication } = fixture();
    const error = failureOutcome(kind);
    boundary.execute.mockImplementation(async () => {
      params.sessionKey = "agent:main:replacement";
      throw error;
    });
    await expect(store.putWidget(params)).rejects.toBe(error);
    expectPublication([change]);
  },
);

it("relays a committed Board outcome after revocation without failing on client cleanup", async () => {
  const { store, params, change, expectPublication } = fixture();
  const committed: BoardWidgetPutResult = {
    sessionKey: params.sessionKey,
    revision: 17,
    tabs: [],
    widgets: [],
    resolvedWidgetName: params.name,
  };
  const authority = new AbortController();
  boundary.execute.mockImplementation(async () => {
    authority.abort(new Error("Board request revoked during committed delivery"));
    params.sessionKey = "agent:main:replacement";
    return { value: committed, changes: [change] };
  });
  boundary.close.mockRejectedValue(new Error("Client cleanup failed after committed publication"));
  await expect(
    store.putWidget(params, {
      assertCurrent: composeSessionSourceAssertion([], () => authority.signal.throwIfAborted()),
    }),
  ).resolves.toBe(committed);
  expectPublication([change]);
});

it("restores a known Board validation rollback without publishing a change", async () => {
  const { store, params, expectPublication } = fixture();
  boundary.execute.mockRejectedValue(
    Object.assign(new Error("Board widget revision changed"), {
      name: "BoardValidationError",
      code: "conflict",
    }),
  );
  const failure: unknown = await store.putWidget(params).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(BoardValidationError);
  expect(failure).toMatchObject({ code: "conflict", message: "Board widget revision changed" });
  expectPublication([]);
});
