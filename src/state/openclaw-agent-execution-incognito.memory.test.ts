import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as memoryRuntime from "../../packages/memory-host-sdk/src/host/openclaw-runtime-session.js";
import * as sessionFiles from "../../packages/memory-host-sdk/src/host/session-files.js";
import {
  buildSessionEntry,
  listSessionTranscriptCorpusEntriesForAgent,
  type SessionTranscriptCorpusEntry,
} from "../../packages/memory-host-sdk/src/host/session-files.js";
import { readSessionResetRecallCutoff } from "../../packages/memory-host-sdk/src/host/session-reset-recall-read.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import type {
  IncognitoComputeOperations,
  IncognitoComputeTarget,
} from "../config/sessions/session-incognito-compute-contract.js";
import type { IncognitoComputeScope } from "../config/sessions/session-incognito-compute.js";
import type {
  IncognitoSessionAuthority,
  IncognitoSessionFacts,
} from "../config/sessions/session-incognito-contract.js";
import * as incognitoCorpus from "../config/sessions/session-incognito-memory-corpus.js";
import { resolveMemorySessionTargetsInWorker } from "../config/sessions/session-transcript-inventory-runtime.js";
import { createIncognitoSessionComputeReader } from "../gateway/session-history-snapshot.js";
import {
  loadArchivedSessions,
  loadArchivedSessionsAsync,
  loadMemorySessionMetadata,
  loadMemorySessionMetadataBatch,
  readTranscriptStatsBatchReadOnlySync,
  resolveMemorySessionTargets,
  resolveMemorySessionTargetsAsync,
  statSessionEntrySync,
} from "../plugin-sdk/memory-core-host-engine-sessions.js";
import { createPluginStateKeyedStoreForTests } from "../plugin-sdk/plugin-state-test-runtime.js";
import { buildPluginApi } from "../plugins/api-builder.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import type {
  OpenClawPluginCommandDefinition,
  OpenClawPluginDefinition,
  PluginHookHandlerMap,
} from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  IncognitoSessionEndedError,
  IncognitoSessionSyncAccessError,
} from "./incognito-session-error.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import {
  useIncognitoActorProbe,
  openIncognitoTestActor,
  useIncognitoNoHostSql,
} from "./openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const probe = useIncognitoActorProbe();
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority: IncognitoSessionAuthority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-memory-wiring-") };
  actor = await openIncognitoTestActor(env, authority);
});
useIncognitoNoHostSql();
afterAll(async () => {
  await actor?.close();
  await closeOpenClawStateDatabaseAsync();
});

async function session(name: string, grant = authority, owner = actor) {
  const target = {
    sessionKey: `agent:main:dashboard:incognito-${name}`,
    sessionId: name,
    lifecycleRevision: "initial",
  };
  await actor.sessions.create(authority, {
    sessionKey: target.sessionKey,
    entry: {
      sessionId: name,
      lifecycleRevision: "initial",
      incognito: true,
      createdAt: 10000,
      updatedAt: 10000,
    },
  });
  for (const content of ["first Memory source", "second Memory source"]) {
    await actor.sessions.transcript(authority, {
      type: "session.message.append",
      input: {
        ...target,
        fence: { expectedLifecycleRevision: target.lifecycleRevision },
        message: {
          role: "assistant",
          content: [
            { type: "text", text: content },
            { type: "image", data: "synthetic-image", mimeType: "image/png" },
          ],
          timestamp: 10000,
        },
      },
    });
  }
  const reader = await createIncognitoSessionComputeReader({
    actor: owner,
    authority: grant,
    target,
  });
  return { target, reader, scope: { ...target, agentId: actor.agentId, storePath: actor.path } };
}

it("fences an empty Memory corpus against earlier queued creation", async () => {
  const config = vi.spyOn(memoryRuntime, "getRuntimeConfig").mockReturnValue({
    session: { store: actor.path },
  });
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const captured = createDeferredCore();
  let held: Promise<unknown> | undefined;
  let creating: Promise<unknown> | undefined;
  let reading: Promise<unknown> | undefined;
  let rejected: Promise<unknown> | undefined;
  try {
    expect(
      await withIncognitoSessionActor(actor, () =>
        listSessionTranscriptCorpusEntriesForAgent("main"),
      ),
    ).toEqual([]);
    held = probe.read(actor, authority, async () => {
      entered.resolve();
      await resume.promise;
    });
    await entered.promise;
    creating = actor.sessions.create(authority, {
      sessionKey: "agent:main:dashboard:incognito-corpus-queued",
      entry: { sessionId: "corpus-queued", updatedAt: 10000, incognito: true },
    });
    reading = withIncognitoSessionActor(actor, () => {
      const pending = listSessionTranscriptCorpusEntriesForAgent("main");
      captured.resolve();
      return pending;
    });
    rejected = expect(reading).rejects.toThrow("Memory corpus changed");
    await awaitGateBeforeSettlement(captured.promise, reading, "Corpus settled before capture");
    resume.resolve();
    await Promise.all([held, creating, rejected]);
  } finally {
    resume.resolve();
    await Promise.allSettled([held, creating, reading, rejected]);
    config.mockRestore();
  }
});

it("wires Memory callbacks, corpus and reset recall through the captured actor without caller SQL", async () => {
  const { reader, scope } = await session("callbacks-corpus");
  await withIncognitoSessionActor(actor, async () => {
    for (const read of [
      () => loadArchivedSessions({ ...scope, sessionIds: [scope.sessionId] }),
      () => loadMemorySessionMetadata(scope),
      () => loadMemorySessionMetadataBatch({ ...scope, sessions: [scope] }),
      () => resolveMemorySessionTargets({ ...scope, sessionIds: [scope.sessionId] }),
      () => readTranscriptStatsBatchReadOnlySync([scope]),
      () => statSessionEntrySync("actor-memory", scope),
    ]) {
      expect(read).toThrow(IncognitoSessionSyncAccessError);
    }
    expect(await loadArchivedSessionsAsync({ ...scope, sessionIds: [scope.sessionId] })).toEqual(
      [],
    );
  });
  const observed: unknown[] = [];
  const entry = await withIncognitoSessionActor(actor, () =>
    buildSessionEntry("actor-memory", {
      ...scope,
      parseYieldEveryLines: 1,
      onTranscriptMessage: (message) => {
        observed.push(message);
      },
    }),
  );
  expect(observed).toHaveLength(2);
  expect(observed[0]).toMatchObject({
    content: [
      { type: "text", text: "first Memory source" },
      { type: "image", data: "synthetic-image", mimeType: "image/png" },
    ],
  });
  expect(entry?.content).toBe("Assistant: first Memory source\nAssistant: second Memory source");
  expect(
    await withEnvAsync(env, () =>
      withIncognitoSessionActor(actor, () =>
        resolveMemorySessionTargetsInWorker({
          agentId: "main",
          storePath: actor.path,
          sessionIds: [scope.sessionId, "missing-memory-session"],
        }),
      ),
    ),
  ).toEqual([
    expect.objectContaining({
      sessionId: scope.sessionId,
      sessionKey: scope.sessionKey,
      resolution: "live",
    }),
    expect.objectContaining({ sessionId: "missing-memory-session", resolution: "unresolved" }),
  ]);
  expect(
    await actor.sessions.history(authority, {
      type: "session.history.memory-targets",
      input: { sessions: [], selectors: { agentId: "main", sessionIds: [scope.sessionId] } },
    }),
  ).toEqual([]);
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  try {
    const configuredScope = {
      ...scope,
      storePath: resolveOpenClawAgentSqlitePath({ agentId: actor.agentId, env }),
    };
    expect(
      (
        await withIncognitoSessionActor(actor, () =>
          buildSessionEntry("actor-memory", configuredScope),
        )
      )?.content,
    ).toBe(entry?.content);
    expect(
      await withIncognitoSessionActor(actor, () => readSessionResetRecallCutoff(configuredScope)),
    ).toEqual({ state: "absent" });
  } finally {
    vi.stubEnv("OPENCLAW_STATE_DIR", previousStateDir);
  }
  // Marker readers may carry only the physical target and transcript id.
  const { sessionKey: _sessionKey, ...markerScope } = scope;
  expect(
    await withIncognitoSessionActor(actor, () => readSessionResetRecallCutoff(markerScope)),
  ).toEqual({ state: "absent" });
  const config = vi.spyOn(memoryRuntime, "getRuntimeConfig").mockReturnValue({
    session: { store: actor.path },
  });
  const environment = vi
    .spyOn(memoryRuntime, "cloneEnvWithPlatformSemantics")
    .mockReturnValue(new Proxy({ ...env }, {}));
  try {
    for (const source of [undefined, reader]) {
      const corpus = await withIncognitoSessionActor(actor, () =>
        listSessionTranscriptCorpusEntriesForAgent("main", { includeRetainedSqlite: true }, source),
      );
      expect(corpus).toContainEqual(
        expect.objectContaining({
          agentId: "main",
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
          storePath: actor.path,
          artifactKind: "active-session",
          transcriptSource: "sqlite",
          contentRevision: expect.stringMatching(/^sqlite:/),
        }),
      );
    }
  } finally {
    environment.mockRestore();
    config.mockRestore();
  }
  await expect(listSessionTranscriptCorpusEntriesForAgent("foreign", {}, reader)).rejects.toThrow(
    "another agent",
  );
});

it("keeps selected Memory absence separate from a retained ended actor", async () => {
  const missingEnv = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-memory-absence-") };
  const scope = {
    agentId: "main",
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: missingEnv }),
    sessionKey: "agent:main:dashboard:incognito-missing-memory",
    sessionId: "missing-memory",
  };
  const config = vi.spyOn(memoryRuntime, "getRuntimeConfig").mockReturnValue({
    session: { store: scope.storePath },
  });
  const readMissing = async () => {
    expect(await buildSessionEntry("actor-memory", scope)).toBeNull();
    expect(await readSessionResetRecallCutoff(scope)).toEqual({ state: "invalid" });
    expect(await listSessionTranscriptCorpusEntriesForAgent("main")).toEqual([]);
    expect(await loadArchivedSessionsAsync({ ...scope, sessionIds: [scope.sessionId] })).toEqual(
      [],
    );
    expect(
      await resolveMemorySessionTargetsAsync({ ...scope, sessionIds: [scope.sessionId] }),
    ).toEqual([expect.objectContaining({ sessionId: scope.sessionId, resolution: "unresolved" })]);
  };
  let missingActor: IncognitoAgentDatabaseExecution | undefined;
  try {
    await withEnvAsync(missingEnv, () =>
      withIncognitoSessionBinding(
        { kind: "absent", agentId: "main", env: missingEnv, authority },
        readMissing,
      ),
    );
    expect(captureOpenClawAgentDatabaseExecution.listIncognito(missingEnv)).toEqual([]);
    missingActor = await openIncognitoTestActor(missingEnv, authority);
    await withEnvAsync(missingEnv, () => withIncognitoSessionActor(missingActor!, readMissing));
    await missingActor.close();
    await withIncognitoSessionBinding({ actor: missingActor }, async () => {
      await expect(buildSessionEntry("actor-memory", scope)).rejects.toBeInstanceOf(
        IncognitoSessionEndedError,
      );
      await expect(readSessionResetRecallCutoff(scope)).rejects.toBeInstanceOf(
        IncognitoSessionEndedError,
      );
      await expect(
        loadArchivedSessionsAsync({ ...scope, sessionIds: [scope.sessionId] }),
      ).rejects.toBeInstanceOf(IncognitoSessionEndedError);
    });
  } finally {
    await missingActor?.close();
    config.mockRestore();
  }
});

it("prepares real Active Memory prompt and status hooks from the actor SDK without durable ingestion", async () => {
  const { scope } = await session("active-memory-hooks");
  const { default: plugin } = await loadBundledPluginFacade<{ default: OpenClawPluginDefinition }>({
    pluginId: "active-memory",
    artifactBasename: "index.js",
  });
  assert(plugin.register);
  const pluginConfig = { agents: ["main"], mode: "escalate" };
  const config = {
    session: { store: actor.path },
    plugins: { entries: { "active-memory": { enabled: true, config: pluginConfig } } },
  };
  const runtime = createPluginRuntime();
  runtime.config.current = () => config;
  runtime.agent.resolveCliBackendDispatchEligibility = () => undefined;
  runtime.state.openKeyedStore = (options) =>
    createPluginStateKeyedStoreForTests("active-memory", { ...options, env });
  let beforePrompt: PluginHookHandlerMap["before_prompt_build"] | undefined;
  let command: OpenClawPluginCommandDefinition | undefined;
  const warnings = vi.fn();
  plugin.register(
    buildPluginApi({
      id: "active-memory",
      name: "Active Memory",
      source: "test",
      registrationMode: "full",
      config,
      pluginConfig,
      runtime,
      logger: { info() {}, warn: warnings, error() {}, debug() {} },
      resolvePath: (value) => value,
      handlers: {
        on(name, handler) {
          if (name === "before_prompt_build") {
            beforePrompt = handler as PluginHookHandlerMap["before_prompt_build"];
          }
        },
        registerCommand(value) {
          command = value;
        },
      },
    }),
  );
  assert(beforePrompt);
  assert(command);
  const promptHook = beforePrompt;
  const statusCommand = command;
  const context = {
    agentId: "main",
    sessionKey: scope.sessionKey,
    sessionId: scope.sessionId,
    trigger: "user",
    messageProvider: "webchat",
    toolAuthority: { fingerprint: "memory-test", allows: () => true, assertActive() {} },
  };
  const event = { prompt: "Hello there", messages: [] };
  await withEnvAsync(env, () =>
    withIncognitoSessionActor(actor, async () => {
      expect(await promptHook(event, context)).toEqual({
        prependContext: expect.stringContaining("intentionally skipped deep recall"),
      });
      expect(
        await statusCommand.handler({
          channel: "webchat",
          sessionId: scope.sessionId,
          args: "status",
          isAuthorizedSender: true,
          commandBody: "/active-memory status",
          config,
          requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
          detachConversationBinding: async () => ({ removed: false }),
          getCurrentConversationBinding: async () => null,
        }),
      ).toEqual({
        text: [
          "Active Memory: on for this session.",
          "Trigger recall configuration: on for agent main.",
          "Remember across conversations setting: on.",
        ].join("\n"),
      });
      expect(
        await promptHook(event, {
          ...context,
          assertMemoryAudienceCurrent() {
            throw new Error("Memory audience revoked");
          },
        }),
      ).toBeUndefined();
      expect(warnings).toHaveBeenCalledWith(expect.stringContaining("Memory audience revoked"));
    }),
  );
});

it("materializes retained corpus entries and fences keyless discovery against a successor", async () => {
  const { scope, target } = await session("retained-memory");
  const foreign = await session("retained-memory-foreign");
  await withEnvAsync(env, () =>
    withIncognitoSessionActor(actor, async () => {
      const manager = await SessionManager.openAsync(scope);
      await manager.appendResetBoundaryAsync("reset");
      await manager.appendMessageAsync({
        role: "assistant",
        content: [{ type: "text", text: "retained Memory answer" }],
        api: "openai-responses",
        provider: "test-provider",
        model: "test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 20000,
      });
    }),
  );
  const branch = async (sourceId: string, sessionId: string) => {
    const result = await actor.sessions.transcript(authority, {
      type: "session.manager.transcript.branch",
      input: {
        sessionKey: target.sessionKey,
        command: {
          type: "session.transcript.branch",
          input: {
            scope: { ...scope, sessionId: sourceId },
            branch: { sessionId, events: [] },
            expectedLifecycleRevision: target.lifecycleRevision,
          },
        },
      },
    });
    assert(result.ok);
  };
  const currentId = `${target.sessionId}-current`;
  await branch(target.sessionId, currentId);
  const config = vi
    .spyOn(memoryRuntime, "getRuntimeConfig")
    .mockReturnValue({ session: { store: actor.path } });
  let discovered: SessionTranscriptCorpusEntry | undefined;
  try {
    const corpus = await withIncognitoSessionActor(actor, () =>
      listSessionTranscriptCorpusEntriesForAgent("main", { includeRetainedSqlite: true }),
    );
    discovered = corpus.find((entry) => entry.sessionId === target.sessionId);
  } finally {
    config.mockRestore();
  }
  const retained = discovered;
  assert(retained?.artifactKind === "retained-session");
  const marker = formatSqliteSessionFileMarker(scope);
  await withIncognitoSessionActor(actor, async () => {
    expect((await buildSessionEntry(retained.sessionFile, retained))?.content).toContain(
      "retained Memory answer",
    );
    expect((await buildSessionEntry(marker))?.content).toContain("retained Memory answer");
    const { sessionKey: _sessionKey, ...keyless } = scope;
    expect(await readSessionResetRecallCutoff(keyless)).toEqual({ state: "valid", cutoffLine: 4 });
    expect(await readSessionResetRecallCutoff({ ...scope, sessionId: currentId })).toEqual({
      state: "absent",
    });
    await expect(
      buildSessionEntry(retained.sessionFile, {
        ...retained,
        sessionKey: foreign.target.sessionKey,
      }),
    ).rejects.toThrow("Memory transcript belongs to another session");
  });

  for (const kind of ["entry", "reset", "corpus"] as const) {
    for (const mutate of [false, true]) {
      const cleanupEntered = createDeferredCore();
      const cleanupResume = createDeferredCore();
      const pauseCleanup = <T>(pending: Promise<T>) =>
        pending.then(async (result) => {
          cleanupEntered.resolve();
          await cleanupResume.promise;
          return result;
        });
      const retain = actor.sessions.withCompute.bind(actor.sessions);
      const computeCleanup =
        kind !== "corpus"
          ? vi
              .spyOn(actor.sessions, "withCompute")
              .mockImplementation(
                <T>(
                  grant: IncognitoSessionAuthority,
                  selected: IncognitoComputeTarget | undefined,
                  operation: (source: IncognitoComputeScope) => Promise<T>,
                  signal?: AbortSignal,
                  onRead?: (facts: readonly IncognitoSessionFacts[]) => void,
                ) => {
                  const result = retain(grant, selected, operation, signal, onRead);
                  return selected ? result : pauseCleanup(result);
                },
              )
          : undefined;
      const readCorpus = incognitoCorpus.readIncognitoMemoryCorpus;
      const corpusCleanup =
        kind === "corpus"
          ? vi
              .spyOn(incognitoCorpus, "readIncognitoMemoryCorpus")
              .mockImplementation((...args) => pauseCleanup(readCorpus(...args)))
          : undefined;
      const corpusConfig =
        kind === "corpus"
          ? vi
              .spyOn(memoryRuntime, "getRuntimeConfig")
              .mockReturnValue({ session: { store: actor.path } })
          : undefined;
      const reading = withIncognitoSessionActor(actor, async () => {
        if (kind === "entry") {
          return buildSessionEntry(marker);
        }
        if (kind === "reset") {
          const { sessionKey: _sessionKey, ...keyless } = scope;
          return readSessionResetRecallCutoff(keyless);
        }
        return listSessionTranscriptCorpusEntriesForAgent("main", { includeRetainedSqlite: true });
      });
      const expected =
        kind === "entry"
          ? expect.objectContaining({ content: expect.stringContaining("retained Memory answer") })
          : kind === "reset"
            ? { state: "valid", cutoffLine: 4 }
            : expect.arrayContaining([expect.objectContaining({ sessionId: target.sessionId })]);
      const checked = mutate
        ? expect(reading).rejects.toThrow("snapshot changed")
        : expect(reading).resolves.toEqual(expected);
      try {
        await awaitGateBeforeSettlement(
          cleanupEntered.promise,
          reading,
          `Memory ${kind} settled before outer cleanup`,
        );
        if (mutate) {
          const appended = await actor.sessions.transcript(authority, {
            type: "session.message.append",
            input: {
              sessionKey: target.sessionKey,
              sessionId: currentId,
              fence: { expectedLifecycleRevision: target.lifecycleRevision },
              message: {
                role: "assistant",
                content: "same-generation cleanup mutation",
                timestamp: 30000,
              },
            },
          });
          assert(appended.ok);
        }
        cleanupResume.resolve();
        await checked;
      } finally {
        cleanupResume.resolve();
        await Promise.allSettled([reading, checked]);
        computeCleanup?.mockRestore();
        corpusCleanup?.mockRestore();
        corpusConfig?.mockRestore();
      }
    }
  }

  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const compute = actor.sessions.withCompute.bind(actor.sessions);
  const paused = vi
    .spyOn(actor.sessions, "withCompute")
    .mockImplementation(
      <T>(
        grant: IncognitoSessionAuthority,
        selected: IncognitoComputeTarget | undefined,
        operation: (source: IncognitoComputeScope) => Promise<T>,
        signal?: AbortSignal,
      ) =>
        compute(
          grant,
          selected,
          (source) =>
            operation({
              ...source,
              async execute<Key extends keyof IncognitoComputeOperations>(command: {
                type: Key;
                input: IncognitoComputeOperations[Key]["input"];
              }): Promise<IncognitoComputeOperations[Key]["output"]> {
                const result = await source.execute(command);
                if (command.type === "session.compute.store.inventory") {
                  entered.resolve();
                  await resume.promise;
                }
                return result;
              },
            }),
          signal,
        ),
    );
  let observed = 0;
  const reading = withIncognitoSessionActor(actor, () =>
    buildSessionEntry(marker, {
      onTranscriptMessage() {
        observed++;
      },
    }),
  );
  const rejected = expect(reading).rejects.toThrow("generation is no longer current");
  try {
    await awaitGateBeforeSettlement(
      entered.promise,
      reading,
      "Retained Memory read bypassed source inventory",
    );
    await branch(currentId, `${target.sessionId}-successor`);
    resume.resolve();
    await rejected;
    expect(observed).toBe(0);
  } finally {
    resume.resolve();
    await Promise.allSettled([reading, rejected]);
    paused.mockRestore();
  }
});

it("retains every corpus session generation before lazy reader preparation", async () => {
  await session("corpus-capture-first");
  const sibling = await session("corpus-capture-sibling");
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const config = vi
    .spyOn(memoryRuntime, "getRuntimeConfig")
    .mockReturnValue({ session: { store: actor.path } });
  const readCorpus = incognitoCorpus.readIncognitoMemoryCorpus;
  const paused = vi
    .spyOn(incognitoCorpus, "readIncognitoMemoryCorpus")
    .mockImplementation(async (...args) => {
      entered.resolve();
      await resume.promise;
      return readCorpus(...args);
    });
  const reading = withIncognitoSessionActor(actor, () =>
    listSessionTranscriptCorpusEntriesForAgent("main", { includeRetainedSqlite: true }),
  );
  const rejected = expect(reading).rejects.toThrow("generation is no longer current");
  try {
    await awaitGateBeforeSettlement(entered.promise, reading, "Corpus reader was not entered");
    const branched = await actor.sessions.transcript(authority, {
      type: "session.manager.transcript.branch",
      input: {
        sessionKey: sibling.target.sessionKey,
        command: {
          type: "session.transcript.branch",
          input: {
            scope: sibling.scope,
            branch: { sessionId: `${sibling.target.sessionId}-next`, events: [] },
            expectedLifecycleRevision: sibling.target.lifecycleRevision,
          },
        },
      },
    });
    assert(branched.ok);
    resume.resolve();
    await rejected;
  } finally {
    resume.resolve();
    await Promise.allSettled([reading, rejected]);
    paused.mockRestore();
    config.mockRestore();
  }
});

it("checks current authority before each Memory callback and refuses the parsed result after revocation", async () => {
  const admission = new AbortController();
  const { scope } = await session("callback-revocation");
  const observed: unknown[] = [];
  await expect(
    withIncognitoSessionActor(
      actor,
      () =>
        buildSessionEntry("actor-memory", {
          ...scope,
          onTranscriptMessage(message) {
            observed.push(message);
            admission.abort(new Error("Memory authority revoked"));
          },
        }),
      admission.signal,
    ),
  ).rejects.toThrow("Memory authority revoked");
  expect(observed).toHaveLength(1);
});

it("refuses Memory disclosure after an intervening actor transcript write", async () => {
  const { scope, target } = await session("callback-rewrite");
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const project = sessionFiles.buildSessionEntryFromSnapshot;
  const paused = vi
    .spyOn(sessionFiles, "buildSessionEntryFromSnapshot")
    .mockImplementation(async (...args) => {
      entered.resolve();
      await resume.promise;
      return project(...args);
    });
  const reading = withIncognitoSessionActor(actor, () => buildSessionEntry("actor-memory", scope));
  const rejected = expect(reading).rejects.toThrow("snapshot changed");
  try {
    await awaitGateBeforeSettlement(entered.promise, reading, "Memory projection was not entered");
    await actor.sessions.transcript(authority, {
      type: "session.message.append",
      input: {
        ...target,
        fence: { expectedLifecycleRevision: target.lifecycleRevision },
        message: { role: "assistant", content: "intervening change" },
      },
    });
    resume.resolve();
    await rejected;
  } finally {
    resume.resolve();
    await reading.catch(() => undefined);
    paused.mockRestore();
  }
});

it("joins accepted Memory parsing before releasing its original actor borrow", async () => {
  const borrowed = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  assert(borrowed);
  const { reader, scope } = await session("callback-release", authority, borrowed);
  let releasing: Promise<void> | undefined;
  let released = false;
  let disclosed = 0;
  try {
    await expect(
      buildSessionEntry(
        "actor-memory",
        {
          ...scope,
          onTranscriptMessage() {
            disclosed++;
            releasing ??= borrowed.release().then(() => {
              released = true;
            });
            expect(released).toBe(false);
          },
        },
        reader,
      ),
    ).rejects.toThrow("released");
    expect(disclosed).toBe(1);
    await releasing;
    expect(released).toBe(true);
  } finally {
    await borrowed.release();
  }
});

it("refuses Memory results when final compute authorization releases the borrow", async () => {
  const borrowed = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  assert(borrowed);
  let projected = false;
  let retiring: Promise<void> | undefined;
  const grant: IncognitoSessionAuthority = {
    assertCurrent() {},
    authorize() {
      if (projected) {
        retiring ??= borrowed.release();
      }
    },
  };
  const { reader, scope } = await session("final-compute-release", grant, borrowed);
  const project = sessionFiles.buildSessionEntryFromSnapshot;
  const projection = vi
    .spyOn(sessionFiles, "buildSessionEntryFromSnapshot")
    .mockImplementation(async (...args) => {
      const result = await project(...args);
      projected = true;
      return result;
    });
  let disclosed = false;
  try {
    await expect(
      borrowed.sessions.withSharedState(async () => {
        await buildSessionEntry("actor-memory", scope, reader);
        disclosed = true;
      }),
    ).rejects.toThrow("released");
    expect(disclosed).toBe(false);
  } finally {
    projection.mockRestore();
    await retiring;
    await borrowed.release();
  }
});

it("authorizes every corpus session in the actor grant before returning sibling metadata", async () => {
  const selected = await session("corpus-selected");
  const sibling = await session("corpus-sibling");
  const command = {
    type: "session.history.memory-corpus" as const,
    input: {
      ...selected.target,
      sessionKeys: [selected.target.sessionKey, sibling.target.sessionKey],
      scope: {
        cfg: {},
        env,
        normalizedAgentId: actor.agentId,
        storePath: actor.path,
        isSharedFixedStore: false,
        artifactDirs: [],
      },
      options: {},
    },
  };
  await expect(
    actor.sessions.history(
      {
        assertCurrent() {},
        authorize(_stage, facts) {
          if (facts.sessionKey !== selected.target.sessionKey) {
            throw new Error("Sibling corpus access revoked");
          }
        },
      },
      command,
    ),
  ).rejects.toThrow("Sibling corpus access revoked");
  const rows = await actor.sessions.history(authority, {
    ...command,
    input: { ...command.input, sessionKeys: [selected.target.sessionKey] },
  });
  expect(rows.map((row) => row.sessionKey)).toEqual([selected.target.sessionKey]);
});
