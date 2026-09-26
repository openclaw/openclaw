import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { DebugProxySettings } from "./env.js";
import type { CaptureOwner } from "./runtime-owner.js";
import type { CapturedResponseBodyResult } from "./runtime-response-body.js";
import { captureHttpExchangeAsync, finalizeDebugProxyCaptureAsync } from "./runtime.js";
import type { CaptureEventRecord } from "./types.js";

const fixture = vi.hoisted(() => ({
  retired: false,
  acquisitions: 0,
  endSessions: 0,
  completedBodies: 0,
  events: [] as CaptureEventRecord[],
  lostTerminal: new Error("Retired capture lost its terminal write"),
  requestAccepted: undefined as (() => void) | undefined,
  bodyRegistered: undefined as (() => void) | undefined,
  finishBody: undefined as (() => void) | undefined,
}));

vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: (): OpenClawStateWorkerContext => ({
    admission: {
      databasePath: "/synthetic/capture.sqlite",
      identity: { key: "synthetic-capture", canonicalPath: "/synthetic/capture.sqlite" },
      assertCurrent: () => {},
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
    coordinatorRuntime: { directory: "/synthetic/coordinators", keepAlive: false },
  }),
}));

vi.mock("../state/openclaw-state-db-async-lifecycle.js", () => ({
  getOpenClawDatabaseMaintenanceScope: () => undefined,
}));

vi.mock("./store.sqlite.js", () => ({
  getDebugProxyCaptureStore: () => {
    throw new Error("Retired capture must not acquire a synchronous store");
  },
  persistEventPayload: () => {
    throw new Error("Retired capture must not persist synchronously");
  },
  safeJsonString: JSON.stringify,
}));

vi.mock("./store.async.js", () => ({
  createDebugProxyCaptureStoreForContext: () => {
    fixture.acquisitions += 1;
    const record = async (event: CaptureEventRecord) => {
      if (fixture.retired) {
        throw fixture.lostTerminal;
      }
      fixture.events.push(event);
      fixture.requestAccepted?.();
    };
    const release = async () => {
      if (!fixture.retired) {
        throw new Error("Fixture expects canonical retirement before release");
      }
      // Canonical invalidation releases native custody without a domain finalizer.
    };
    const store = {
      dbPath: "/synthetic/capture.sqlite",
      get isClosed() {
        return fixture.retired;
      },
      recordEvent: record,
      recordEventWithPayload: record,
      endSession: async () => {
        fixture.endSessions += 1;
        throw fixture.lostTerminal;
      },
      close: release,
    };
    return {
      store,
      ready: Promise.resolve(),
      runOperation: <T>(operation: (scope: typeof store) => Promise<T>) => operation(store),
      release,
    };
  },
}));

vi.mock("./runtime-response-body.js", () => ({
  readCapturedResponseBodyBounded: (
    _response: Response,
    owner: CaptureOwner,
    record: (result: CapturedResponseBodyResult) => void,
  ) => {
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      owner.pending.delete(finish);
      fixture.completedBodies += 1;
      record({ status: "finalized", buffer: Buffer.from("accepted body") });
    };
    fixture.finishBody = finish;
    owner.pending.add(finish);
    fixture.bodyRegistered?.();
  },
}));

function containedErrors(error: unknown): unknown[] {
  return [error, ...(error instanceof AggregateError ? error.errors.flatMap(containedErrors) : [])];
}

it("settles accepted capture and reports lost terminal writes after canonical retirement", async () => {
  const requestAccepted = createDeferredCore();
  const bodyRegistered = createDeferredCore();
  fixture.requestAccepted = requestAccepted.resolve;
  fixture.bodyRegistered = bodyRegistered.resolve;
  const settings: DebugProxySettings = {
    enabled: true,
    required: false,
    dbPath: "/synthetic/capture.sqlite",
    blobDir: "/synthetic/blobs",
    certDir: "/synthetic/certs",
    sessionId: "retired-capture",
    sourceProcess: "fixture",
  };
  const capturing = captureHttpExchangeAsync(
    {
      url: "https://capture.example.invalid/ordinary-response",
      method: "GET",
      flowId: "accepted-flow",
      response: new Response("synthetic response", { status: 200 }),
    },
    settings,
  );
  let captureSettled = false;
  const settled = () => {
    captureSettled = true;
  };
  void capturing.then(settled, settled);

  try {
    await Promise.all([requestAccepted.promise, bodyRegistered.promise]);
    expect(fixture.events).toHaveLength(1);
    expect(fixture.events[0]?.kind).toBe("request");
    expect(captureSettled).toBe(false);
    fixture.retired = true;

    const finalizationError = await finalizeDebugProxyCaptureAsync(settings).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(finalizationError).toBeInstanceOf(AggregateError);
    expect(containedErrors(finalizationError)).toContain(fixture.lostTerminal);
    expect(fixture.completedBodies).toBe(1);
    expect(captureSettled).toBe(true);
    await expect(capturing).rejects.toBe(fixture.lostTerminal);
    expect(fixture.endSessions).toBe(0);
    expect(fixture.acquisitions).toBe(1);
    expect(fixture.events).toHaveLength(1);
  } finally {
    fixture.retired = true;
    fixture.finishBody?.();
    await Promise.allSettled([capturing, finalizeDebugProxyCaptureAsync(settings)]);
  }
});
