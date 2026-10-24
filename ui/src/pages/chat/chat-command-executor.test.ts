import { describe, expect, it, vi } from "vitest";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../../../packages/gateway-protocol/src/startup-unavailable.js";
// @vitest-environment node
import { contextBudgetStatusFixture } from "../../../../src/config/sessions/context-budget.test-support.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  SessionsListResult,
  SessionsPatchResult,
} from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import {
  createResolvedModelPatch,
  createModelCatalog,
  OPENAI_GPT5_MINI_MODEL,
} from "../../test-helpers/chat-model.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { executeSlashCommand as executeSlashCommandImpl } from "./chat-command-executor.ts";

const resultText = (key: string, values?: Record<string, string>) =>
  t(`chat.commandResults.${key}`, values);

function mockRequests(responses: Record<string, () => unknown>) {
  const handlers = new Map(Object.entries(responses));
  return vi.fn(async (method: string) => {
    const respond = handlers.get(method);
    if (!respond) {
      throw new Error(`unexpected method: ${method}`);
    }
    return respond();
  });
}

function createCommandSessionCapability(client: GatewayBrowserClient): SessionCapability {
  const sessions = createTestSessionCapability({
    snapshot: { client, phase: "connected", hello: sessionMutationGatewayHello() },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });
  const patch: SessionCapability["patch"] = async (key, sessionPatch, options) =>
    await client.request<SessionsPatchResult>("sessions.patch", {
      key,
      ...(options?.agentId ? { agentId: options.agentId } : {}),
      ...sessionPatch,
    });
  return Object.assign(sessions, { patch });
}

function executeSlashCommand(
  client: GatewayBrowserClient,
  sessionKey: string,
  commandName: string,
  args: string,
  context: Omit<
    Parameters<typeof executeSlashCommandImpl>[4],
    "sessionAccessSnapshot" | "sessions"
  > & {
    sessionAccessSnapshot?: Parameters<typeof executeSlashCommandImpl>[4]["sessionAccessSnapshot"];
  } = {},
) {
  const {
    sessionAccessSnapshot = {
      client,
      hello: sessionMutationGatewayHello(),
      phase: "connected",
    },
    ...rest
  } = context;
  return executeSlashCommandImpl(client, sessionKey, commandName, args, {
    sessions: createCommandSessionCapability(client),
    ...rest,
    sessionAccessSnapshot,
  });
}

function runCommand(
  request: Parameters<typeof createTestGatewayClient>[0],
  command: string,
  args = "",
  sessionKey = "agent:main:main",
) {
  return executeSlashCommand(createTestGatewayClient(request), sessionKey, command, args);
}

function restrictedSnapshot(
  client: GatewayBrowserClient,
  methods: string[],
  scopes = ["operator.read"],
): Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> {
  return {
    client,
    phase: "connected",
    hello: {
      auth: { role: "operator", scopes },
      features: { methods },
    } as ApplicationGatewaySnapshot["hello"],
  };
}

function row(key: string, overrides?: Partial<GatewaySessionRow>): GatewaySessionRow {
  return { key, kind: "direct", updatedAt: null, ...overrides };
}

function createSessionsResult(sessions: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function requireRequestCall(
  request: ReturnType<typeof vi.fn>,
  method: string,
): { method: string; payload: Record<string, unknown> } {
  const call = request.mock.calls.find(([calledMethod]) => calledMethod === method);
  if (!call) {
    throw new Error(`expected ${method} request`);
  }
  return { method: call[0] as string, payload: call[1] as Record<string, unknown> };
}

function expectNoRequestCall(request: ReturnType<typeof vi.fn>, method: string) {
  expect(request.mock.calls.some(([calledMethod]) => calledMethod === method)).toBe(false);
}

function expectPatch(
  request: ReturnType<typeof vi.fn>,
  patch: Parameters<SessionCapability["patch"]>[1],
  key = "agent:main:main",
) {
  expect(request).toHaveBeenCalledWith("sessions.patch", { key, ...patch });
}

function mockSession(
  overrides: Partial<GatewaySessionRow>,
  responses: Record<string, () => unknown> = {},
) {
  return mockRequests({
    "sessions.describe": () => ({ session: row("agent:main:main", overrides) }),
    ...responses,
  });
}

describe("executeSlashCommand directives", () => {
  it("lets the canonical row retire a slash-command selection equal to the default", async () => {
    const key = "agent:main:main";
    const request = mockRequests({
      "sessions.patch": () => createResolvedModelPatch("gpt-5-mini", "openai"),
      "sessions.list": () =>
        createSessionsResult([
          row(key, {
            model: "gpt-5-mini",
            modelProvider: "openai",
            modelOverrideSource: null,
          }),
        ]),
    });
    const client = createTestGatewayClient(request);
    const snapshot = { client, phase: "connected" as const, hello: sessionMutationGatewayHello() };
    const sessions = createTestSessionCapability({
      snapshot,
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });
    const result = await executeSlashCommandImpl(client, key, "model", "openai/gpt-5-mini", {
      sessions,
      sessionAccessSnapshot: snapshot,
      chatModelCatalog: createModelCatalog(OPENAI_GPT5_MINI_MODEL),
    });
    expect(result.failed).not.toBe(true);
    expect(sessions.state.result?.sessions[0]?.modelOverrideSource).toBeNull();
    expect(sessions.state.modelOverrides).toEqual({});
    sessions.dispose();
  });

  it("does not compact a session without operator.admin", async () => {
    const request = vi.fn();
    const client = createTestGatewayClient(request);
    const result = await executeSlashCommand(client, "main", "compact", "", {
      sessionAccessSnapshot: restrictedSnapshot(client, ["sessions.compact"]),
    });
    expect(result.failed).toBe(true);
    expectNoRequestCall(request, "sessions.compact");
  });

  it.each([
    { name: "allows /model with operator.write", scopes: ["operator.write"], allowed: true },
    { name: "rejects /model without operator.write", scopes: ["operator.read"], allowed: false },
  ])("$name", async ({ scopes, allowed }) => {
    const request = vi.fn(async () => createResolvedModelPatch("gpt-5-mini", "openai"));
    const client = createTestGatewayClient(request);
    const result = await executeSlashCommand(client, "main", "model", "gpt-5-mini", {
      sessionAccessSnapshot: restrictedSnapshot(client, ["sessions.patch"], scopes),
      chatModelCatalog: [{ id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" }],
    });
    expect(result.failed === true).toBe(!allowed);
    if (allowed) {
      expect(requireRequestCall(request, "sessions.patch").payload).toMatchObject({
        key: "main",
        model: "gpt-5-mini",
      });
    } else {
      expectNoRequestCall(request, "sessions.patch");
    }
  });

  it("passes the captured chat owner to canonical model patching", async () => {
    const client = createTestGatewayClient(vi.fn());
    const patch = vi
      .fn()
      .mockResolvedValue(
        createResolvedModelPatch(OPENAI_GPT5_MINI_MODEL.id, OPENAI_GPT5_MINI_MODEL.provider),
      );
    const ownsModelOverride = vi.fn(() => true);
    const sessions = {
      ...createCommandSessionCapability(client),
      patch,
    } as SessionCapability;
    const result = await executeSlashCommandImpl(client, "global", "model", "gpt-5-mini", {
      sessions,
      sessionAccessSnapshot: {
        client,
        hello: sessionMutationGatewayHello(),
        phase: "connected",
      },
      agentId: "work",
      ownsModelOverride,
      chatModelCatalog: createModelCatalog(OPENAI_GPT5_MINI_MODEL),
    });
    expect(result.failed).not.toBe(true);
    expect(patch).toHaveBeenCalledWith(
      "global",
      { model: "gpt-5-mini" },
      expect.objectContaining({
        agentId: "work",
        ownsModelOverride,
      }),
    );
  });

  it.each(["connection", "scope"] as const)(
    "rechecks %s before patching after session loading",
    async (changed) => {
      const description = createDeferred<{ session: GatewaySessionRow }>();
      const request = mockRequests({
        "sessions.describe": () => description.promise,
        "sessions.patch": () => ({ ok: true }),
      });
      const client = createTestGatewayClient(request);
      let current = true;
      let snapshot = restrictedSnapshot(client, ["sessions.patch"], ["operator.admin"]);
      const pending = executeSlashCommand(client, "agent:main:main", "think", "high", {
        isCurrent: () => current,
        ...(changed === "scope"
          ? {
              sessionAccessSnapshot: snapshot,
              readSessionAccessSnapshot: () => snapshot,
            }
          : {}),
      });
      if (changed === "connection") {
        current = false;
      } else {
        snapshot = restrictedSnapshot(client, ["sessions.patch"]);
      }
      description.resolve({
        session: row("agent:main:main", { thinkingOptions: ["off", "low", "high"] }),
      });
      expect((await pending).failed).toBe(true);
      expectNoRequestCall(request, "sessions.patch");
    },
  );

  it("resolves the legacy main alias for bare /model", async () => {
    const request = mockSession(
      {
        model: "gpt-4.1-mini",
      },
      {
        "models.list": () => ({
          models: [{ id: "gpt-4.1-mini" }, { id: "gpt-4.1" }],
        }),
      },
    );
    const result = await runCommand(request, "model", "", "main");
    expect(result.content).toBe(
      [
        resultText("model.current", { model: "`gpt-4.1-mini`" }),
        resultText("model.available", {
          models: "`gpt-4.1-mini`, `gpt-4.1`",
          remaining: "",
        }),
      ].join("\n"),
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.describe", {
      key: "main",
      agentId: "main",
    });
    expect(request).toHaveBeenNthCalledWith(2, "models.list", {
      sessionKey: "main",
      agentId: "main",
      view: "configured",
    });
  });

  it.each([false, true])(
    "reports model defaults only for the default agent (default=%s)",
    async (isDefault) => {
      const model = isDefault ? "work-default" : "work-model";
      const request = mockRequests({
        "sessions.describe": () => ({ session: null }),
        ...(isDefault
          ? {
              "sessions.list": () => ({
                defaults: { modelProvider: "openai", model },
                sessions: [],
              }),
            }
          : {}),
      });
      const result = await executeSlashCommand(
        createTestGatewayClient(request),
        "agent:work:main",
        "model",
        "",
        {
          agentId: "work",
          ...(isDefault ? { defaultAgentId: "work" } : {}),
          chatModelCatalog: [{ id: model, name: model, provider: "openai", available: true }],
        },
      );
      expect(result.content).toBe(
        [
          resultText("model.current", { model: isDefault ? "`work-default`" : "`default`" }),
          resultText("model.available", {
            models: isDefault ? "`work-default`" : "`work-model`",
            remaining: "",
          }),
        ].join("\n"),
      );
      if (isDefault) {
        expect(requireRequestCall(request, "sessions.list").payload).toMatchObject({
          limit: 1,
          rowMode: "compact",
          agentId: "work",
        });
      }
    },
  );

  it("refreshes successful compaction without a duplicate command message", async () => {
    const request = mockRequests({ "sessions.compact": () => ({ ok: true, compacted: true }) });
    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "global",
      "compact",
      "",
      {
        agentId: "work",
      },
    );
    expect(result).toEqual({ action: "refresh" });
    expect(request).toHaveBeenCalledWith("sessions.compact", {
      key: "global",
      agentId: "work",
    });
  });

  it("surfaces terminal compaction failures instead of reporting a skip", async () => {
    const request = mockRequests({
      "sessions.compact": () => ({
        ok: false,
        compacted: false,
        reason: "codex app-server compaction timed out",
      }),
    });
    const result = await runCommand(request, "compact", "", "main");
    expect(result).toEqual({
      content: resultText("compaction.failedWithReason", {
        reason: "codex app-server compaction timed out",
      }),
      failed: true,
    });
  });

  it.each([false, true])(
    "keeps /usage context hidden when stale (usage unavailable: %s)",
    async (unavailable) => {
      const request = mockRequests({
        "sessions.describe": () => ({
          session: row("agent:main:main", {
            model: "gpt-4.1-mini",
            inputTokens: 1200,
            outputTokens: 300,
            totalTokens: 1500,
            totalTokensFresh: false,
            ...(unavailable ? { usageReport: { state: "unavailable" as const } } : {}),
            contextTokens: 4000,
          }),
        }),
      });

      const result = await runCommand(request, "usage");

      expect(result.content).toBe(
        [
          `**${resultText("usage.title")}**`,
          resultText("usage.inputTokens", {
            count: `**${unavailable ? resultText("usage.notAvailable") : "1.2k"}**`,
          }),
          resultText("usage.outputTokens", {
            count: `**${unavailable ? resultText("usage.notAvailable") : "300"}**`,
          }),
          resultText("usage.totalTokens", {
            count: `**${unavailable ? resultText("usage.notAvailable") : "~1.5k"}**`,
          }),
          resultText("usage.model", { model: "`gpt-4.1-mini`" }),
        ].join("\n"),
      );
      expect(request).toHaveBeenNthCalledWith(1, "sessions.describe", {
        key: "agent:main:main",
        agentId: "main",
      });
    },
  );

  it("uses the context snapshot for /usage while preserving cumulative total display", async () => {
    const request = mockSession({
      model: "gpt-4.1-mini",
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1250,
      contextTokens: 4000,
    });
    const result = await runCommand(request, "usage");
    expect(result.content).toBe(
      [
        `**${resultText("usage.title")}**`,
        resultText("usage.inputTokens", { count: "**1.2k**" }),
        resultText("usage.outputTokens", { count: "**300**" }),
        resultText("usage.totalTokens", { count: "**1.5k**" }),
        resultText("usage.context", { percent: "**31%**", total: "4k" }),
        resultText("usage.model", { model: "`gpt-4.1-mini`" }),
      ].join("\n"),
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.describe", {
      key: "agent:main:main",
      agentId: "main",
    });
  });

  it.each([
    ["think", "thinkingLevel", "thinking.reset"],
    ["fast", "fastMode", "fast.reset"],
  ] as const)("clears /%s default through the session patch owner", async (command, field, key) => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "sessions.patch") {
        return { ok: true, ...((payload ?? {}) as object) };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    expect(await runCommand(request, command, "default")).toEqual({
      content: resultText(key),
      action: "refresh",
    });
    expectPatch(request, { [field]: null });
  });

  it("uses default thinking options when the active session is absent", async () => {
    const levels = ["off", "minimal", "low", "medium", "adaptive", "high", "xhigh", "maximum"];
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "sessions.describe") {
        return { session: null };
      }
      if (method === "sessions.list") {
        return {
          defaults: {
            modelProvider: "openai",
            model: "gpt-5.5",
            thinkingLevels: levels.map((label) => ({
              id: label === "maximum" ? "max" : label,
              label,
            })),
            thinkingOptions: levels,
            thinkingDefault: "adaptive",
          },
          sessions: [],
        };
      }
      if (method === "models.list") {
        return {
          models: [{ id: "gpt-5.5", provider: "openai", reasoning: true }],
        };
      }
      if (method === "sessions.patch") {
        return { ok: true, ...((payload ?? {}) as object) };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const status = await runCommand(request, "think");
    const setXhigh = await runCommand(request, "think", "xhigh");
    const setMax = await runCommand(request, "think", "max");
    const setMaximum = await runCommand(request, "think", "maximum");
    const setAdaptive = await runCommand(request, "think", "auto");
    expect(status.content).toBe(
      [
        resultText("thinking.current", { level: "adaptive" }),
        resultText("options", {
          options: "default, off, minimal, low, medium, adaptive, high, xhigh, maximum",
        }),
      ].join("\n"),
    );
    expect(setXhigh.content).toBe(resultText("thinking.set", { level: "**xhigh**" }));
    expect(setMax.content).toBe(resultText("thinking.set", { level: "**max**" }));
    expect(setMaximum.content).toBe(resultText("thinking.set", { level: "**max**" }));
    expect(setAdaptive.content).toBe(resultText("thinking.set", { level: "**adaptive**" }));
    expectPatch(request, { thinkingLevel: "xhigh" });
    expectPatch(request, { thinkingLevel: "max" });
    expectPatch(request, { thinkingLevel: "adaptive" });
  });

  it("rejects thinking levels when the selected model advertises empty support", async () => {
    const request = mockSession(
      {
        modelProvider: "thinking-fixture",
        model: "selected",
        thinkingLevels: [],
      },
      {
        "sessions.patch": () => ({ ok: true }),
      },
    );
    const result = await runCommand(request, "think", "high");
    expect(result.content).toBe(
      resultText("thinking.unsupported", { level: "high", options: "none" }),
    );
    expectNoRequestCall(request, "sessions.patch");
  });

  it("reports the current verbose level for bare /verbose", async () => {
    const request = mockSession({ verboseLevel: "full" });
    const result = await runCommand(request, "verbose");
    expect(result.content).toBe(
      [
        resultText("verbose.current", { level: "full" }),
        resultText("options", { options: "on, full, off" }),
      ].join("\n"),
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.describe", {
      key: "agent:main:main",
      agentId: "main",
    });
  });

  it.each([
    { row: { fastMode: true }, seconds: "60", valueKey: "on", sourceKey: undefined },
    { row: { fastMode: "auto" }, seconds: "60", valueKey: "autoValue", sourceKey: undefined },
    {
      row: { effectiveFastMode: "auto", effectiveFastModeSource: "config", fastAutoOnSeconds: 30 },
      seconds: "30",
      valueKey: "autoValue",
      sourceKey: "sourceModel",
    },
  ] as const)(
    "reports bare /fast status for $row",
    async ({ row: session, seconds, valueKey, sourceKey }) => {
      const request = mockSession(session);
      const result = await runCommand(request, "fast");
      expect(result.content).toBe(
        [
          `${resultText("fast.current", {
            value: resultText(`fast.${valueKey}`, { seconds }),
          })}${sourceKey ? resultText(`fast.${sourceKey}`) : ""}.`,
          resultText("options", { options: resultText("fast.options", { seconds }) }),
        ].join("\n"),
      );
      expect(request).toHaveBeenNthCalledWith(1, "sessions.describe", {
        key: "agent:main:main",
        agentId: "main",
      });
    },
  );

  it.each([
    ["on", true, "enabled"],
    ["auto", "auto", "setAuto"],
  ] as const)("patches fast mode for /fast %s", async (arg, fastMode, resultKey) => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    expect((await runCommand(request, "fast", arg)).content).toBe(resultText(`fast.${resultKey}`));
    expectPatch(request, { fastMode });
  });
});

describe("executeSlashCommand /steer (soft inject)", () => {
  it.each([
    [{ status: "started", runId: "run-1" }, "succeeded"],
    [{ status: "ok", runId: "run-ok", messageSeq: 2 }, "succeeded"],
    [{ status: "timeout", runId: "run-timeout", summary: "aborted" }, "timeout"],
    [{ status: "error", runId: "run-error", summary: "aborted" }, "failed"],
  ] as const)("sends the selected session and settles a %j steer ACK", async (ack, key) => {
    const request = mockRequests({ "chat.send": () => ack });
    const result = await runCommand(request, "steer", "try a different approach");
    expect(result.content).toBe(resultText(`steer.${key}`));
    expect(result.failed ?? false).toBe(key !== "succeeded");
    if (key !== "succeeded") {
      expect(result.content).not.toBe(resultText("steer.succeeded"));
    }
    const { payload } = requireRequestCall(request, "chat.send");
    expect(payload).toMatchObject({
      sessionKey: "agent:main:main",
      message: "try a different approach",
      deliver: false,
      queueMode: "steer",
      idempotencyKey: expect.any(String),
    });
    expect(payload).not.toHaveProperty("expectedRunId");
    expect(payload).not.toHaveProperty("expectedLeafEntryId");
    expectNoRequestCall(request, "sessions.list");
  });

  it("returns steer usage when no message is provided", async () => {
    const request = vi.fn();
    const result = await runCommand(request, "steer");
    expect(result.content).toBe(resultText("steer.usage"));
    expect(request).not.toHaveBeenCalled();
  });
});

describe("executeSlashCommand /redirect (hard kill-and-restart)", () => {
  it("treats subagent-looking redirect prefixes as current-session message text", async () => {
    const request = mockRequests({
      "chat.send": () => ({ status: "started", runId: "run-3", messageSeq: 1 }),
    });
    const result = await runCommand(request, "redirect", "researcher start over completely");
    expect(result.content).toBe(resultText("redirect.succeeded"));
    expect(result.trackRunId).toBe("run-3");
    expect(request).toHaveBeenCalledWith(
      "chat.send",
      {
        sessionKey: "agent:main:main",
        message: "researcher start over completely",
        queueMode: "interrupt",
        idempotencyKey: expect.any(String),
      },
      {
        timeoutMs: GATEWAY_STARTUP_ADMISSION_WAIT_MS,
        signal: undefined,
        retainSentResultOnAbort: true,
      },
    );
  });
});

it("reports the last-run prompt budget through /usage", async () => {
  const request = vi.fn(async () => ({
    session: row("agent:main:main", {
      totalTokens: 160_000,
      contextTokens: 200_000,
      contextBudgetStatus: contextBudgetStatusFixture(),
    }),
  }));
  const result = await runCommand(request, "usage");
  expect(result.content).toContain("Prompt budget (last run): **89%** of 180k");
});
