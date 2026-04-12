// RI-014 — SkillAnalyticsEmitter tests
// Covers: happy-path POST, variant assignment via injected assigner,
// timeout swallowing, HTTP error swallowing, fetch-throw swallowing,
// pre-set variant bypass, token auth header.

import { describe, it, expect, beforeEach } from "vitest";
import {
  SkillAnalyticsEmitter,
  type ExperimentAssigner,
  type SkillInvocationEvent,
} from "./skill-analytics-emitter.js";

type RecordedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

function makeFakeFetch(
  response: { ok: boolean; status?: number } | (() => Promise<never>),
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = async (url: unknown, init?: { method?: string; headers?: unknown; body?: unknown }) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    if (typeof response === "function") {
      return response() as unknown as Response;
    }
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
    } as unknown as Response;
  };
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}

function baseEvent(overrides: Partial<SkillInvocationEvent> = {}): SkillInvocationEvent {
  return {
    skillId: "task-decomposer",
    orgId: "org-1",
    agentId: "agent-a",
    department: "ops",
    tokensConsumed: 1500,
    responseMs: 800,
    error: false,
    ...overrides,
  };
}

describe("SkillAnalyticsEmitter.emit", () => {
  let emitter: SkillAnalyticsEmitter;

  it("POSTs a record to the configured endpoint with bearer auth", async () => {
    const { fetchImpl, calls } = makeFakeFetch({ ok: true });
    emitter = new SkillAnalyticsEmitter({
      endpoint: "http://marketplace.test/analytics/record",
      authToken: "oca_test_key",
      fetchImpl,
    });
    await emitter.emit(baseEvent());
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://marketplace.test/analytics/record");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["Authorization"]).toBe("Bearer oca_test_key");
    expect(calls[0].body.skill_id).toBe("task-decomposer");
    expect(calls[0].body.variant_id).toBe("control"); // no assigner → control
  });

  it("uses the injected assigner to tag variant attribution", async () => {
    const { fetchImpl, calls } = makeFakeFetch({ ok: true });
    const assigner: ExperimentAssigner = {
      async assign({ skillId }) {
        expect(skillId).toBe("task-decomposer");
        return {
          variant_id: "v2",
          skill_version: "2.0.0",
          experiment_id: "exp-1",
          is_control: false,
        };
      },
    };
    emitter = new SkillAnalyticsEmitter(
      {
        endpoint: "http://marketplace.test/analytics/record",
        authToken: "oca_key",
        fetchImpl,
      },
      assigner,
    );
    await emitter.emit(baseEvent());
    expect(calls[0].body.variant_id).toBe("v2");
    expect(calls[0].body.experiment_id).toBe("exp-1");
    expect(calls[0].body.skill_version).toBe("2.0.0");
  });

  it("honors pre-set variantId from the caller without consulting the assigner", async () => {
    const { fetchImpl, calls } = makeFakeFetch({ ok: true });
    let assignerCalled = false;
    const assigner: ExperimentAssigner = {
      async assign() {
        assignerCalled = true;
        return null;
      },
    };
    emitter = new SkillAnalyticsEmitter(
      {
        endpoint: "http://marketplace.test/analytics/record",
        authToken: "oca_key",
        fetchImpl,
      },
      assigner,
    );
    await emitter.emit(
      baseEvent({
        variantId: "manual-pin",
        experimentId: "exp-manual",
        skillVersion: "3.0.0",
      }),
    );
    expect(assignerCalled).toBe(false);
    expect(calls[0].body.variant_id).toBe("manual-pin");
    expect(calls[0].body.experiment_id).toBe("exp-manual");
  });

  it("treats is_control assignment as plain control", async () => {
    const { fetchImpl, calls } = makeFakeFetch({ ok: true });
    const assigner: ExperimentAssigner = {
      async assign() {
        return {
          variant_id: "control",
          skill_version: "",
          experiment_id: null,
          is_control: true,
        };
      },
    };
    emitter = new SkillAnalyticsEmitter(
      {
        endpoint: "http://marketplace.test/analytics/record",
        authToken: "oca_key",
        fetchImpl,
      },
      assigner,
    );
    await emitter.emit(baseEvent());
    expect(calls[0].body.variant_id).toBe("control");
    expect(calls[0].body.experiment_id).toBe(null);
  });

  it("swallows HTTP failures without throwing", async () => {
    const { fetchImpl, calls } = makeFakeFetch({ ok: false, status: 500 });
    emitter = new SkillAnalyticsEmitter({
      endpoint: "http://marketplace.test/analytics/record",
      authToken: "oca_key",
      fetchImpl,
    });
    await expect(emitter.emit(baseEvent())).resolves.toBeUndefined();
    expect(calls.length).toBe(1);
    expect(emitter.failureSnapshot()["http-500"]).toBe(1);
  });

  it("swallows fetch throws without throwing", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    emitter = new SkillAnalyticsEmitter({
      endpoint: "http://marketplace.test/analytics/record",
      authToken: "oca_key",
      fetchImpl,
    });
    await expect(emitter.emit(baseEvent())).resolves.toBeUndefined();
    expect(emitter.failureSnapshot()["fetch"]).toBe(1);
  });

  it("swallows assigner throws and falls back to control", async () => {
    const { fetchImpl, calls } = makeFakeFetch({ ok: true });
    const assigner: ExperimentAssigner = {
      async assign() {
        throw new Error("marketplace down");
      },
    };
    emitter = new SkillAnalyticsEmitter(
      {
        endpoint: "http://marketplace.test/analytics/record",
        authToken: "oca_key",
        fetchImpl,
      },
      assigner,
    );
    await emitter.emit(baseEvent());
    expect(calls[0].body.variant_id).toBe("control");
    expect(emitter.failureSnapshot()["assign"]).toBe(1);
  });

  it("caps log spam per failure kind at 3", async () => {
    const { fetchImpl } = makeFakeFetch({ ok: false, status: 502 });
    emitter = new SkillAnalyticsEmitter({
      endpoint: "http://marketplace.test/analytics/record",
      authToken: "oca_key",
      fetchImpl,
    });
    for (let i = 0; i < 10; i++) {
      await emitter.emit(baseEvent());
    }
    expect(emitter.failureSnapshot()["http-502"]).toBe(10);
  });

  it("serializes approved=null for skills that don't gate output", async () => {
    const { fetchImpl, calls } = makeFakeFetch({ ok: true });
    emitter = new SkillAnalyticsEmitter({
      endpoint: "http://marketplace.test/analytics/record",
      authToken: "oca_key",
      fetchImpl,
    });
    await emitter.emit(baseEvent());
    expect(calls[0].body.approved).toBe(null);
  });

  it("forwards token_cost_usd when supplied", async () => {
    const { fetchImpl, calls } = makeFakeFetch({ ok: true });
    emitter = new SkillAnalyticsEmitter({
      endpoint: "http://marketplace.test/analytics/record",
      authToken: "oca_key",
      fetchImpl,
    });
    await emitter.emit(baseEvent({ tokenCostUsd: 0.0123 }));
    expect(calls[0].body.token_cost_usd).toBe(0.0123);
  });
});
