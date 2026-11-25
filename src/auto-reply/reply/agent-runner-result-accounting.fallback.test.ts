import { afterEach, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { persistSessionTranscriptTurn } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildGatewaySessionRow } from "../../gateway/session-utils-row.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { readSessionFallbackModelAsync } from "../../status/session-fallback-model.js";
import { useAccountingFixture } from "./agent-runner-accounting.test-support.js";
import { accountAgentTurn } from "./agent-runner-result-accounting.js";

const diagnostic = { provider: "primary-fixture", model: "thinking" };
const fallback = { provider: "fallback-fixture", model: "plain" };
const noActiveModel = { activeModelProvider: undefined, activeModel: undefined };
const { database, createFixture: createAccounting } = useAccountingFixture(
  "openclaw-fallback-projection-",
);
afterEach(clearRuntimeConfigSnapshot);

async function createFixture(selected = diagnostic) {
  const { storePath } = database;
  const cfg: OpenClawConfig = {
    session: { store: storePath },
    agents: { defaults: { model: { primary: `${selected.provider}/${selected.model}` } } },
  };
  setRuntimeConfigSnapshot(cfg);
  const f = await createAccounting();
  const { context, sessionId } = f;
  const sessionKey = context.sessionKey!;
  const entry: InternalSessionEntry = {
    sessionId,
    lifecycleRevision: "generation-1",
    updatedAt: 1,
    modelProvider: selected.provider,
    model: selected.model,
  };
  await f.replace(entry);
  context.activeSessionEntry = context.activeSessionStore![sessionKey] = entry;
  context.cfg = cfg;
  context.defaultModel = selected.model;
  Object.assign(context.followupRun.run, selected, { config: cfg });
  context.execution = {
    kind: "settled",
    status: "ok",
    result: { payloads: [{ text: "done" }], meta: { durationMs: 1 } },
    resolved: selected,
    fallback: { exhausted: false, attempts: [] },
    autoCompactionCount: 0,
  };
  const scope = { agentId: "main", storePath, sessionKey, sessionId: entry.sessionId };
  return {
    ...f,
    persist: (
      route: { provider: string; model: string },
      {
        runId = context.runId,
        text = "done",
        stopReason = "stop",
        display,
      }: {
        runId?: string;
        text?: string;
        stopReason?: "stop" | "length";
        display?: boolean;
      } = {},
    ) =>
      persistSessionTranscriptTurn(scope, {
        config: context.cfg,
        expectedSessionId: entry.sessionId,
        runId,
        messages: [
          {
            message: {
              role: "assistant",
              content: [{ type: "text", text }],
              ...route,
              stopReason,
              ...(display === undefined ? {} : { display }),
            },
          },
        ],
        ...(display === false
          ? {}
          : { sessionLifecyclePatch: { status: "done", lastRunId: runId } }),
      }),
    project: (
      rowEntry: InternalSessionEntry,
      terminalModel?: Awaited<ReturnType<typeof readSessionFallbackModelAsync>> | null,
    ) =>
      buildGatewaySessionRow({
        cfg: context.cfg,
        agentId: "main",
        lightweightListRow: true,
        storePath,
        store: { [sessionKey]: rowEntry },
        key: sessionKey,
        entry: rowEntry,
        ...(terminalModel === undefined ? {} : { terminalModel }),
      }),
    account: async (route: { provider: string; model: string }) => {
      context.execution.result.meta.agentMeta = {
        sessionId: entry.sessionId,
        contextTokens: 1_000,
        ...route,
      };
      return f.withCompletion((completion) => accountAgentTurn({ ...context, completion }));
    },
  };
}

it("does not persist or project a fallback for the selected model's wire identity", async () => {
  const fixture = await createFixture({ provider: "arcee", model: "trinity-large-preview" });
  const { context } = fixture;
  const entry = context.activeSessionEntry!;
  entry.fallbackNotice = {
    kind: "active",
    selectedModel: "arcee/trinity-large-preview",
    activeModel: "arcee/arcee-ai/trinity-large-preview",
    reason: "selected model unavailable",
  };
  await fixture.replace(entry);

  const accounting = await fixture.account({
    provider: "arcee",
    model: "arcee-ai/trinity-large-preview",
  });
  expect(accounting.fallbackTransition).toMatchObject({
    fallbackActive: false,
    fallbackCleared: false,
  });
  expect(fixture.read()?.fallbackNotice).toBeUndefined();
  await fixture.persist({ provider: "arcee", model: "arcee-ai/trinity-large-preview" });
  const stored = fixture.read()!;
  expect(fixture.project(stored)).toMatchObject({
    modelProvider: "arcee",
    model: "trinity-large-preview",
    ...noActiveModel,
  });
});

it.each([false, true])(
  "projects a completed fallback with stored primary=%s",
  async (storedPrimary) => {
    const { storePath } = database;
    const fixture = await createFixture();
    const { context } = fixture;
    const entry = context.activeSessionEntry!;
    if (!storedPrimary) {
      delete entry.model;
      delete entry.modelProvider;
    }
    await fixture.replace(entry);
    context.execution.resolved = fallback;
    context.execution.fallback.attempts = [
      {
        ...diagnostic,
        error: "model not found",
        reason: "model_not_found",
      },
    ];

    await fixture.account(fallback);
    await fixture.persist(fallback);

    const stored = fixture.read()!;
    expect(stored.fallbackNotice).toMatchObject({
      selectedModel: `${diagnostic.provider}/${diagnostic.model}`,
      activeModel: "fallback-fixture/plain",
    });
    const project = async (rowEntry: InternalSessionEntry) =>
      fixture.project(
        rowEntry,
        (await readSessionFallbackModelAsync({
          config: context.cfg,
          selectedProvider: diagnostic.provider,
          selectedModel: diagnostic.model,
          sessionEntry: rowEntry,
          sessionScope: { agentId: "main", storePath, sessionKey: context.sessionKey! },
        })) ?? null,
      );
    expect(await project(stored)).toMatchObject({
      modelProvider: diagnostic.provider,
      model: diagnostic.model,
      activeModelProvider: "fallback-fixture",
      activeModel: "plain",
    });
    for (const changed of [
      { lastRunId: "another-run" },
      { sessionId: "another-session" },
      { providerOverride: "another-provider", modelOverride: "another-model" },
    ]) {
      expect(await project({ ...stored, ...changed }), JSON.stringify(changed)).toMatchObject(
        noActiveModel,
      );
    }

    const activeRunId = `${context.runId}-active`;
    registerAgentRunContext(activeRunId, {
      agentId: "main",
      sessionId: entry.sessionId,
      sessionKey: context.sessionKey,
      projectSessionActive: true,
    });
    try {
      expect(await project(stored)).toMatchObject(noActiveModel);
    } finally {
      clearAgentRunContext(activeRunId);
    }

    const recoveryRunId = `${context.runId}-recovery`;
    await fixture.persist(fallback, { text: "hidden answer", display: false });
    expect((await project(fixture.read()!)).activeModel).toBeUndefined();
    await fixture.persist(diagnostic, {
      runId: recoveryRunId,
      text: "recovered",
      stopReason: "length",
    });
    // The newer completed primary answer rejects the old notice even before accounting clears it.
    const recovered = fixture.read()!;
    expect(recovered.fallbackNotice).toEqual(stored.fallbackNotice);
    expect(await project(recovered)).toMatchObject({
      modelProvider: diagnostic.provider,
      model: diagnostic.model,
      ...noActiveModel,
    });
    context.execution.resolved = diagnostic;
    context.execution.fallback.attempts = [];
    await fixture.account(diagnostic);
    expect(fixture.read()?.fallbackNotice).toBeUndefined();
  },
);
