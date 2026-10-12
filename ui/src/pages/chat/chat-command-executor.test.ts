import { describe, expect, it, vi } from "vitest";
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
  const active = overrides?.status === "running" || overrides?.hasActiveRun === true;
  return {
    key,
    spawnedBy: overrides?.spawnedBy,
    kind: "direct",
    updatedAt: null,
    ...(active
      ? {
          hasActiveRun: true,
          activeRunIds: ["active-run"],
          activeLeafEntryId: "leaf-active",
        }
      : {}),
    ...overrides,
  };
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

describe("executeSlashCommand directives", () => {
  it("keeps unknown partial thinking support under server validation", async () => {
    const key = "agent:main:main";
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.describe") {
        return {
          session: row(key, { model: "model" }),
        };
      }
      if (method === "sessions.patch") {
        return { ok: true, key, entry: { thinkingLevel: "low" } };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      key,
      "think",
      "low",
      {
        chatModelCatalog: [
          {
            id: "model",
            name: "Model",
            provider: "openai",
            thinkingLevels: [{ id: "high", label: "High" }],
            thinkingDefault: "high",
          },
        ],
      },
    );
    expect(result.content).toBe(t("chat.commandResults.thinking.set", { level: "**low**" }));
    expect(request).toHaveBeenCalledWith("sessions.patch", { key, thinkingLevel: "low" });
  });

  it("lets the canonical row retire a slash-command selection equal to the default", async () => {
    const key = "agent:main:main";
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return createResolvedModelPatch("gpt-5-mini", "openai");
      }
      if (method === "sessions.list") {
        return createSessionsResult([
          row(key, {
            model: "gpt-5-mini",
            modelProvider: "openai",
            modelOverrideSource: null,
          }),
        ]);
      }
      throw new Error(`Unexpected request: ${method}`);
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

  it("does not patch through a replacement connection after loading session state", async () => {
    const { promise: description, resolve: resolveDescription } = createDeferred<{
      session: GatewaySessionRow;
    }>();
    const request = mockRequests({
      "sessions.describe": async () => await description,
      "sessions.patch": () => ({ ok: true }),
    });
    const client = createTestGatewayClient(request);
    let current = true;

    const pending = executeSlashCommand(client, "agent:main:main", "think", "high", {
      isCurrent: () => current,
    });
    current = false;
    resolveDescription({
      session: row("agent:main:main", {
        thinkingOptions: ["off", "low", "high"],
      }),
    });

    const result = await pending;
    expect(result.failed).toBe(true);
    expectNoRequestCall(request, "sessions.patch");
  });

  it("rechecks live scopes before patching after loading session state", async () => {
    const { promise: description, resolve: resolveDescription } = createDeferred<{
      session: GatewaySessionRow;
    }>();
    const request = mockRequests({
      "sessions.describe": async () => await description,
      "sessions.patch": () => ({ ok: true }),
    });
    const client = createTestGatewayClient(request);
    let snapshot: Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> = {
      client,
      phase: "connected" as const,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["sessions.patch"] },
      } as ApplicationGatewaySnapshot["hello"],
    };

    const pending = executeSlashCommand(client, "agent:main:main", "think", "high", {
      sessionAccessSnapshot: snapshot,
      readSessionAccessSnapshot: () => snapshot,
      isCurrent: () => true,
    });
    snapshot = restrictedSnapshot(client, ["sessions.patch"]);
    resolveDescription({
      session: row("agent:main:main", {
        thinkingOptions: ["off", "low", "high"],
      }),
    });

    const result = await pending;
    expect(result.failed).toBe(true);
    expectNoRequestCall(request, "sessions.patch");
  });

  it("resolves the legacy main alias for bare /model", async () => {
    const request = mockRequests({
      "sessions.describe": () => ({
        session: row("agent:main:main", {
          model: "gpt-4.1-mini",
        }),
      }),
      "models.list": () => ({
        models: [{ id: "gpt-4.1-mini" }, { id: "gpt-4.1" }],
      }),
    });

    const result = await executeSlashCommand(createTestGatewayClient(request), "main", "model", "");

    expect(result.content).toBe(
      [
        t("chat.commandResults.model.current", { model: "`gpt-4.1-mini`" }),
        t("chat.commandResults.model.available", {
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

  it("does not report global model defaults for an agent without a session row", async () => {
    const request = mockRequests({
      "sessions.describe": () => ({
        session: null,
      }),
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:work:main",
      "model",
      "",
      {
        agentId: "work",
        chatModelCatalog: [
          { id: "work-model", name: "Work Model", provider: "openai", available: true },
        ],
      },
    );

    expect(result.content).toBe(
      [
        t("chat.commandResults.model.current", { model: "`default`" }),
        t("chat.commandResults.model.available", { models: "`work-model`", remaining: "" }),
      ].join("\n"),
    );
  });

  it("reports global model defaults for a configured default agent", async () => {
    const request = mockRequests({
      "sessions.describe": () => ({ session: null }),
      "sessions.list": () => ({
        defaults: { modelProvider: "openai", model: "work-default" },
        sessions: [],
      }),
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:work:main",
      "model",
      "",
      {
        agentId: "work",
        defaultAgentId: "work",
        chatModelCatalog: [
          { id: "work-default", name: "Work Default", provider: "openai", available: true },
        ],
      },
    );

    expect(result.content).toBe(
      [
        t("chat.commandResults.model.current", { model: "`work-default`" }),
        t("chat.commandResults.model.available", {
          models: "`work-default`",
          remaining: "",
        }),
      ].join("\n"),
    );
    expect(requireRequestCall(request, "sessions.list").payload).toMatchObject({
      limit: 1,
      rowMode: "compact",
      agentId: "work",
    });
  });

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

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "main",
      "compact",
      "",
    );

    expect(result).toEqual({
      content: t("chat.commandResults.compaction.failedWithReason", {
        reason: "codex app-server compaction timed out",
      }),
      failed: true,
    });
  });

  it("keeps /usage context hidden when the context snapshot is stale", async () => {
    const request = mockRequests({
      "sessions.describe": () => ({
        session: row("agent:main:main", {
          model: "gpt-4.1-mini",
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
          totalTokensFresh: false,
          contextTokens: 4000,
        }),
      }),
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "usage",
      "",
    );

    expect(result.content).toBe(
      [
        `**${t("chat.commandResults.usage.title")}**`,
        t("chat.commandResults.usage.inputTokens", { count: "**1.2k**" }),
        t("chat.commandResults.usage.outputTokens", { count: "**300**" }),
        t("chat.commandResults.usage.totalTokens", { count: "**~1.5k**" }),
        t("chat.commandResults.usage.model", { model: "`gpt-4.1-mini`" }),
      ].join("\n"),
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.describe", {
      key: "agent:main:main",
      agentId: "main",
    });
  });

  it("uses the context snapshot for /usage while preserving cumulative total display", async () => {
    const request = mockRequests({
      "sessions.describe": () => ({
        session: row("agent:main:main", {
          model: "gpt-4.1-mini",
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1250,
          contextTokens: 4000,
        }),
      }),
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "usage",
      "",
    );

    expect(result.content).toBe(
      [
        `**${t("chat.commandResults.usage.title")}**`,
        t("chat.commandResults.usage.inputTokens", { count: "**1.2k**" }),
        t("chat.commandResults.usage.outputTokens", { count: "**300**" }),
        t("chat.commandResults.usage.totalTokens", { count: "**1.5k**" }),
        t("chat.commandResults.usage.context", { percent: "**31%**", total: "4k" }),
        t("chat.commandResults.usage.model", { model: "`gpt-4.1-mini`" }),
      ].join("\n"),
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.describe", {
      key: "agent:main:main",
      agentId: "main",
    });
  });

  it("clears thinking override for /think default", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "sessions.patch") {
        return { ok: true, ...((payload ?? {}) as object) };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "default",
    );

    expect(result.content).toBe(t("chat.commandResults.thinking.reset"));
    expect(result.action).toBe("refresh");
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: null,
    });
  });

  it("uses default thinking options when the active session is absent", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "sessions.describe") {
        return { session: null };
      }
      if (method === "sessions.list") {
        return {
          defaults: {
            modelProvider: "openai",
            model: "gpt-5.5",
            thinkingLevels: [
              { id: "off", label: "off" },
              { id: "minimal", label: "minimal" },
              { id: "low", label: "low" },
              { id: "medium", label: "medium" },
              { id: "adaptive", label: "adaptive" },
              { id: "high", label: "high" },
              { id: "xhigh", label: "xhigh" },
              { id: "max", label: "maximum" },
            ],
            thinkingOptions: [
              "off",
              "minimal",
              "low",
              "medium",
              "adaptive",
              "high",
              "xhigh",
              "maximum",
            ],
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

    const status = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "",
    );
    const setXhigh = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "xhigh",
    );
    const setMax = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "max",
    );
    const setMaximum = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "maximum",
    );
    const setAdaptive = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "auto",
    );

    expect(status.content).toBe(
      [
        t("chat.commandResults.thinking.current", { level: "adaptive" }),
        t("chat.commandResults.options", {
          options: "default, off, minimal, low, medium, adaptive, high, xhigh, maximum",
        }),
      ].join("\n"),
    );
    expect(setXhigh.content).toBe(t("chat.commandResults.thinking.set", { level: "**xhigh**" }));
    expect(setMax.content).toBe(t("chat.commandResults.thinking.set", { level: "**max**" }));
    expect(setMaximum.content).toBe(t("chat.commandResults.thinking.set", { level: "**max**" }));
    expect(setAdaptive.content).toBe(
      t("chat.commandResults.thinking.set", { level: "**adaptive**" }),
    );
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "xhigh",
    });
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "max",
    });
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "adaptive",
    });
  });

  it("reports unknown thinking when the descriptor omits model metadata", async () => {
    const request = mockRequests({
      "sessions.describe": () => ({
        session: row("agent:main:main", {
          modelProvider: "anthropic",
          model: "claude-sonnet-4-6",
          // thinkingLevels intentionally absent — lightweight row
        }),
      }),
      "models.list": () => ({
        models: [{ id: "claude-sonnet-4-6", provider: "anthropic", reasoning: true }],
      }),
    });

    const status = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "",
    );

    expect(status.content).toBe(
      [
        t("chat.commandResults.thinking.current", { level: "Unknown" }),
        t("chat.commandResults.options", {
          options: "Unknown",
        }),
      ].join("\n"),
    );
  });

  it("rejects thinking levels when the selected model advertises empty support", async () => {
    const request = mockRequests({
      "sessions.describe": () => ({
        session: row("agent:main:main", {
          modelProvider: "thinking-fixture",
          model: "selected",
          thinkingLevels: [],
        }),
      }),
      "sessions.patch": () => ({ ok: true }),
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "think",
      "high",
    );

    expect(result.content).toBe(
      t("chat.commandResults.thinking.unsupported", { level: "high", options: "none" }),
    );
    expectNoRequestCall(request, "sessions.patch");
  });

  it("reports the current verbose level for bare /verbose", async () => {
    const request = mockRequests({
      "sessions.describe": () => ({
        session: row("agent:main:main", { verboseLevel: "full" }),
      }),
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "verbose",
      "",
    );

    expect(result.content).toBe(
      [
        t("chat.commandResults.verbose.current", { level: "full" }),
        t("chat.commandResults.options", { options: "on, full, off" }),
      ].join("\n"),
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.describe", {
      key: "agent:main:main",
      agentId: "main",
    });
  });

  it("reports the current fast mode for bare /fast", async () => {
    const request = mockRequests({
      "sessions.describe": () => ({
        session: row("agent:main:main", { fastMode: true }),
      }),
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "fast",
      "",
    );

    expect(result.content).toBe(
      [
        `${t("chat.commandResults.fast.current", {
          value: t("chat.commandResults.fast.on"),
        })}.`,
        t("chat.commandResults.options", {
          options: t("chat.commandResults.fast.options", { seconds: "60" }),
        }),
      ].join("\n"),
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.describe", {
      key: "agent:main:main",
      agentId: "main",
    });
  });

  it("reports auto fast mode for bare /fast", async () => {
    const request = mockRequests({
      "sessions.describe": () => ({
        session: row("agent:main:main", { fastMode: "auto" }),
      }),
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "fast",
      "",
    );

    expect(result.content).toBe(
      [
        `${t("chat.commandResults.fast.current", {
          value: t("chat.commandResults.fast.autoValue", { seconds: "60" }),
        })}.`,
        t("chat.commandResults.options", {
          options: t("chat.commandResults.fast.options", { seconds: "60" }),
        }),
      ].join("\n"),
    );
  });

  it("reports effective model-default auto fast mode for bare /fast", async () => {
    const request = mockRequests({
      "sessions.describe": () => ({
        session: row("agent:main:main", {
          effectiveFastMode: "auto",
          effectiveFastModeSource: "config",
          fastAutoOnSeconds: 30,
        }),
      }),
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "fast",
      "",
    );

    expect(result.content).toBe(
      [
        `${t("chat.commandResults.fast.current", {
          value: t("chat.commandResults.fast.autoValue", { seconds: "30" }),
        })}${t("chat.commandResults.fast.sourceModel")}.`,
        t("chat.commandResults.options", {
          options: t("chat.commandResults.fast.options", { seconds: "30" }),
        }),
      ].join("\n"),
    );
  });

  it("patches fast mode for /fast on", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "fast",
      "on",
    );

    expect(result.content).toBe(t("chat.commandResults.fast.enabled"));
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      fastMode: true,
    });
  });

  it("patches fast mode for /fast auto", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "fast",
      "auto",
    );

    expect(result.content).toBe(t("chat.commandResults.fast.setAuto"));
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      fastMode: "auto",
    });
  });

  it("clears fast mode override for /fast default", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "sessions.patch") {
        return { ok: true, ...((payload ?? {}) as object) };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "fast",
      "default",
    );

    expect(result.content).toBe(t("chat.commandResults.fast.reset"));
    expect(result.action).toBe("refresh");
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      fastMode: null,
    });
  });
});

describe("executeSlashCommand /steer (soft inject)", () => {
  it("sends the selected session without resolving a run or leaf", async () => {
    const request = mockRequests({ "chat.send": () => ({ status: "started", runId: "run-1" }) });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "steer",
      "try a different approach",
    );

    expect(result.content).toBe(t("chat.commandResults.steer.succeeded"));
    expect(result.pendingCurrentRun).toBe(true);
    const chatSend = requireRequestCall(request, "chat.send");
    expect(chatSend.payload).toMatchObject({
      sessionKey: "agent:main:main",
      message: "try a different approach",
      deliver: false,
      queueMode: "steer",
      idempotencyKey: expect.any(String),
    });
    expect(chatSend.payload).not.toHaveProperty("expectedRunId");
    expect(chatSend.payload).not.toHaveProperty("expectedLeafEntryId");
    expectNoRequestCall(request, "sessions.list");
  });

  it("does not mark the current run pending when chat.send returns terminal ok", async () => {
    const request = mockRequests({
      "chat.send": () => ({ status: "ok", runId: "run-ok", messageSeq: 2 }),
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "steer",
      "try a different approach",
    );

    expect(result.content).toBe(t("chat.commandResults.steer.succeeded"));
    expect(result.pendingCurrentRun).toBeUndefined();
    const chatSend = requireRequestCall(request, "chat.send");
    expect(chatSend.payload.deliver).toBe(false);
  });

  it.each([
    ["timeout", "chat.commandResults.steer.timeout"],
    ["error", "chat.commandResults.steer.failed"],
  ] as const)(
    "reports terminal %s ACK without marking the current run pending",
    async (status, expectedKey) => {
      const request = mockRequests({
        "chat.send": () => ({ status, runId: `run-${status}`, summary: "aborted" }),
      });

      const result = await executeSlashCommand(
        createTestGatewayClient(request),
        "agent:main:main",
        "steer",
        "try a different approach",
      );

      expect(result.content).toBe(t(expectedKey));
      expect(result.content).not.toBe(t("chat.commandResults.steer.succeeded"));
      expect(result.pendingCurrentRun).toBeUndefined();
      const chatSend = requireRequestCall(request, "chat.send");
      expect(chatSend.payload.deliver).toBe(false);
    },
  );

  it("returns steer usage when no message is provided", async () => {
    const request = vi.fn();

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "steer",
      "",
    );

    expect(result.content).toBe(t("chat.commandResults.steer.usage"));
    expect(request).not.toHaveBeenCalled();
  });

  it("returns steer error message on RPC failure", async () => {
    const request = vi.fn(async () => {
      throw new Error("connection lost");
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "steer",
      "try again",
    );

    expect(result.content).toBe(
      t("chat.commandResults.steer.requestFailed", { error: "connection lost" }),
    );
  });
});

describe("executeSlashCommand /redirect (hard kill-and-restart)", () => {
  it("treats subagent-looking redirect prefixes as current-session message text", async () => {
    const request = mockRequests({
      "chat.send": () => ({ status: "started", runId: "run-3", messageSeq: 1 }),
    });

    const result = await executeSlashCommand(
      createTestGatewayClient(request),
      "agent:main:main",
      "redirect",
      "researcher start over completely",
    );

    expect(result.content).toBe(t("chat.commandResults.redirect.succeeded"));
    expect(result.trackRunId).toBe("run-3");
    expect(request).toHaveBeenCalledWith("chat.send", {
      sessionKey: "agent:main:main",
      message: "researcher start over completely",
      queueMode: "interrupt",
      idempotencyKey: expect.any(String),
    });
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
  const result = await executeSlashCommand(
    createTestGatewayClient(request),
    "agent:main:main",
    "usage",
    "",
  );
  expect(result.content).toContain("Prompt budget (last run): **89%** of 180k");
});
