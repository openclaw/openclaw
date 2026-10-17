// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { SessionsPatchResult } from "../../../../src/gateway/session-utils.types.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const key = "agent:main:main";
const lowSettings = { thinkingLevel: "low", fastMode: false, contextWindow: "standard" } as const;
const highSettings = { thinkingLevel: "high", fastMode: true, contextWindow: "large" } as const;
function modelRow(overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    sessionId: "main-session",
    updatedAt: 1,
    model: "gpt-5.4",
    modelProvider: "openai",
    ...overrides,
  };
}

function modelHarness(handlers: Record<string, () => unknown>) {
  const request = vi.fn(async (method: string) => {
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return handler();
  });
  const harness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  return { ...harness, request, sessions: createTestSessionCapability(harness.gateway) };
}

describe("session model override lifecycle", () => {
  it.each(
    (
      [
        { source: "primary", outcome: "success" },
        { source: "primary", outcome: "rejection" },
        { source: "supplemental", outcome: "success" },
        { source: "supplemental", outcome: "rejection" },
        { source: "descriptor", outcome: "success" },
        { source: "descriptor", outcome: "rejection" },
      ] as const
    ).flatMap((scenario) =>
      (["compact", "dashboard"] as const).map((rowMode) =>
        Object.assign({}, scenario, { rowMode }),
      ),
    ),
  )(
    "preserves omitted $rowMode settings through $source reads and patch $outcome",
    async ({ source, outcome, rowMode }) => {
      const initial: GatewaySessionRow = {
        key: "agent:main:compact-settings",
        sessionId: "compact-settings",
        kind: "direct",
        updatedAt: 1,
        ...lowSettings,
      };
      const next = highSettings;
      let listed = initial;
      const reply = createDeferred<unknown>();
      const dispatched = createDeferred();
      const client = createTestGatewayClient(async (method) => {
        if (method === "sessions.list") {
          return sessionsResult([listed], 2);
        }
        if (method === "sessions.describe") {
          return { session: listed };
        }
        if (method === "sessions.patch") {
          dispatched.resolve();
          return reply.promise;
        }
        throw new Error(`Unexpected Gateway method: ${method}`);
      });
      const sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
      let operation: ReturnType<typeof sessions.patch> | undefined;
      try {
        await sessions.refresh({ agentId: "main", force: true });
        operation = sessions.patch(initial.key, next, {
          agentId: "main",
          expectedSessionId: initial.sessionId,
          deferListRefresh: true,
        });
        await dispatched.promise;
        listed = {
          key: initial.key,
          sessionId: initial.sessionId,
          kind: "direct",
          updatedAt: 2,
          rowMode,
        };
        if (source === "primary") {
          await sessions.refresh({ agentId: "main", force: true });
        } else {
          const reconcile = sessions.captureReconcile();
          const row =
            source === "descriptor"
              ? (
                  await client.request<{ session: GatewaySessionRow }>("sessions.describe", {
                    key: initial.key,
                    agentId: "main",
                  })
                ).session
              : (await sessions.list({ agentId: "main" }))?.sessions[0];
          reconcile(row);
        }
        expect(sessions.state.result?.sessions[0]).toMatchObject(next);
        if (outcome === "rejection") {
          const rejected = expect(operation).rejects.toThrow("Settings rejected");
          reply.reject(new Error("Settings rejected"));
          await rejected;
          expect(sessions.state.result?.sessions[0]).toMatchObject(lowSettings);
        } else {
          reply.resolve({
            ok: true,
            key: initial.key,
            path: "",
            entry: { ...initial, ...next, updatedAt: 3 },
          });
          await operation;
          expect(sessions.state.result?.sessions[0]).toMatchObject(next);
        }
      } finally {
        reply.resolve({ ok: true, key: initial.key, path: "", entry: initial });
        await operation?.catch(() => undefined);
        sessions.dispose();
      }
    },
  );

  it.each(["resolve", "reject"])(
    "does not resurrect a deleted session's model when its pending patch %s",
    async (outcome) => {
      const pending = createDeferred<unknown>();
      let patchCount = 0;
      const { sessions } = modelHarness({
        "sessions.patch": () =>
          ++patchCount === 1 ? { ok: true, key, entry: {} } : pending.promise,
        "sessions.delete": () => ({ deleted: true }),
        "sessions.list": () => sessionsResult([], 2),
      });
      await sessions.patch(key, { model: "openai/gpt-old" }, { deferListRefresh: true });
      const operation = sessions.patch(
        key,
        { model: "openai/gpt-new" },
        { deferListRefresh: true },
      );
      expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-new");
      await expect(sessions.delete(key)).resolves.toMatchObject({ deleted: true });
      expect(sessions.state.modelOverrides).toEqual({});
      if (outcome === "resolve") {
        pending.resolve({ ok: true, key, entry: {} });
        await operation;
      } else {
        pending.reject(new Error("model rejected"));
        await expect(operation).rejects.toThrow("model rejected");
      }
      expect(sessions.state.modelOverrides).toEqual({});
    },
  );

  it("retains a confirmed patch without publishing its retired optimistic state", async () => {
    const stalePatch = createDeferred<unknown>();
    const { sessions, request, publish } = modelHarness({
      "sessions.patch": () => stalePatch.promise,
      "sessions.subscribe": () => ({ subscribed: true }),
      "sessions.list": () => sessionsResult([], 2),
    });
    const inactiveKey = "agent:main:inactive";
    const inactiveOperation = sessions.patch(inactiveKey, { model: "openai/gpt-old-account" });

    const operation = sessions.patch(key, { model: "openai/gpt-new" });
    expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-new");

    publish(false);
    expect(sessions.state.modelOverrides).toEqual({});
    publish(true);
    stalePatch.resolve({ ok: true, path: "", key, entry: {} });

    await expect(operation).resolves.toMatchObject({ ok: true, key });
    await inactiveOperation;
    expect(sessions.state.modelOverrides).toEqual({});
    expect(sessions.state.error).toContain("completed on the previous connection");
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.list").length,
    ).toBeGreaterThan(0);
  });

  it("does not dispatch a queued patch on a replacement connection", async () => {
    const priorPatch = createDeferred();
    const { sessions, request, publish } = modelHarness({
      "sessions.patch": () => ({ ok: true, path: "", key, entry: {} }),
      "sessions.subscribe": () => ({ subscribed: true }),
      "sessions.list": () => sessionsResult([], 2),
    });

    const operation = sessions.patch(
      key,
      { model: "openai/gpt-new" },
      { waitFor: priorPatch.promise },
    );
    expect(sessions.state.modelOverrides[key]).toBeUndefined();
    expect(request).not.toHaveBeenCalledWith("sessions.patch", expect.anything());

    publish(false);
    publish(true);
    priorPatch.resolve();

    await expect(operation).resolves.toBeNull();
    expect(request).not.toHaveBeenCalledWith("sessions.patch", expect.anything());
    expect(sessions.state.modelOverrides[key]).toBeUndefined();
  });

  it.each(["selected", "default"] as const)(
    "keeps a confirmed %s model after failed reads, then admits an external change",
    async (selection) => {
      let failReads = false;
      let model = "gpt-5.4";
      let updatedAt = 1;
      const { sessions } = modelHarness({
        "sessions.patch": () => {
          return {
            ok: true,
            key,
            path: "",
            entry: {
              sessionId: "main-session",
              updatedAt: 2,
              modelOverrideSource: selection === "default" ? "default" : "user",
            },
            resolved: {
              modelProvider: "openai",
              model: "gpt-5.5",
              ...(selection === "selected"
                ? {
                    thinkingLevel: "high",
                    thinkingLevels: [{ id: "high", label: "High" }],
                    contextWindow: "large",
                    contextWindows: [{ id: "large", label: "Large", contextWindow: 200_000 }],
                  }
                : {}),
            },
          } satisfies SessionsPatchResult;
        },
        "sessions.subscribe": () => ({ subscribed: true }),
        "sessions.list": () => {
          if (failReads) {
            throw new Error("roster unavailable");
          }
          return sessionsResult(
            [
              modelRow({
                updatedAt,
                model,
                modelOverrideSource: "user",
                thinkingLevel: "low",
                contextWindow: "standard",
              }),
            ],
            updatedAt,
          );
        },
      });
      await sessions.refresh({ force: true });
      failReads = true;
      await sessions.patch(key, {
        model: selection === "default" ? null : "openai/gpt-5.5",
      });
      expect(sessions.state.result?.sessions[0]).toMatchObject({
        model: "gpt-5.5",
        modelProvider: "openai",
        modelOverrideSource: selection === "default" ? null : "user",
      });
      expect(sessions.state.modelOverrides).toEqual({});
      expect(sessions.state.error).toContain("roster unavailable");
      expect(sessions.state.result?.sessions[0]).toMatchObject(
        selection === "selected"
          ? {
              thinkingLevel: "high",
              contextWindow: "large",
              thinkingLevels: [{ id: "high", label: "High" }],
            }
          : { thinkingLevel: "low", contextWindow: "standard" },
      );
      failReads = false;
      model = "gpt-5.4";
      updatedAt = 3;
      await sessions.refresh({ force: true });
      expect(sessions.state.result?.sessions[0]?.model).toBe("gpt-5.4");
    },
  );

  it.each(["replacement", "newer-fails", "newer-succeeds"] as const)(
    "fences a confirmed model receipt during %s",
    async (scenario) => {
      const first = createDeferred<unknown>();
      const second = createDeferred<unknown>();
      let patchCount = 0;
      let failReads = false;
      let sessionId = "main-session";
      const { sessions } = modelHarness({
        "sessions.patch": () => (++patchCount === 1 ? first.promise : second.promise),
        "sessions.subscribe": () => ({ subscribed: true }),
        "sessions.list": () => {
          if (failReads) {
            throw new Error("roster unavailable");
          }
          return sessionsResult(
            [modelRow({ sessionId, updatedAt: sessionId === "main-session" ? 1 : 3 })],
            1,
          );
        },
      });
      await sessions.refresh({ force: true });
      const operation = sessions.patch(key, { model: "openai/gpt-5.5" });
      if (scenario === "replacement") {
        sessionId = "replacement-session";
        await sessions.refresh({ force: true });
        expect(sessions.state.result?.sessions[0]?.sessionId).toBe(sessionId);
      }
      const newer =
        scenario !== "replacement" ? sessions.patch(key, { model: "openai/gpt-5.4" }) : null;
      failReads = true;
      if (scenario === "newer-succeeds") {
        second.resolve({
          ok: true,
          key,
          path: "",
          entry: { sessionId, updatedAt: 3, modelOverrideSource: "user" },
          resolved: { modelProvider: "openai", model: "gpt-5.4" },
        } satisfies SessionsPatchResult);
        await newer;
      }
      first.resolve({
        ok: true,
        key,
        path: "",
        entry: { sessionId: "main-session", updatedAt: 2, modelOverrideSource: "user" },
        resolved: { modelProvider: "openai", model: "gpt-5.5" },
      } satisfies SessionsPatchResult);
      await operation;
      if (newer && scenario === "newer-fails") {
        expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-5.4");
        const rejected = expect(newer).rejects.toThrow("model rejected");
        second.reject(new Error("model rejected"));
        await rejected;
      }
      expect(sessions.state.modelOverrides).toEqual({});
      expect(sessions.state.result?.sessions[0]).toMatchObject({
        sessionId,
        model: scenario === "newer-fails" ? "gpt-5.5" : "gpt-5.4",
      });
    },
  );
});
