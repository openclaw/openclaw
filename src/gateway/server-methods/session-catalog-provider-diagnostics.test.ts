import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { catalogLog } from "./session-catalog-log.test-support.js";
import { listSessionCatalogProvider } from "./session-catalog-provider-access.js";
import { catalogHost, catalogProvider } from "./session-catalog.fixtures.test-support.js";

const privateText = "synthetic-private-catalog-label-and-content";
let clock = 0;
let previousDiagnostics: boolean;
let records: Record<string, unknown>[];

function listCatalog(id: string, list: SessionCatalogProvider["list"], signal?: AbortSignal) {
  return listSessionCatalogProvider(catalogProvider(id, { label: privateText, list }), { signal });
}

beforeEach(() => {
  previousDiagnostics = areDiagnosticsEnabledForProcess();
  setDiagnosticsEnabledForProcess(true);
  clock = 0;
  records = [];
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  catalogLog.isEnabled.mockReset().mockReturnValue(true);
  catalogLog.debug.mockReset();
  catalogLog.warn.mockReset().mockImplementation((message, fields) => {
    if (message === "slow session catalog provider list") {
      records.push(fields ?? {});
    }
  });
});

afterEach(() => {
  setDiagnosticsEnabledForProcess(previousDiagnostics);
  vi.restoreAllMocks();
});

it("reports queued cancellation separately from active provider completion", async () => {
  const gate = createDeferredCore<SessionCatalogHost[]>();
  const activeOwner = new AbortController();
  const active = Array.from({ length: 16 }, (_, index) =>
    listCatalog(`active-catalog-${index}`, () => gate.promise, activeOwner.signal),
  );
  const queuedOwner = new AbortController();
  const reason = new Error(privateText);
  const cancelled = listCatalog("cancelled-catalog", async () => [], queuedOwner.signal).catch(
    (error: unknown) => error,
  );
  try {
    clock = 1_500;
    queuedOwner.abort(reason);
    await expect(cancelled).resolves.toBe(reason);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      elapsedMs: 1_500,
      admitted: false,
      providerInvoked: false,
      outcome: "rejected",
      signalAborted: true,
    });
    for (const key of ["admissionWaitMs", "providerElapsedMs", "completionDelayMs"]) {
      expect(records[0]).not.toHaveProperty(key);
    }
    activeOwner.abort(reason);
    clock = 2_300;
    gate.resolve([]);
    await Promise.all(active);
    expect(records).toHaveLength(17);
    for (const record of records.slice(1)) {
      expect(record).toMatchObject({
        outcome: "resolved",
        signalAborted: true,
        providerInvoked: true,
        providerElapsedMs: 2_300,
      });
    }
    expect(JSON.stringify(records)).not.toContain(privateText);
  } finally {
    gate.resolve([]);
    await Promise.allSettled([...active, cancelled]);
  }
});

it("preserves a synchronous failure when its diagnostic sink throws", async () => {
  const failure = new Error(privateText);
  vi.mocked(catalogLog.warn).mockImplementation(() => {
    throw new Error("synthetic sink failure");
  });
  const list = () => {
    clock = 1_500;
    throw failure;
  };
  await expect(listCatalog("failed-catalog", list)).rejects.toBe(failure);
  expect(vi.mocked(catalogLog.warn).mock.calls[0]?.[1]).toMatchObject({
    providerInvoked: true,
    outcome: "rejected",
    signalAborted: false,
    providerElapsedMs: 1_500,
  });
  expect(JSON.stringify(vi.mocked(catalogLog.warn).mock.calls)).not.toContain(privateText);
});

it("bounds host inspection and omits oversized provider identity", async () => {
  const host = catalogHost({ hostId: privateText, label: privateText });
  const hosts = [
    ...Array<SessionCatalogHost>(512).fill(host),
    {
      ...host,
      get kind(): SessionCatalogHost["kind"] {
        throw new Error("diagnostics must not inspect hosts beyond the bound");
      },
    },
  ];
  const id = privateText.repeat(10);
  await expect(
    listCatalog(id, async () => {
      clock = 1_500;
      return hosts;
    }),
  ).resolves.toBe(hosts);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    returnedHostCount: 513,
    hostCountsComplete: false,
    returnedGatewayHostCount: 512,
    returnedNodeHostCount: 0,
  });
  expect(records[0]).not.toHaveProperty("providerIdHash");
  expect(JSON.stringify(records)).not.toContain(privateText);
});
