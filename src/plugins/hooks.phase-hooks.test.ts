import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveModelPromptText } from "../agents/embedded-agent-runner/run/attempt-llm-boundary.js";
import { applyEmbeddedAttemptToolsAllow } from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { canonicalizeSessionEntry } from "../agents/sessions/session-manager-persistence-entry.js";
import { readToolAllowlistIntersection } from "../agents/tool-policy.js";
import { normalizeTranscriptJsonValue } from "../config/sessions/transcript-json.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { PluginHookAgentContext } from "./hook-types.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type {
  PluginHookBeforeAgentFinalizeResult,
  PluginHookBeforePromptBuildResult,
  PluginHookRegistration,
} from "./types.js";

type PromptHook = Pick<
  PluginHookRegistration<"before_prompt_build">,
  "handler" | "requiresToolAuthority" | "priority" | "timeoutMs"
> & { pluginId?: string };
const phaseEvent = { prompt: "test", messages: [] };
function hookRunner(
  hooks: Parameters<typeof createMockPluginRegistry>[0],
  options?: Parameters<typeof createHookRunner>[1],
) {
  return createHookRunner(createMockPluginRegistry(hooks), options);
}

describe("pre-durable channel ingress policy", () => {
  const context = () => ({
    channelId: "discord",
    accountId: "account",
    signal: new AbortController().signal,
  });
  const raw = { id: "event", channel_id: "room", content: "private" };

  function ownedPolicy(allowConversationAccess: boolean) {
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({ id: "ingress-policy", origin: "global" });
    builder.registry.plugins.push(record);
    const api = builder.createApi(record, { config: {}, hookPolicy: { allowConversationAccess } });
    const instance = getPluginInstance(record)!;
    onTestFinished(async () => {
      await instance.dispose();
    });
    return { api, instance, registry: builder.registry };
  }

  it.each([false, true])("requires the existing conversation-access grant (%s)", (allowed) => {
    const owner = ownedPolicy(allowed);
    owner.api.on("before_channel_ingress", () => undefined);
    expect(owner.registry.typedHooks.map((entry) => entry.hookName)).toEqual(
      allowed ? ["before_channel_ingress"] : [],
    );
  });

  it("chains isolated transformed events and retains the earlier replacement on a later decline", async () => {
    const runner = hookRunner([
      {
        hookName: "before_channel_ingress",
        priority: 2,
        handler: () => ({ event: { ...raw, content: "[redacted]" } }),
      },
      {
        hookName: "before_channel_ingress",
        handler: (value) => {
          expect(value).toEqual({ event: { ...raw, content: "[redacted]" } });
          return {};
        },
      },
    ]);
    const result = await runner.runBeforeChannelIngress({ event: raw }, context());
    expect(result?.event).toEqual({ ...raw, content: "[redacted]" });
    result?.assertCurrent();
    expect(raw.content).toBe("private");
  });

  it("does not fail open or expose policy error contents after a timeout", async () => {
    const release = createDeferred();
    const error = vi.fn();
    const runner = hookRunner(
      [
        {
          hookName: "before_channel_ingress",
          timeoutMs: 2,
          handler: async () => {
            await release.promise;
            throw new Error("PRIVATE_ERROR_SENTINEL");
          },
        },
      ],
      {
        logger: { error, warn: vi.fn() },
        failurePolicyByHook: { before_channel_ingress: "fail-open" },
      },
    );
    try {
      await expect(runner.runBeforeChannelIngress({ event: raw }, context())).rejects.toThrow(
        "Channel ingress transform failed",
      );
      expect(error).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
  });

  it("rejects a result from an actual registered instance retired during its awaited policy", async () => {
    const owner = ownedPolicy(true);
    const entered = createDeferred();
    const release = createDeferred();
    owner.api.on("before_channel_ingress", async () => {
      entered.resolve();
      await release.promise;
      return { event: { ...raw, content: "[redacted]" } };
    });
    const promise = createHookRunner(owner.registry).runBeforeChannelIngress(
      { event: raw },
      context(),
    );
    await entered.promise;
    const disposing = owner.instance.dispose();
    release.resolve();
    await expect(promise).rejects.toThrow(/Channel ingress transform/);
    await disposing;
  });
});
function promptRunner(hooks: PromptHook[], options?: Parameters<typeof createHookRunner>[1]) {
  const registry = createEmptyPluginRegistry();
  registry.typedHooks.push(
    ...hooks.map((hook) => ({
      pluginId: "test",
      hookName: "before_prompt_build" as const,
      source: "test",
      ...hook,
    })),
  );
  return createHookRunner(registry, options);
}
const authority = {
  toolAuthorityFingerprint: "turn-authority",
  activeToolNames: ["message"],
  assertHostActive: () => undefined,
};

describe("prompt phase hooks", () => {
  it.each(["prependSystemContext", "appendSystemContext"] as const)(
    "bounds oversized %s per plugin and warns once per session",
    async (field) => {
      const oversized = "x".repeat(824_170);
      const warn = vi.fn();
      const runner = promptRunner(
        [
          { pluginId: "verbose-plugin", priority: 10, handler: () => ({ [field]: oversized }) },
          { pluginId: "small-plugin", handler: () => ({ [field]: "  small guidance\r\n" }) },
        ],
        { logger: { warn, error: vi.fn() } },
      );
      const ctx = { sessionId: "session-1", contextTokenBudget: 32_000 };
      const first = await runner.runBeforePromptBuild(phaseEvent, ctx);
      expect(first?.[field]).toMatch(
        /\[Plugin system context truncated to fit the model budget\.\]\n\n {2}small guidance\r\n$/,
      );
      expect(first?.[field]?.length).toBe(32_000 + 2 + "  small guidance\r\n".length);
      expect(first?.[field]?.startsWith("xxxx")).toBe(true);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("verbose-plugin"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("824170 -> 32000 chars"));
      expect(await runner.runBeforePromptBuild(phaseEvent, ctx)).toEqual(first);
      expect(warn).toHaveBeenCalledOnce();
      await runner.runBeforePromptBuild(phaseEvent, { ...ctx, sessionId: "session-2" });
      expect(warn).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps normal system context byte-identical and bounds dense CJK context", async () => {
    const normal = "  static guidance\r\n";
    const runner = promptRunner([
      {
        handler: () => ({ prependSystemContext: normal, appendSystemContext: "界".repeat(2_000) }),
      },
    ]);
    const result = await runner.runBeforePromptBuild(phaseEvent, { contextTokenBudget: 4_000 });
    expect(result?.prependSystemContext).toBe(normal);
    expect(result?.appendSystemContext).toMatch(/^界+\n\[Plugin system context truncated/);
    expect(result?.appendSystemContext?.length).toBeLessThanOrEqual(1_060);
  });

  it("merges context in priority order while keeping the first system prompt", async () => {
    const context = (suffix: string): PluginHookBeforePromptBuildResult => ({
      systemPrompt: `system ${suffix}`,
      prependContext: `context ${suffix}`,
      prependSystemContext: `prepend ${suffix}`,
      appendSystemContext: `append ${suffix}`,
    });
    const runner = promptRunner([
      { priority: 1, handler: () => context("B") },
      { priority: 10, handler: () => context("A") },
    ]);
    await expect(runner.runBeforePromptBuild(phaseEvent, {})).resolves.toStrictEqual({
      systemPrompt: "system A",
      prependContext: "context A\n\ncontext B",
      appendContext: undefined,
      prependSystemContext: "prepend A\n\nprepend B",
      appendSystemContext: "append A\n\nappend B",
    });
  });

  it.each([
    { name: "explicit empty", toolsAllow: [] },
    { name: "non-array", toolsAllow: null as unknown as string[] },
    { name: "mixed-type array", toolsAllow: ["*", null] as unknown as string[] },
  ])("keeps $name tool restrictions closed", async ({ toolsAllow }) => {
    const runner = promptRunner([
      { handler: () => ({ toolsAllow }) },
      { handler: () => ({ toolsAllow: ["read"] }) },
    ]);
    expect((await runner.runBeforePromptBuild(phaseEvent, {}))?.toolsAllow).toEqual([]);
  });

  it("preserves overlapping frozen restrictions for the concrete tool surface", async () => {
    const runner = promptRunner([
      {
        handler: () => ({
          toolsAllow: Object.freeze(["group:fs", "web_*"]) as unknown as string[],
        }),
      },
      { handler: () => ({ toolsAllow: ["read", "*_search"] }) },
    ]);
    const toolsAllow = (await runner.runBeforePromptBuild(phaseEvent, {}))?.toolsAllow;
    expect(toolsAllow).toBeDefined();
    expect(readToolAllowlistIntersection(toolsAllow ?? [])).toEqual([
      ["group:fs", "web_*"],
      ["read", "*_search"],
    ]);
    expect(
      applyEmbeddedAttemptToolsAllow(
        [
          { name: "read" },
          { name: "web_search" },
          { name: "web_fetch" },
          { name: "memory_search" },
        ],
        toolsAllow,
      ),
    ).toEqual([{ name: "read" }, { name: "web_search" }]);
  });

  it("enriches only after host authorization and expires the supplied authority", async () => {
    const enrichment = vi.fn<PromptHook["handler"]>((_event, ctx) => {
      expect(ctx.toolAuthority?.allows("memory_search")).toBe(false);
      expect(ctx.toolAuthority?.allows("message")).toBe(true);
      return { prependContext: "authorized context", systemPrompt: "ignored override" };
    });
    const runner = promptRunner([
      { handler: () => ({ toolsAllow: ["message"] }) },
      { requiresToolAuthority: true, handler: enrichment },
    ]);
    await expect(runner.runBeforePromptBuild(phaseEvent, {})).resolves.toMatchObject({
      toolsAllow: ["message"],
    });
    expect(enrichment).not.toHaveBeenCalled();
    await expect(runner.runAuthorizedPromptBuild(phaseEvent, {}, authority)).resolves.toEqual({
      prependContext: "authorized context",
    });
    const retained = enrichment.mock.calls[0]?.[1].toolAuthority;
    expect(() => retained?.assertActive()).toThrow("no longer active");
  });

  it("rejects stale enrichment and never starts its successor after host authority closes", async () => {
    const started = createDeferred();
    const gate = createDeferred();
    const later = vi.fn(() => ({ prependContext: "later context" }));
    const runner = promptRunner([
      {
        requiresToolAuthority: true,
        handler: async () => {
          started.resolve();
          await gate.promise;
          return { prependContext: "stale context" };
        },
      },
      { requiresToolAuthority: true, handler: later },
    ]);
    let active = true;
    const run = runner.runAuthorizedPromptBuild(
      phaseEvent,
      {},
      {
        ...authority,
        assertHostActive: () => {
          if (!active) {
            throw new Error("host turn authority is no longer active");
          }
        },
      },
    );
    await started.promise;
    active = false;
    gate.resolve();
    await expect(run).rejects.toThrow("host turn authority is no longer active");
    expect(later).not.toHaveBeenCalled();
  });
});

type PromptPhase = "ordinary" | "authorized";
type Invocation = PluginHookAgentContext["hookInvocation"];

function isActive(invocation: Invocation): boolean | undefined {
  if (!invocation) {
    return undefined;
  }
  try {
    invocation.assertActive();
    return true;
  } catch {
    return false;
  }
}

function createRunner(
  phase: PromptPhase,
  hooks: PromptHook[],
  logger: { warn: (message: string) => void; error: (message: string) => void },
) {
  return promptRunner(
    hooks.map((hook) => ({
      ...hook,
      ...(phase === "authorized" ? { requiresToolAuthority: true as const } : {}),
    })),
    { logger, modifyingHookTimeoutMsByHook: { before_prompt_build: 100 } },
  );
}

function dispatch(
  runner: ReturnType<typeof createHookRunner>,
  phase: PromptPhase,
  context: PluginHookAgentContext,
) {
  const event = { prompt: "synthetic prompt", messages: [] };
  return phase === "ordinary"
    ? runner.runBeforePromptBuild(event, context)
    : runner.runAuthorizedPromptBuild(event, context, {
        toolAuthorityFingerprint: "synthetic-turn-authority",
        activeToolNames: ["memory_search"],
        assertHostActive: () => undefined,
      });
}

describe("prompt hook invocation", () => {
  it.each([
    { phase: "ordinary", outcome: "returned" },
    { phase: "ordinary", outcome: "threw" },
    { phase: "authorized", outcome: "rejected" },
  ] as const)(
    "revokes a $phase $outcome handler before result merging or error handling",
    async ({ phase, outcome }) => {
      const context = Object.freeze({ agentId: "test-agent", sessionKey: "test-session" });
      let handlerContext: PluginHookAgentContext = {};
      let activeOnEntry: boolean | undefined;
      const activeAtMerge: Array<boolean | undefined> = [];
      const activeAtError: Array<boolean | undefined> = [];
      const logger = {
        warn: vi.fn(),
        error: vi.fn(() => {
          activeAtError.push(isActive(handlerContext.hookInvocation));
        }),
      };
      const runner = createRunner(
        phase,
        [
          {
            pluginId: "settling-handler",
            handler: (_event, ctx) => {
              handlerContext = ctx;
              activeOnEntry = isActive(ctx.hookInvocation);
              const failure = new Error("synthetic handler failure");
              if (outcome === "threw") {
                throw failure;
              }
              if (outcome === "rejected") {
                return Promise.reject(failure);
              }
              return {
                get prependContext() {
                  activeAtMerge.push(isActive(ctx.hookInvocation));
                  return "timely context";
                },
              };
            },
          },
        ],
        logger,
      );
      expect(await dispatch(runner, phase, context)).toEqual(
        outcome === "returned" ? { prependContext: "timely context" } : undefined,
      );
      expect(activeOnEntry).toBe(true);
      expect(handlerContext).not.toBe(context);
      expect(context).toEqual({ agentId: "test-agent", sessionKey: "test-session" });
      expect(context).not.toHaveProperty("hookInvocation");
      expect(isActive(handlerContext.hookInvocation)).toBe(false);
      if (outcome === "returned") {
        expect(activeAtMerge.length).toBeGreaterThan(0);
        expect(activeAtMerge.every((active) => active === false)).toBe(true);
        expect(activeAtError).toEqual([]);
      } else {
        expect(activeAtMerge).toEqual([]);
        expect(activeAtError).toEqual([false]);
      }
    },
  );

  it.each(["ordinary", "authorized"] as const)(
    "expires only the timed-out %s handler while its next sibling is still active",
    async (phase) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const firstGate = createDeferredCore();
      const secondGate = createDeferredCore();
      const pending: Promise<unknown>[] = [];
      const contexts: PluginHookAgentContext[] = [];
      const context = Object.freeze({ agentId: "test-agent" });
      let firstResumed = false;
      let firstActiveAtSecondEntry: boolean | undefined;
      const activeAtTimeout: Array<boolean | undefined> = [];
      const logger = {
        warn: vi.fn(),
        error: vi.fn(() => {
          activeAtTimeout.push(isActive(contexts[0]?.hookInvocation));
        }),
      };
      const runner = createRunner(
        phase,
        [
          {
            pluginId: "timed-out-handler",
            timeoutMs: 5,
            handler: (_event, ctx) => {
              contexts.push(ctx);
              const work = firstGate.promise.then(() => {
                firstResumed = true;
                return { prependContext: "discarded late context" };
              });
              pending.push(work);
              return work;
            },
          },
          {
            pluginId: "live-sibling",
            handler: (_event, ctx) => {
              firstActiveAtSecondEntry = isActive(contexts[0]?.hookInvocation);
              contexts.push(ctx);
              const work = secondGate.promise.then(() => ({ prependContext: "live context" }));
              pending.push(work);
              return work;
            },
          },
        ],
        logger,
      );
      const run = dispatch(runner, phase, context);
      try {
        expect(contexts).toHaveLength(1);
        expect(isActive(contexts[0]?.hookInvocation)).toBe(true);
        await vi.advanceTimersByTimeAsync(5);
        expect(contexts).toHaveLength(2);
        expect(activeAtTimeout).toEqual([false]);
        expect(firstActiveAtSecondEntry).toBe(false);
        expect(contexts[0]?.hookInvocation).not.toBe(contexts[1]?.hookInvocation);
        expect(isActive(contexts[0]?.hookInvocation)).toBe(false);
        expect(isActive(contexts[1]?.hookInvocation)).toBe(true);
        expect(context).not.toHaveProperty("hookInvocation");
        expect(firstResumed).toBe(false);

        firstGate.resolve();
        await Promise.allSettled(pending.slice(0, 1));
        expect(firstResumed).toBe(true);
        expect(isActive(contexts[0]?.hookInvocation)).toBe(false);
        expect(isActive(contexts[1]?.hookInvocation)).toBe(true);
        secondGate.resolve();
        await expect(run).resolves.toEqual({ prependContext: "live context" });
        expect(isActive(contexts[1]?.hookInvocation)).toBe(false);
      } finally {
        firstGate.resolve();
        secondGate.resolve();
        try {
          await Promise.allSettled([...pending, run]);
        } finally {
          vi.useRealTimers();
        }
      }
    },
  );
});

const promptEvent = (prompt: string) => ({ prompt, messages: [] });

describe("before_prompt_build dispatch", () => {
  it.each([
    Object.freeze({ buffer: new SharedArrayBuffer(4) }),
    new Error("shared", { cause: new Uint8Array(new SharedArrayBuffer(4)) }),
    { __openclaw: { upstreamUserText: "storage only", shared: new SharedArrayBuffer(4) } },
    {
      get buffer() {
        return new SharedArrayBuffer(4);
      },
    },
  ])("rejects unowned shared memory beside an owned payload (%#)", async (unowned) => {
    const message = { role: "user", content: [{ type: "text", text: "owned" }] };
    normalizeTranscriptJsonValue(message, "");
    const handler = vi.fn();
    const runner = promptRunner([{ handler }]);
    await expect(
      runner.runBeforePromptBuild({ prompt: "test", messages: [message, unowned] }, {}),
    ).rejects.toThrow("before_prompt_build mutable input isolation failed");
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    { mix: [], expected: "Ask 🌍\r\n\ud800" },
    { mix: ["read"], expected: "Ask 🌍\r\n\ud800" },
    { mix: ["contribute"], expected: "context:history\n\nAsk 🌍\r\n\ud800\n\ntail" },
    {
      mix: ["mutate", "read", "contribute"],
      expected: "context:dispatch only\n\nAsk 🌍\r\n\ud800\n\ntail",
    },
  ])("preserves model prompt bytes for hook mix $mix", async ({ mix, expected }) => {
    const source = { role: "user", content: "history" };
    const event = { prompt: "Ask 🌍\r\n\ud800", messages: [source] };
    const runner = promptRunner(
      mix.map((kind) => ({
        handler: (input) => {
          const message = input.messages[0] as typeof source;
          if (kind === "mutate") {
            input.prompt = "dispatch prompt";
            message.content = "dispatch only";
          } else if (kind === "contribute") {
            return { prependContext: `context:${message.content}`, appendContext: "tail" };
          }
          return undefined;
        },
      })),
    );
    for (let turn = 0; turn < 2; turn++) {
      const contribution = await runner.runBeforePromptBuild(event, {});
      const prompt = resolveModelPromptText({
        text: event.prompt,
        transcriptPrompt: event.prompt,
        ...contribution,
      });
      expect(prompt).toBe(expected);
      expect(Buffer.from(prompt, "utf16le")).toEqual(Buffer.from(expected, "utf16le"));
      expect(source.content).toBe("history");
      expect(event.prompt).toBe("Ask 🌍\r\n\ud800");
    }
  });

  it("preserves aliases and native values in unowned hook data", async () => {
    const date = new Date("2026-01-01T00:00:00Z");
    const leaf = { text: "caller" };
    const map = new Map([["leaf", leaf]]);
    const metadata = {
      upstreamUserText: "storage only",
      leaf,
      map,
      [Symbol("omitted")]: Symbol("not cloned"),
    };
    const event = {
      prompt: "test",
      messages: [{ date, leaf, map, __openclaw: metadata }, { leaf }],
    };
    const ownKeys = vi.spyOn(Reflect, "ownKeys");
    onTestFinished(() => ownKeys.mockRestore());
    const runner = promptRunner(
      [
        {
          handler: (input) => {
            const [first, second] = input.messages as typeof event.messages;
            expect(first!.date).toEqual(date);
            expect(first!.date).not.toBe(date);
            expect(first!.leaf).toBe(second!.leaf);
            expect(first!.map!.get("leaf")).toBe(first!.leaf);
            expect(first!["__openclaw"]!.leaf).toBe(first!.leaf);
            expect(first!["__openclaw"]!.map).toBe(first!.map);
            expect(first!["__openclaw"]).not.toHaveProperty("upstreamUserText");
            expect(Object.getOwnPropertySymbols(first!["__openclaw"]!)).toEqual([]);
            first!.leaf.text = "local";
            expect(second!.leaf.text).toBe("local");
          },
        },
      ],
      { catchErrors: false },
    );
    await runner.runBeforePromptBuild(event, {});
    expect(leaf.text).toBe("caller");
    expect(map.get("leaf")).toBe(leaf);
    // Node preserves Error.cause, so only the detached graph needs a safety scan.
    expect(ownKeys.mock.calls.some(([value]) => value === leaf)).toBe(
      Boolean(process.versions.bun),
    );
  });

  it.each(["before_prompt_build", "agent_turn_prepare"] as const)(
    "%s shares immutable payloads without exposing stored metadata",
    async (hookName) => {
      const message = {
        role: "toolResult" as const,
        toolCallId: "call-1",
        toolName: "synthetic",
        isError: false,
        timestamp: 0,
        content: [{ type: "text" as const, text: "caller history" }],
        details: { private: "storage only" },
        __openclaw: { upstreamUserText: "storage prompt", retained: "visible" },
      };
      const entry = canonicalizeSessionEntry({
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: structuredClone(message),
      });
      normalizeTranscriptJsonValue(message, "");
      const messages = [message, entry.message];
      const owned = new Set<object>(messages.flatMap((item) => [item.content, item.content[0]!]));
      const ownKeys = vi.spyOn(Reflect, "ownKeys");
      const clone = vi.spyOn(globalThis, "structuredClone");
      onTestFinished(() => {
        ownKeys.mockRestore();
        clone.mockRestore();
      });
      const runner = hookRunner(
        [
          {
            hookName,
            handler: (value: unknown) => {
              const event = value as { messages: (typeof message)[] };
              for (const [index, source] of messages.entries()) {
                const projected = event.messages[index]!;
                expect(projected.content).toBe(source.content);
                expect(() => {
                  projected.content[0]!.text = "forbidden mutation";
                }).toThrow(TypeError);
                expect(projected).not.toHaveProperty("details");
                expect(projected["__openclaw"]).toEqual({ retained: "visible" });
                projected["__openclaw"].retained = "local metadata";
                projected.toolName = "local tool name";
              }
              return { prependContext: "returned context" };
            },
          },
        ],
        { catchErrors: false },
      );
      for (let turn = 0; turn < 2; turn++) {
        ownKeys.mockClear();
        clone.mockClear();
        const event = { prompt: "test", messages };
        const result =
          hookName === "before_prompt_build"
            ? await runner.runBeforePromptBuild(event, {})
            : await runner.runAgentTurnPrepare({ ...event, queuedInjections: [] }, {});
        expect(result?.prependContext).toBe("returned context");
        expect(clone).toHaveBeenCalledTimes(hookName === "before_prompt_build" ? 0 : 1);
        // Warm dispatch must not rescan the frozen payload graph (#182349).
        if (turn > 0) {
          expect(ownKeys.mock.calls.filter(([value]) => owned.has(value))).toHaveLength(0);
        }
        for (const source of messages) {
          expect(source.content[0]!.text).toBe("caller history");
          expect(source.toolName).toBe("synthetic");
          expect(source["__openclaw"].retained).toBe("visible");
        }
      }
    },
  );

  it.each(["before_prompt_build", "agent_turn_prepare"] as const)(
    "%s isolates array, envelope, and non-owned edits across dispatches",
    async (hookName) => {
      const message = { role: "user", content: [{ type: "text", text: "history" }] };
      normalizeTranscriptJsonValue(message, "");
      const unowned = { content: Object.freeze([{ text: "unowned" }]) };
      const event = { prompt: "test", messages: [message, unowned], queuedInjections: [] };
      const snapshots: unknown[] = [];
      const runner = hookRunner(
        [
          {
            hookName,
            handler: (value: unknown) => {
              const input = value as typeof event;
              snapshots.push(input);
              expect(input.messages).toEqual(event.messages);
              const first = input.messages[0] as typeof message;
              first.role = "assistant";
              first.content = [{ type: "text", text: "local replacement" }];
              const second = input.messages[1] as typeof unowned;
              second.content[0]!.text = "local unowned mutation";
              input.messages.push({ content: [] });
            },
          },
          {
            hookName,
            handler: (value: unknown) => {
              const input = value as typeof event;
              expect(input).toBe(snapshots.at(-1));
              expect(input.messages).toHaveLength(3);
              expect(input.messages[0]).toMatchObject({
                role: "assistant",
                content: [{ text: "local replacement" }],
              });
              expect(input.messages[1]).toMatchObject({
                content: [{ text: "local unowned mutation" }],
              });
            },
          },
        ],
        { catchErrors: false },
      );
      for (let turn = 0; turn < 2; turn++) {
        if (hookName === "before_prompt_build") {
          await runner.runBeforePromptBuild(event, {});
        } else {
          await runner.runAgentTurnPrepare(event, {});
        }
        expect(event.messages).toHaveLength(2);
        expect(message).toEqual({ role: "user", content: [{ type: "text", text: "history" }] });
        expect(unowned.content[0]!.text).toBe("unowned");
      }
      expect(snapshots[0]).not.toBe(snapshots[1]);
    },
  );

  it("keeps sibling hook families and other runners active during dispatch", async () => {
    const turnPrepare = vi.fn(() => ({ prependContext: "turn" }));
    const heartbeat = vi.fn(() => ({ appendContext: "heartbeat" }));
    const otherPromptBuild = vi.fn(() => ({ prependContext: "other runner" }));
    const otherRunner = hookRunner([
      { hookName: "before_prompt_build", handler: otherPromptBuild, pluginId: "other" },
    ]);
    const promptBuild = vi.fn(async () => {
      await runner.runAgentTurnPrepare(
        { prompt: "nested", messages: [], queuedInjections: [] },
        TEST_PLUGIN_AGENT_CTX,
      );
      await runner.runHeartbeatPromptContribution(
        { heartbeatName: "heartbeat" },
        TEST_PLUGIN_AGENT_CTX,
      );
      await otherRunner.runBeforePromptBuild(promptEvent("nested"), TEST_PLUGIN_AGENT_CTX);
      return {};
    });
    const runner = hookRunner([
      { hookName: "before_prompt_build", handler: promptBuild, pluginId: "prompt" },
      { hookName: "agent_turn_prepare", handler: turnPrepare, pluginId: "turn" },
      { hookName: "heartbeat_prompt_contribution", handler: heartbeat, pluginId: "heartbeat" },
    ]);

    await runner.runBeforePromptBuild(promptEvent("outer"), TEST_PLUGIN_AGENT_CTX);

    expect(promptBuild).toHaveBeenCalledOnce();
    expect(turnPrepare).toHaveBeenCalledOnce();
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(otherPromptBuild).toHaveBeenCalledOnce();
  });

  it("allows detached descendants to dispatch after the outer call settles", async () => {
    const { promise: detachedGate, resolve: releaseDetached } = createDeferredCore();
    let detachedDispatch: Promise<unknown> | undefined;
    const promptBuild = vi.fn(async (event: unknown) => {
      const prompt = (event as { prompt: string }).prompt;
      if (prompt === "outer") {
        detachedDispatch = (async () => {
          await detachedGate;
          return await runner.runBeforePromptBuild(promptEvent("detached"), TEST_PLUGIN_AGENT_CTX);
        })();
      }
      return { prependContext: prompt };
    });
    const runner = hookRunner([
      { hookName: "before_prompt_build", handler: promptBuild, pluginId: "prompt" },
    ]);

    await runner.runBeforePromptBuild(promptEvent("outer"), TEST_PLUGIN_AGENT_CTX);
    releaseDetached();
    const pendingDetachedDispatch = detachedDispatch;
    if (!pendingDetachedDispatch) {
      throw new Error("detached prompt dispatch was not created");
    }
    await expect(pendingDetachedDispatch).resolves.toMatchObject({ prependContext: "detached" });
    expect(promptBuild).toHaveBeenCalledTimes(2);
  });
});

const finalizeEvent = {
  runId: "run-1",
  sessionId: "session-1",
  stopHookActive: false,
  lastAssistantMessage: "done",
};
function finalize(...results: PluginHookBeforeAgentFinalizeResult[]) {
  return hookRunner(
    results.map((result) => ({ hookName: "before_agent_finalize", handler: () => result })),
  ).runBeforeAgentFinalize(finalizeEvent, TEST_PLUGIN_AGENT_CTX);
}

describe("before_agent_finalize", () => {
  it("retains valid retry candidates in order while discarding invalid instructions", async () => {
    const result = await finalize(
      { action: "revise", reason: "empty", retry: { instruction: "   ", idempotencyKey: "empty" } },
      {
        action: "revise",
        reason: "malformed",
        retry: { instruction: 123, idempotencyKey: "bad" } as never,
      },
      {
        action: "revise",
        reason: "artifacts",
        retry: {
          instruction: " regenerate artifacts ",
          idempotencyKey: "artifacts",
          maxAttempts: 1,
        },
      },
      {
        action: "revise",
        reason: "tests",
        retry: { instruction: "rerun tests", idempotencyKey: "tests", maxAttempts: 1 },
      },
    );
    expect(result).toEqual({
      action: "revise",
      reason: "empty\n\nmalformed\n\nartifacts\n\ntests",
      retry: { instruction: "regenerate artifacts", idempotencyKey: "artifacts", maxAttempts: 1 },
    });
    expect(Object.getOwnPropertyDescriptor(result, "retryCandidates")).toMatchObject({
      enumerable: false,
      value: [
        { instruction: "regenerate artifacts", idempotencyKey: "artifacts", maxAttempts: 1 },
        { instruction: "rerun tests", idempotencyKey: "tests", maxAttempts: 1 },
      ],
    });
  });

  it("lets finalize override revise decisions", async () => {
    await expect(
      finalize(
        { action: "revise", reason: "keep going" },
        { action: "finalize", reason: "enough" },
      ),
    ).resolves.toEqual({ action: "finalize", reason: "enough" });
  });

  it("bounds hung handlers so the original final answer can proceed", async () => {
    vi.useFakeTimers();
    try {
      const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const runner = hookRunner(
        [{ hookName: "before_agent_finalize", handler: () => new Promise(() => {}) }],
        { logger },
      );
      const run = runner.runBeforeAgentFinalize(finalizeEvent, TEST_PLUGIN_AGENT_CTX);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(run).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("timed out after 15000ms"));
    } finally {
      vi.useRealTimers();
    }
  });
});

it.each([
  { higher: [], lower: ["local/backup"], priority: 10, expected: [] },
  { higher: ["local/backup"], lower: [], priority: 10, expected: ["local/backup"] },
  { higher: undefined, lower: ["local/backup"], priority: 10, expected: ["local/backup"] },
  { higher: [], lower: ["local/first"], priority: 0, expected: ["local/first"] },
  { higher: null as unknown as string[], lower: ["local/backup"], priority: 10, expected: [] },
])(
  "keeps the first defined routing overrides after a broken plugin ($priority)",
  async ({ higher, lower, priority, expected }) => {
    const routing = (name: string, fallbacksOverride: string[] | undefined) => ({
      modelOverride: `${name}-model`,
      providerOverride: `${name}-provider`,
      fallbacksOverride,
    });
    const broken = vi.fn(() => {
      throw new Error("plugin crashed");
    });
    const runner = hookRunner([
      { hookName: "before_model_resolve", pluginId: "low", handler: () => routing("low", lower) },
      { hookName: "before_model_resolve", pluginId: "broken", priority: 100, handler: broken },
      {
        hookName: "before_model_resolve",
        pluginId: "high",
        priority,
        handler: () => routing("high", higher),
      },
    ]);
    await expect(
      runner.runBeforeModelResolve({ prompt: "test" }, TEST_PLUGIN_AGENT_CTX),
    ).resolves.toEqual({
      modelOverride: priority ? "high-model" : "low-model",
      providerOverride: priority ? "high-provider" : "low-provider",
      fallbacksOverride: expected,
    });
    expect(broken).toHaveBeenCalledOnce();
  },
);
