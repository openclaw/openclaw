// @vitest-environment node
import { expect, it } from "vitest";
import type { SessionsPatchResult } from "../../../../src/gateway/session-utils.types.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionsResult } from "./session-capability.test-support.ts";
import {
  sessionRpcHarness as modelHarness,
  sessionRow,
  patchReceipt,
} from "./session-rpc.test-support.ts";

const key = "agent:main:main";
const lowSettings = { thinkingLevel: "low", fastMode: false, contextWindow: "standard" } as const;
const highSettings = { thinkingLevel: "high", fastMode: true, contextWindow: "large" } as const;
function modelRow(overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return sessionRow("main", {
    sessionId: "main-session",
    updatedAt: 1,
    model: "gpt-5.4",
    modelProvider: "openai",
    ...overrides,
  });
}
function modelReceipt(model: string, sessionId: string, updatedAt: number): SessionsPatchResult {
  return {
    ...patchReceipt(key, { sessionId, updatedAt, modelOverrideSource: "user" }, ""),
    resolved: { modelProvider: "openai", model },
  };
}

it.each(
  ["primary", "supplemental", "descriptor"].flatMap((source) =>
    ["success", "rejection"].flatMap((outcome) =>
      (["compact", "dashboard"] as const).map((rowMode) => ({ source, outcome, rowMode })),
    ),
  ),
)(
  "preserves omitted $rowMode settings through $source reads and patch $outcome",
  async ({ source, outcome, rowMode }) => {
    const initial = sessionRow("compact-settings", { updatedAt: 1, ...lowSettings });
    let listed = initial;
    const reply = createDeferred<unknown>();
    const dispatched = createDeferred();
    const { sessions, client } = modelHarness(
      {
        "sessions.list": () => sessionsResult([listed], 2),
        "sessions.describe": () => ({ session: listed }),
        "sessions.patch": () => {
          dispatched.resolve();
          return reply.promise;
        },
      },
      createTestGatewayClient,
    );
    let operation: ReturnType<typeof sessions.patch> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      operation = sessions.patch(initial.key, highSettings, {
        agentId: "main",
        expectedSessionId: initial.sessionId,
        deferListRefresh: true,
      });
      await dispatched.promise;
      listed = sessionRow("compact-settings", { updatedAt: 2, rowMode });
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
      expect(sessions.state.result?.sessions[0]).toMatchObject(highSettings);
      if (outcome === "rejection") {
        const rejected = expect(operation).rejects.toThrow("Settings rejected");
        reply.reject(new Error("Settings rejected"));
        await rejected;
        expect(sessions.state.result?.sessions[0]).toMatchObject(lowSettings);
      } else {
        reply.resolve(patchReceipt(initial.key, { ...initial, ...highSettings, updatedAt: 3 }, ""));
        await operation;
        expect(sessions.state.result?.sessions[0]).toMatchObject(highSettings);
      }
    } finally {
      reply.resolve(patchReceipt(initial.key, initial, ""));
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
      "sessions.patch": () => (++patchCount === 1 ? { ok: true, key, entry: {} } : pending.promise),
      "sessions.delete": () => ({ deleted: true }),
      "sessions.list": () => sessionsResult([], 2),
    });
    await sessions.patch(key, { model: "openai/gpt-old" }, { deferListRefresh: true });
    const operation = sessions.patch(key, { model: "openai/gpt-new" }, { deferListRefresh: true });
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
    const model = "gpt-5.4";
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
      second.resolve(modelReceipt("gpt-5.4", sessionId, 3));
      await newer;
    }
    first.resolve(modelReceipt("gpt-5.5", "main-session", 2));
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
