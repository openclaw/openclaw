import { beforeEach, expect, it, vi } from "vitest";
import type { GitHubPublicationReviewRead } from "../gateway/github-publication-review-store.types.js";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

const mock = vi.hoisted(() => ({
  handler: vi.fn<(input: unknown) => OpenClawStateReadReply>(),
  admit: vi.fn<() => void>(),
  query: vi.fn<() => []>(),
  reviewQuery: vi.fn<(_db: object, _input: GitHubPublicationReviewRead) => []>(),
  settle: vi.fn<(operation: (source: { db: object }) => unknown) => unknown>(),
}));
vi.mock("../infra/worker-task-server.js", () => ({
  serveOwnedWorkerTasks: (handler: (input: unknown) => OpenClawStateReadReply) => {
    mock.handler.mockImplementation(handler);
  },
}));
vi.mock("../fleet/registry.kernel.js", () => ({
  listFleetCellsInDatabase: mock.query,
  getFleetCellInDatabase: () => undefined,
}));
vi.mock("./openclaw-agent-db-registry.read.js", () => ({
  readRegisteredAgentDatabaseRows: mock.query,
}));
vi.mock("../gateway/github-publication-review-store.worker.js", () => ({
  readGitHubPublicationReviewsInDatabase: mock.reviewQuery,
}));
vi.mock("./openclaw-state-db-read-connection.js", () => ({
  closeRetainedOpenClawStateReadConnections: vi.fn(),
  readOpenClawStateReadOnlyLocation: mock.settle,
  withOpenClawStateReadOnlyLocation: (operation: (source: { db: object }) => unknown) => {
    mock.admit();
    return operation({ db: {} });
  },
}));

import "./openclaw-state-read.worker.js";

const request: OpenClawStateReadRequest = {
  context: {
    environment: { OPENCLAW_STATE_DIR: "/fixture" },
  },
  databasePath: "/fixture/state.sqlite",
  location: "/fixture/snapshot.sqlite",
  checkFreshAdmission: false,
  command: { type: "fleet.list" },
};

beforeEach(() => {
  mock.admit.mockReset();
  mock.query.mockReset().mockReturnValue([]);
  mock.reviewQuery.mockReset().mockReturnValue([]);
  mock.settle.mockReset().mockImplementation((operation) => {
    try {
      mock.admit();
      return { status: "available", value: operation({ db: {} }) };
    } catch (error) {
      return { status: "unavailable", error };
    }
  });
});

const reviewSession = { agentId: "main", sessionKey: "agent:main:review", sessionId: "review" };
const reviewReads: GitHubPublicationReviewRead[] = [
  { kind: "row", selector: { reviewId: "review" } },
  { kind: "row", selector: { publicationRequestId: "publication" } },
  { kind: "find", sessionId: "review", profileId: "reviewer", idempotencyKey: "review" },
  { kind: "session", session: reviewSession },
  { kind: "session", session: { ...reviewSession, lifecycleRevision: null } },
  { kind: "session", session: { ...reviewSession, lifecycleRevision: "generation" } },
  { kind: "unreported" },
];

it.each(reviewReads)("admits and dispatches publication review read %j", (input) => {
  expect(mock.handler({ ...request, command: { type: "publicationReview.read", input } })).toEqual({
    ok: true,
    type: "publicationReview.read",
    sourceAdmitted: true,
    rows: [],
  });
  expect(mock.admit).toHaveBeenCalledOnce();
  expect(mock.reviewQuery).toHaveBeenCalledExactlyOnceWith({}, input);
});

it.each([
  null,
  { kind: "unknown" },
  { kind: "row", selector: {} },
  { kind: "row", selector: { reviewId: 42, publicationRequestId: "publication" } },
  { kind: "row", selector: { publicationRequestId: 42 } },
  { kind: "find", sessionId: "review", idempotencyKey: "review" },
  { kind: "session", session: { ...reviewSession, lifecycleRevision: false } },
])("refuses malformed publication review read %j before source admission", (input) => {
  expect(
    mock.handler({ ...request, command: { type: "publicationReview.read", input } }),
  ).toMatchObject({
    ok: false,
    message: "Shared-state reader requires a captured state location and read command",
  });
  expect(mock.admit).not.toHaveBeenCalled();
  expect(mock.reviewQuery).not.toHaveBeenCalled();
});

it.each(["success", "query-error", "schema-error"] as const)(
  "reports source admission at the schema-validated callback for %s",
  (outcome) => {
    const failure = new Error("controlled reader failure");
    if (outcome === "schema-error") {
      mock.admit.mockImplementation(() => {
        throw failure;
      });
    } else if (outcome === "query-error") {
      mock.query.mockImplementation(() => {
        throw failure;
      });
    }
    const reply = mock.handler(request);
    if (reply.ok) {
      expect(reply).toEqual({ ok: true, type: "fleet.list", sourceAdmitted: true, cells: [] });
    } else {
      expect(reply.message).toBe(failure.message);
      expect(reply.sourceAdmitted).toBe(outcome === "query-error" ? true : undefined);
    }
    expect(reply.ok).toBe(outcome === "success");
    expect(mock.query).toHaveBeenCalledTimes(outcome === "schema-error" ? 0 : 1);
  },
);

it.each(["success", "query-error", "schema-error"] as const)(
  "preserves native admission facts in the registry %s reply",
  (outcome) => {
    const fail = () => {
      throw new Error("read unavailable");
    };
    if (outcome === "schema-error") {
      mock.admit.mockImplementation(fail);
    }
    if (outcome === "query-error") {
      mock.query.mockImplementation(fail);
    }
    expect(mock.handler({ ...request, command: { type: "agentDatabaseRegistry.read" } })).toEqual({
      ok: true,
      type: "agentDatabaseRegistry.read",
      sourceAdmitted: outcome === "schema-error" ? undefined : true,
      result:
        outcome === "success" ? { status: "available", entries: [] } : { status: "unavailable" },
    });
  },
);

it("keeps registry native cleanup failure in the worker error protocol", () => {
  mock.settle.mockImplementationOnce((operation) => {
    operation({ db: {} });
    throw new Error("native cleanup failed");
  });
  const reply = mock.handler({ ...request, command: { type: "agentDatabaseRegistry.read" } });
  expect(reply).toMatchObject({
    ok: false,
    sourceAdmitted: true,
    message: "native cleanup failed",
  });
});
