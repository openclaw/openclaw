import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { getActiveDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { catalogLog } from "./session-catalog-log.test-support.js";
import { listSessionCatalogProvider } from "./session-catalog-provider-access.js";

const privateText = "synthetic-private-catalog-label-and-content";
let clock = 0;
let previousDiagnostics: boolean;
let records: { fields: Record<string, unknown>; trace: unknown }[];

function provider(id: string, list: SessionCatalogProvider["list"]): SessionCatalogProvider {
  return {
    id,
    label: privateText,
    list,
    read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
  };
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
      records.push({ fields: fields ?? {}, trace: getActiveDiagnosticTraceContext() });
    }
  });
});

afterEach(() => {
  setDiagnosticsEnabledForProcess(previousDiagnostics);
  vi.restoreAllMocks();
});

describe("session catalog provider diagnostics", () => {
  it("reports cancelled waiters without releasing an aborted active provider", async () => {
    const gate = createDeferredCore<SessionCatalogHost[]>();
    const activeOwner = new AbortController();
    const blocker = provider("active-catalog", () => gate.promise);
    const active = Array.from({ length: 16 }, (_, index) =>
      listSessionCatalogProvider(
        { ...blocker, id: `active-catalog-${index}` },
        { signal: activeOwner.signal },
      ),
    );
    const queuedOwner = new AbortController();
    const list = vi.fn(async () => []);
    const reason = new Error(privateText);
    const cancelled = listSessionCatalogProvider(provider("cancelled-catalog", list), {
      signal: queuedOwner.signal,
    }).catch((error: unknown) => error);
    let successor: Promise<SessionCatalogHost[]> | undefined;
    try {
      clock = 1_500;
      queuedOwner.abort(reason);
      await expect(cancelled).resolves.toBe(reason);
      expect(list).not.toHaveBeenCalled();
      expect(records).toHaveLength(1);
      expect(records[0]?.fields).toMatchObject({
        elapsedMs: 1_500,
        admitted: false,
        providerInvoked: false,
        outcome: "rejected",
        signalAborted: true,
      });
      expect(records[0]?.fields).not.toHaveProperty("admissionWaitMs");
      expect(records[0]?.fields).not.toHaveProperty("providerElapsedMs");
      expect(records[0]?.fields).not.toHaveProperty("completionDelayMs");
      activeOwner.abort(reason);
      successor = listSessionCatalogProvider(provider("successor-catalog", list), {});
      await Promise.resolve();
      expect(list).not.toHaveBeenCalled();
      expect(records).toHaveLength(1);
      clock = 2_300;
      gate.resolve([]);
      await Promise.all([...active, successor]);
      expect(list).toHaveBeenCalledOnce();
      expect(records.filter(({ fields }) => fields.providerInvoked)).toHaveLength(16);
      for (const record of records.slice(1)) {
        expect(record.fields).toMatchObject({
          outcome: "resolved",
          signalAborted: true,
          providerInvoked: true,
          providerElapsedMs: 2_300,
        });
      }
      expect(JSON.stringify(records)).not.toContain(privateText);
    } finally {
      gate.resolve([]);
      await Promise.allSettled([...active, cancelled, ...(successor ? [successor] : [])]);
    }
  });

  it.each(["sync"])("preserves a %s failure when its diagnostic sink throws", async (mode) => {
    const failure = new Error(privateText);
    vi.mocked(catalogLog.warn).mockImplementation(() => {
      throw new Error("synthetic sink failure");
    });
    const list = () => {
      clock = 1_500;
      if (mode === "sync") {
        throw failure;
      }
      return Promise.reject(failure);
    };
    await expect(listSessionCatalogProvider(provider("failed-catalog", list), {})).rejects.toBe(
      failure,
    );
    expect(catalogLog.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(catalogLog.warn).mock.calls[0]?.[1]).toMatchObject({
      providerInvoked: true,
      outcome: "rejected",
      signalAborted: false,
      providerElapsedMs: 1_500,
    });
    expect(JSON.stringify(vi.mocked(catalogLog.warn).mock.calls)).not.toContain(privateText);
  });

  it("bounds host inspection and omits oversized provider identity", async () => {
    const hosts = Array.from({ length: 513 }, (_, index): SessionCatalogHost => ({
      hostId: privateText,
      label: privateText,
      get kind(): SessionCatalogHost["kind"] {
        if (index === 512) {
          throw new Error("diagnostics must not inspect hosts beyond the bound");
        }
        return "gateway";
      },
      connected: true,
      sessions: [],
    }));
    const id = privateText.repeat(10);
    await expect(
      listSessionCatalogProvider(
        provider(id, async () => {
          clock = 1_500;
          return hosts;
        }),
        {},
      ),
    ).resolves.toBe(hosts);
    expect(records).toHaveLength(1);
    expect(records[0]?.trace).toBeUndefined();
    expect(records[0]?.fields).toMatchObject({
      returnedHostCount: 513,
      hostCountsComplete: false,
      returnedGatewayHostCount: 512,
      returnedNodeHostCount: 0,
    });
    expect(records[0]?.fields).not.toHaveProperty("providerIdHash");
    expect(JSON.stringify(records)).not.toContain(privateText);
  });
});
