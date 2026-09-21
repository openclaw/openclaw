import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { catalogLog } from "./session-catalog-log.test-support.js";
import { listSessionCatalogProvider } from "./session-catalog-provider-access.js";

const privateText = "synthetic-private-catalog-label-and-content";
const queuedTrace = { traceId: "1234567890abcdef1234567890abcdef", spanId: "1234567890abcdef" };
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
  it("separates queue, provider and drain delay without exposing provider or host content", async () => {
    const gates = Array.from({ length: 4 }, () => createDeferredCore<SessionCatalogHost[]>());
    const active = gates.map((gate, index) =>
      listSessionCatalogProvider(
        provider(`blocker-${index}`, () => gate.promise),
        {},
      ),
    );
    const hosts: SessionCatalogHost[] = [
      { hostId: privateText, label: privateText, kind: "gateway", connected: true, sessions: [] },
      {
        hostId: privateText,
        label: privateText,
        kind: "node",
        connected: false,
        error: { code: privateText, message: privateText },
        get sessions(): SessionCatalogHost["sessions"] {
          throw new Error("diagnostics must not inspect session rows");
        },
      },
    ];
    const list = vi.fn(() => {
      clock = 2_500;
      return Promise.resolve(hosts);
    });
    clock = 100;
    const queued = runWithDiagnosticTraceContext(queuedTrace, () =>
      listSessionCatalogProvider(provider(privateText, list), {}),
    );
    try {
      expect(list).not.toHaveBeenCalled();
      clock = 2_100;
      gates[0]!.resolve([]);
      await active[0];
      await expect(queued).resolves.toBe(hosts);
      const record = records.find(
        ({ fields }) =>
          fields.providerIdHash === createHash("sha256").update(privateText).digest("hex"),
      );
      expect(record).toMatchObject({
        trace: queuedTrace,
        fields: {
          operation: "sessions.catalog.list",
          admitted: true,
          providerInvoked: true,
          admissionWaitMs: 2_000,
          providerElapsedMs: 400,
          stepCount: 1,
          admittedStepMs: 400,
          completionDelayMs: 0,
          elapsedMs: 2_400,
          outcome: "resolved",
          signalAborted: false,
          returnedHostCount: 2,
          hostCountsComplete: true,
          returnedGatewayHostCount: 1,
          returnedNodeHostCount: 1,
          returnedConnectedHostCount: 1,
          returnedErrorHostCount: 1,
        },
      });
      expect(
        records.find(
          ({ fields }) =>
            fields.providerIdHash === createHash("sha256").update("blocker-0").digest("hex"),
        )?.fields,
      ).toMatchObject({
        providerElapsedMs: 2_100,
        stepCount: 1,
        admittedStepMs: 2_100,
        completionDelayMs: 400,
      });
      expect(JSON.stringify(records)).not.toContain(privateText);
    } finally {
      for (const gate of gates) {
        gate.resolve([]);
      }
      await Promise.allSettled([...active, queued]);
    }
  });

  it("reports cancelled waiters without releasing an aborted active provider", async () => {
    const gate = createDeferredCore<SessionCatalogHost[]>();
    const activeOwner = new AbortController();
    const blocker = provider("active-catalog", () => gate.promise);
    const active = Array.from({ length: 4 }, (_, index) =>
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
      expect(records.filter(({ fields }) => fields.providerInvoked)).toHaveLength(4);
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

  it.each(["sync", "async"])(
    "preserves a %s failure when its diagnostic sink throws",
    async (mode) => {
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
    },
  );

  it.each(["disabled", "sink-disabled", "disabled-during-call", "enabled-during-call", "fast"])(
    "leaves diagnostics silent for %s calls",
    async (mode) => {
      if (mode === "disabled" || mode === "enabled-during-call") {
        setDiagnosticsEnabledForProcess(false);
      }
      if (mode === "sink-disabled") {
        vi.mocked(catalogLog.isEnabled).mockReturnValue(false);
      }
      const hosts: SessionCatalogHost[] = [];
      const list = async () => {
        clock = mode === "fast" ? 999 : 1_500;
        if (mode === "disabled-during-call" || mode === "enabled-during-call") {
          setDiagnosticsEnabledForProcess(mode === "enabled-during-call");
        }
        return hosts;
      };
      await expect(listSessionCatalogProvider(provider("quiet-catalog", list), {})).resolves.toBe(
        hosts,
      );
      expect(catalogLog.warn).not.toHaveBeenCalled();
    },
  );

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
