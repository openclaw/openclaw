import { describe, expect, it, vi } from "vitest";
import type { ContinuityRecord, ContinuityStatus } from "../types.ts";
import { loadContinuity, patchContinuity, type ContinuityState } from "./continuity.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeStatus(pending: number, approved: number, rejected: number): ContinuityStatus {
  return {
    enabled: true,
    slotSelected: true,
    counts: {
      pending,
      approved,
      rejected,
    },
    capture: {
      mainDirect: "auto",
      pairedDirect: "review",
      group: "off",
      channel: "off",
      minConfidence: 0.75,
    },
    review: {
      autoApproveMain: true,
      requireSource: true,
    },
    recall: {
      maxItems: 4,
      includeOpenLoops: true,
    },
  };
}

function makeRecord(
  id: string,
  text: string,
  reviewState: ContinuityRecord["reviewState"],
): ContinuityRecord {
  const base = {
    id,
    kind: "fact",
    text,
    normalizedText: text.toLowerCase(),
    confidence: 0.9,
    sourceClass: "paired_direct",
    source: {
      role: "user",
      sessionKey: "telegram:direct:alice",
      sessionId: "session-1",
      excerpt: text,
    },
    createdAt: 1,
    updatedAt: 1,
  } as const;
  if (reviewState === "approved") {
    return {
      ...base,
      reviewState,
      approvedAt: 1,
      filePath: "memory/continuity/facts.md",
    };
  }
  if (reviewState === "rejected") {
    return {
      ...base,
      reviewState,
      rejectedAt: 1,
    };
  }
  return {
    ...base,
    reviewState,
  };
}

function createState(
  request: RequestFn,
  overrides: Partial<ContinuityState> = {},
): ContinuityState {
  return {
    client: { request } as unknown as ContinuityState["client"],
    connected: true,
    continuityLoading: false,
    continuityError: null,
    continuityStatus: null,
    continuityRecords: [],
    continuityAgentId: "",
    continuityStateFilter: "all",
    continuityKindFilter: "all",
    continuitySourceFilter: "all",
    continuityLimit: "100",
    continuityBusyId: null,
    continuityExplainById: {},
    ...overrides,
  };
}

describe("patchContinuity", () => {
  it("forces a second refresh when patch completes during an in-flight load", async () => {
    const statusFirst = createDeferred<ContinuityStatus>();
    const recordsFirst = createDeferred<ContinuityRecord[]>();
    const statusResponses: Array<Promise<ContinuityStatus> | ContinuityStatus> = [
      statusFirst.promise,
      makeStatus(0, 1, 0),
    ];
    const recordApproved = makeRecord("cont_1", "my timezone is America/Chicago", "approved");
    const recordPending = makeRecord("cont_1", "my timezone is America/Chicago", "pending");
    const listResponses: Array<Promise<ContinuityRecord[]> | ContinuityRecord[]> = [
      recordsFirst.promise,
      [recordApproved],
    ];

    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "continuity.status") {
        const next = statusResponses.shift();
        if (!next) {
          throw new Error("missing continuity.status response");
        }
        return next;
      }
      if (method === "continuity.list") {
        const next = listResponses.shift();
        if (!next) {
          throw new Error("missing continuity.list response");
        }
        return next;
      }
      if (method === "continuity.patch") {
        expect(params).toEqual({ id: "cont_1", action: "approve" });
        return { ok: true };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);

    const initialLoad = loadContinuity(state);
    await Promise.resolve();
    expect(state.continuityLoading).toBe(true);

    const patch = patchContinuity(state, "cont_1", "approve");
    await Promise.resolve();

    statusFirst.resolve(makeStatus(1, 0, 0));
    recordsFirst.resolve([recordPending]);
    await patch;
    await initialLoad;

    expect(request.mock.calls.filter(([method]) => method === "continuity.status")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "continuity.list")).toHaveLength(2);
    expect(state.continuityRecords).toEqual([recordApproved]);
    expect(state.continuityStatus?.counts.approved).toBe(1);
    expect(state.continuityBusyId).toBeNull();
    expect(state.continuityLoading).toBe(false);
  });
});
