import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../agents/runtime/index.js";
import type { OpenClawConfig } from "../config/types.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { createPassthroughEngineMethods } from "./context-engine.test-support.js";
import { registerLegacyContextEngine } from "./legacy.registration.js";
import {
  listContextEngineQuarantines,
  registerContextEngineForOwner,
  resolveContextEngine,
  resolveLogicalTurnContextEngines,
} from "./registry.js";
import {
  captureContextEngineRegistryStateForTests,
  resetContextEngineRuntimeQuarantineForTests,
} from "./registry.test-support.js";
import type { ContextEngine, ContextEngineRuntimeSettings } from "./types.js";

describe("host parameter projection", () => {
  const message = { role: "user", content: "hello", timestamp: 1 } as AgentMessage;
  const runtimeSettings = {} as ContextEngineRuntimeSettings;
  const session = { sessionId: "session-1", sessionKey: "agent:main:session-1" };
  const sessionTarget = { agentId: "main", sessionId: session.sessionId };
  const runtimeContext = { tokenBudget: 1000 };
  let engineCounter = 0;

  async function registerEngine(engine: ContextEngine) {
    const engineId = engine.info.id;
    await registerContextEngineForOwner(engineId, () => engine, `plugin:${engineId}`);
    return { engineId, config: { plugins: { slots: { contextEngine: engineId } } } };
  }

  async function registerProbeEngine(acceptedHostParams?: string[], rejectAssemble = false) {
    const engineId = `host-param-probe-${++engineCounter}`;
    const methods = createPassthroughEngineMethods();
    const assemble = vi.fn<ContextEngine["assemble"]>(async (call) => {
      if (rejectAssemble) {
        throw new Error("Unrecognized key(s) in object: 'runtimeSettings'");
      }
      return { messages: call.messages, estimatedTokens: 0 };
    });
    const compact = vi.fn(methods.compact);
    const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () => ({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    }));
    const commitTurn = vi.fn<NonNullable<ContextEngine["commitTurn"]>>(async () => ({
      status: "committed",
    }));
    const registered = await registerEngine({
      ...methods,
      assemble,
      compact,
      maintain,
      commitTurn,
      info: { id: engineId, name: "Host Param Probe", acceptedHostParams },
    });
    return { ...registered, assemble, compact, commitTurn, maintain };
  }

  async function invokeHostParamMethods(engine: ContextEngine) {
    const abortSignal = new AbortController().signal;
    const common = { ...session, runtimeSettings };
    const runtime = { ...common, runtimeContext, abortSignal };
    await engine.assemble({ ...common, messages: [message], prompt: "hello" });
    await engine.compact({ ...runtime, sessionTarget });
    await engine.maintain?.({
      ...runtime,
      sessionFile: "/tmp/session-1.jsonl",
    });
    const admission = {
      agentId: "main",
      ...session,
      storePath: "/tmp/openclaw-agent.sqlite",
      generation: "generation-1",
      entryId: "user-1",
      rawSeq: 1,
      effectiveParentId: null,
      activeMessagePosition: 0,
      logicalTurnId: "turn-1",
      role: "user" as const,
    };
    await engine.commitTurn?.({
      ...runtime,
      sessionTarget,
      advancementKey: "turn-1",
      admission,
      terminal: { ...admission, entryId: "assistant-1", rawSeq: 2 },
      messages: [message],
    });
    return abortSignal;
  }

  function expectAbsent(call: unknown, keys: string[]) {
    for (const key of keys) {
      expect(call).not.toHaveProperty(key);
    }
  }

  async function resolveProbe(config: OpenClawConfig, logicalTurn = true) {
    const turn = logicalTurn ? await resolveLogicalTurnContextEngines(config) : undefined;
    const engine = turn?.configured.engine ?? (await resolveContextEngine(config));
    return {
      engine,
      owner: turn?.configured.ownerPluginId,
      async [Symbol.asyncDispose]() {
        await Promise.allSettled([engine.dispose?.(), turn?.fallback.engine.dispose?.()]);
      },
    };
  }

  let restoreRegistry: () => Promise<void> = async () => {};

  beforeAll(() => {
    restoreRegistry = captureContextEngineRegistryStateForTests();
  });

  beforeEach(async () => {
    await registerLegacyContextEngine();
    await resetContextEngineRuntimeQuarantineForTests();
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(() => restoreRegistry());

  it.each(["declared-process", "undeclared-logical-turn", "restricted-logical-turn"] as const)(
    "projects host parameters for %s engines",
    async (mode) => {
      const restricted = mode === "restricted-logical-turn";
      const { config, assemble, compact, maintain, commitTurn } = await registerProbeEngine(
        mode === "declared-process"
          ? "sessionKey prompt runtimeSettings sessionTarget runtimeContext abortSignal".split(" ")
          : restricted
            ? ["runtimeSettings"]
            : undefined,
      );
      await using resolved = await resolveProbe(config, mode !== "declared-process");
      const abortSignal = await invokeHostParamMethods(resolved.engine);
      const a = assemble.mock.calls[0]?.[0];
      const c = compact.mock.calls[0]?.[0];
      const m = maintain.mock.calls[0]?.[0];
      const t = commitTurn.mock.calls[0]?.[0];
      const required = { sessionId: "session-1", runtimeSettings };
      if (restricted) {
        expect([a, c, m]).toMatchObject([required, { ...required, abortSignal }, required]);
        expectAbsent(a, ["sessionKey", "prompt"]);
        expectAbsent(c, ["sessionTarget", "runtimeContext"]);
        expectAbsent(m, ["sessionKey", "runtimeContext", "abortSignal"]);
        expect(t).toMatchObject({ ...required, advancementKey: "turn-1" });
        expectAbsent(t, ["sessionKey", "sessionTarget", "runtimeContext", "abortSignal"]);
      } else {
        const common = { ...session, runtimeSettings };
        const runtime = { ...common, runtimeContext, abortSignal };
        expect(a).toMatchObject({ ...common, prompt: "hello" });
        expect(c).toMatchObject({ ...runtime, sessionTarget });
        expect(m).toMatchObject(runtime);
        expect(t).toMatchObject({ ...runtime, sessionTarget, advancementKey: "turn-1" });
      }
    },
  );

  it.each(["process", "logical-turn"] as const)(
    "isolates writable plugin messages while core retains shared history (%s)",
    async (mode) => {
      const source = freezeJsonSnapshot({
        role: "user" as const,
        content: [{ type: "text" as const, text: "canonical" }],
        timestamp: 1,
      });
      for (const core of [true, false]) {
        const engineId = core ? "legacy" : `message-owner-${++engineCounter}`;
        const received: AgentMessage[] = [];
        const consume = (input: AgentMessage) => {
          received.push(input);
          if (!core) {
            input.timestamp = 2;
            if (input.role === "user" && Array.isArray(input.content)) {
              Object.assign(input.content[0]!, { text: "plugin edit" });
              input.content.push({ type: "text", text: "plugin addition" });
            }
          }
        };
        await registerContextEngineForOwner(
          engineId,
          () => ({
            ...createPassthroughEngineMethods(),
            // Display identity cannot exempt a plugin from its writable boundary.
            info: { id: "legacy", name: "Message owner", acceptedHostParams: [] },
            async assemble({ messages }) {
              consume(messages[0]!);
              return { messages, estimatedTokens: 0 };
            },
            async ingest({ message: input }) {
              consume(input);
              return { ingested: true };
            },
            async ingestBatch({ messages }) {
              consume(messages[0]!);
              return { ingestedCount: 1 };
            },
            async afterTurn({ messages }) {
              consume(messages[0]!);
            },
          }),
          core ? "core" : `plugin:${engineId}`,
          { allowSameOwnerRefresh: true },
        );
        await using resolved = await resolveProbe(
          { plugins: { slots: { contextEngine: engineId } } },
          mode === "logical-turn",
        );
        await resolved.engine.assemble({ ...session, messages: [source] });
        expect(await listContextEngineQuarantines()).toEqual([]);
        await resolved.engine.ingest({ ...session, message: source });
        await resolved.engine.ingestBatch?.({ ...session, messages: [source] });
        await resolved.engine.afterTurn?.({
          ...session,
          sessionFile: "synthetic.jsonl",
          messages: [source],
          prePromptMessageCount: 1,
        });
        expect(received).toHaveLength(4);
        expect(received.every((item) => item === source)).toBe(core);
        expect(source).toEqual({
          role: "user",
          content: [{ type: "text", text: "canonical" }],
          timestamp: 1,
        });
        expect(await listContextEngineQuarantines()).toEqual([]);
      }
    },
  );

  it("does not retry validator-shaped engine failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { config, engineId, assemble } = await registerProbeEngine(["runtimeSettings"], true);
    const engine = await resolveContextEngine(config);

    await engine.assemble({
      sessionId: "session-1",
      messages: [message],
      runtimeSettings,
    });

    expect(assemble).toHaveBeenCalledOnce();
    expect(await listContextEngineQuarantines()).toEqual([
      expect.objectContaining({ engineId, operation: "assemble" }),
    ]);
  });

  it.each(["process", "logical-turn"] as const)(
    "does not mutate frozen engines reused by a factory (%s)",
    async (mode) => {
      const engineId = `host-param-frozen-${++engineCounter}`;
      const assemble = vi.fn(createPassthroughEngineMethods().assemble);
      class FrozenProbeEngine implements ContextEngine {
        readonly #info = { id: engineId, name: "Frozen Probe", acceptedHostParams: [] };

        get info() {
          return this.#info;
        }

        ingest = createPassthroughEngineMethods().ingest;
        assemble = assemble;

        compact = createPassthroughEngineMethods().compact;
      }
      const sharedEngine = Object.freeze(new FrozenProbeEngine());
      const { config } = await registerEngine(sharedEngine);
      await using first = await resolveProbe(config, mode === "logical-turn");
      await using second = await resolveProbe(config, mode === "logical-turn");
      expect(first.engine.info).toBe(sharedEngine.info);
      const input = { sessionId: "session-1", messages: [message] };
      await first.engine.assemble({ ...input, sessionKey: "first" });
      await second.engine.assemble({ ...input, sessionId: "session-2", sessionKey: "second" });

      expect(assemble.mock.contexts).toEqual([sharedEngine, sharedEngine]);
      expect(assemble.mock.calls.map(([params]) => params)).toEqual([
        { sessionId: "session-1", messages: [message] },
        { sessionId: "session-2", messages: [message] },
      ]);
    },
  );

  it("preserves raw call identity despite process quarantine", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const engineId = `host-param-quarantined-${++engineCounter}`;
    const processFailure = new Error("process compact failed");
    const syncFailure = new Error("raw assemble failed");
    const retainedPromise = Promise.resolve({ messages: [message], estimatedTokens: 0 });
    const assemble = vi
      .fn<ContextEngine["assemble"]>()
      .mockReturnValueOnce(retainedPromise)
      .mockImplementationOnce(() => {
        throw syncFailure;
      });
    const info = { id: engineId, name: "Quarantined Probe", acceptedHostParams: [] };
    const { config } = await registerEngine({
      ...createPassthroughEngineMethods(),
      info,
      assemble,
      compact: async () => {
        throw processFailure;
      },
    });
    await using process = await resolveProbe(config, false);
    const processEngine = process.engine;
    await expect(
      processEngine.compact({ sessionId: "session-1", sessionKey: "agent:main:session-1" }),
    ).rejects.toBe(processFailure);
    const quarantine = await listContextEngineQuarantines();
    expect(quarantine).toEqual([expect.objectContaining({ engineId, operation: "compact" })]);

    await using resolved = await resolveProbe(config);
    expect(resolved.owner).toBe(engineId);
    expect(resolved.engine.info).toBe(info);
    const params = { sessionId: "session-1", sessionKey: "raw", messages: [message] };
    const result = resolved.engine.assemble(params);
    expect(result).toBe(retainedPromise);
    await expect(result).resolves.toEqual({ messages: [message], estimatedTokens: 0 });

    let returned: ReturnType<ContextEngine["assemble"]> | undefined;
    let thrown: unknown;
    try {
      returned = resolved.engine.assemble(params);
    } catch (error) {
      thrown = error;
    }
    // Drain an accidental async rejection before asserting synchronous error identity.
    await returned?.catch(() => {});
    expect(thrown).toBe(syncFailure);
    expect(await listContextEngineQuarantines()).toEqual(quarantine);
  });
});
