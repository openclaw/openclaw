import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  areDiagnosticsEnabledForProcess,
  onTrustedInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import type { SessionDiscussionProvider } from "../../plugins/session-discussion-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { sessionDiscussionHandlers } from "./session-discussion.js";

const mocks = vi.hoisted(() => ({
  emitSessionTitleChanged: vi.fn(),
  generateConversationLabelWithFallback: vi.fn(),
  getProvider: vi.fn(),
  loadSessionTarget: vi.fn(),
  readSessionTitleFields: vi.fn(),
  resolveUtilityModelRefForAgent: vi.fn(),
  updateSessionEntry: vi.fn(),
}));

vi.mock("../../plugins/session-discussion-registry.js", () => ({
  getSessionDiscussionProvider: mocks.getProvider,
}));
vi.mock("../../agents/utility-model.js", () => ({
  resolveUtilityModelRefForAgent: mocks.resolveUtilityModelRefForAgent,
}));
vi.mock("../../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback: mocks.generateConversationLabelWithFallback,
}));
// mock-isolation: Title persistence is captured by this fixture without opening a database.
vi.mock("../../config/sessions/session-accessor.js", () => ({
  patchSessionEntryCore: mocks.updateSessionEntry,
}));
// mock-isolation: Discussion title tests supply current entry facts without opening SQLite.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: async () => mocks.loadSessionTarget()?.entry,
}));
// mock-isolation: Discussion tests supply title fields without starting transcript workers.
vi.mock("../session-transcript-title-reader.js", () => ({
  readSessionTitleFieldsFromTranscriptAsync: mocks.readSessionTitleFields,
}));
// mock-isolation: Capture title lifecycle notifications without starting Gateway broadcast workers.
vi.mock("./session-change-event.js", () => ({
  emitSessionTitleChanged: mocks.emitSessionTitleChanged,
}));
// mock-isolation: Discussion fixtures own selected targets and rows without admitting physical stores.
vi.mock("../session-utils-store-lookup.js", () => ({
  withGatewaySessionStoreTarget: async (
    _params: unknown,
    consume: (target: unknown) => unknown,
  ) => {
    const selected = mocks.loadSessionTarget();
    return consume({
      ...selected.target,
      canonicalKey: selected.canonicalKey,
      storePath: selected.storePath,
      storeKeys: [selected.canonicalKey],
      store: selected.entry ? { [selected.canonicalKey]: selected.entry } : {},
    });
  },
}));

const cfg = {
  agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
} as OpenClawConfig;
const sessionKey = "agent:main:thread";
const storePath = "/tmp/openclaw/sessions.sqlite";

type Method = "session.discussion.info" | "session.discussion.open";

async function invoke(
  method: Method = "session.discussion.open",
  params: Record<string, unknown> = { sessionKey },
  runtimeConfig: OpenClawConfig = cfg,
) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  await sessionDiscussionHandlers[method]?.({
    req: { type: "req", id: method, method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => calls.push({ ok, payload, error }),
    context: { getRuntimeConfig: () => runtimeConfig } as never,
  });
  return calls[0];
}

function mockSession(entry: SessionEntry | undefined): void {
  mocks.loadSessionTarget.mockReturnValue({
    canonicalKey: sessionKey,
    entry,
    storePath,
    target: { agentId: "main" },
  });
}

function provider() {
  const info = vi.fn<SessionDiscussionProvider["info"]>().mockResolvedValue({
    state: "open",
    embedUrl: "https://chat.example/embed/thread",
    openUrl: "https://chat.example/thread",
  });
  const open = vi.fn<SessionDiscussionProvider["open"]>().mockResolvedValue({ state: "available" });
  const value = { id: "test", info, open } satisfies SessionDiscussionProvider;
  mocks.getProvider.mockReturnValue(value);
  return value;
}

describe("session discussion gateway methods", () => {
  beforeEach(() => {
    mocks.emitSessionTitleChanged.mockReset();
    mocks.generateConversationLabelWithFallback.mockReset();
    mocks.getProvider.mockReset();
    mocks.loadSessionTarget.mockReset();
    mocks.readSessionTitleFields.mockReset();
    mocks.resolveUtilityModelRefForAgent.mockReset();
    mocks.updateSessionEntry.mockReset();
    mocks.generateConversationLabelWithFallback.mockResolvedValue("Release Planning");
    mocks.readSessionTitleFields.mockReturnValue({
      firstUserMessage: null,
      lastMessagePreview: null,
    });
    mocks.resolveUtilityModelRefForAgent.mockReturnValue("openai/gpt-5.6-luna");
    mockSession(undefined);
  });

  afterEach(() => vi.useRealTimers());

  it("returns none when open has no provider", async () => {
    expect(await invoke()).toMatchObject({ ok: true, payload: { state: "none" } });
  });

  it("admits bare fixed-store keys only through their persisted owner", async () => {
    const registered = provider();
    mockSession({ sessionId: "session-ops-global", updatedAt: 1 });
    const ownedConfig: OpenClawConfig = {
      session: { scope: "global", store: "/tmp/shared-sessions.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };

    expect(
      await invoke("session.discussion.open", { sessionKey: "global" }, ownedConfig),
    ).toMatchObject({ ok: true, payload: { state: "available" } });
    expect(registered.open).toHaveBeenCalledWith({
      sessionKey: "global",
      agentId: "ops",
    });

    const ownerlessConfig: OpenClawConfig = {
      ...ownedConfig,
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    };
    expect(
      await invoke("session.discussion.info", { sessionKey: "global" }, ownerlessConfig),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("has no explicit owner") },
    });
    expect(registered.info).not.toHaveBeenCalled();
  });

  it("persists a generated title before opening an untitled session discussion", async () => {
    const entry: SessionEntry = { sessionId: "session-1", updatedAt: 1, systemSent: true };
    let persistedEntry: SessionEntry | undefined;
    mockSession(entry);
    mocks.readSessionTitleFields.mockReturnValue({
      firstUserMessage: "[Mon 2026-07-27 09:00 PDT] Plan the release",
      lastMessagePreview: null,
    });
    mocks.updateSessionEntry.mockImplementation(async (_scope, update) => {
      const patch = await update({ ...entry });
      persistedEntry = patch ? { ...entry, ...patch } : undefined;
      return persistedEntry;
    });
    const registered = provider();

    expect(
      await invoke("session.discussion.open", { sessionKey: "agent:main:thread-alias" }),
    ).toMatchObject({ ok: true, payload: { state: "available" } });
    expect(registered.open).toHaveBeenCalledWith({
      sessionKey: "agent:main:thread-alias",
      agentId: "main",
    });

    expect(mocks.updateSessionEntry.mock.calls[0]?.[0]).toMatchObject({
      agentId: "main",
      sessionKey,
      storePath,
    });
    expect(persistedEntry?.displayName).toBe("Release Planning");
    expect(mocks.generateConversationLabelWithFallback).toHaveBeenCalledOnce();
    expect(
      mocks.updateSessionEntry.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    ).toBeLessThan(registered.open.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY);
    expect(mocks.emitSessionTitleChanged).toHaveBeenCalledTimes(2);
    expect(mocks.emitSessionTitleChanged).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionKey,
        sessionId: "session-1",
        agentId: "main",
      }),
    );
  });

  it("opens the discussion when title generation times out", async () => {
    vi.useFakeTimers();
    mockSession({ sessionId: "session-timeout", updatedAt: 1 });
    mocks.readSessionTitleFields.mockReturnValue({
      firstUserMessage: "Plan the release",
      lastMessagePreview: null,
    });
    // Settle after timeout to evict the shared single-flight entry.
    const generation = createDeferredCore<string | null>();
    const generationStarted = createDeferredCore();
    mocks.generateConversationLabelWithFallback.mockImplementation(() => {
      generationStarted.resolve();
      return generation.promise;
    });
    const registered = provider();
    const responsePromise = invoke();
    // Skill discovery precedes inference and may yield to real filesystem work.
    // Start the fake timeout only after the deferred provider call is active.
    await generationStarted.promise;
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(responsePromise).resolves.toMatchObject({
      ok: true,
      payload: { state: "available" },
    });
    expect(registered.open).toHaveBeenCalledOnce();
    expect(mocks.emitSessionTitleChanged).toHaveBeenCalledOnce();
    generation.resolve(null);
    // Bounded flush: eviction settles via microtasks, so advancing 0ms is
    // enough. runAllTimersAsync livelocks (10000-timer abort) when any other
    // suite in a shared shard worker schedules an interval into this fake clock.
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.emitSessionTitleChanged).toHaveBeenCalledTimes(2);
  });

  it("returns a retryable error when the provider throws from open", async () => {
    const registered = provider();
    registered.open.mockRejectedValueOnce(new Error("provider failed"));
    const previousDiagnostics = areDiagnosticsEnabledForProcess();
    const phases: DiagnosticEventPayload[] = [];
    const stop = onTrustedInternalDiagnosticEvent((event) => phases.push(event), {
      include: ["diagnostic.phase.completed"],
    });
    setDiagnosticsEnabledForProcess(true);
    try {
      expect(await invoke()).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });
      await waitForDiagnosticEventsDrained();
      expect(phases).toEqual([
        expect.objectContaining({
          type: "diagnostic.phase.completed",
          name: "session.discussion.open.provider",
          durationMs: expect.any(Number),
        }),
      ]);
      expect(JSON.stringify(phases)).not.toContain(sessionKey);
      expect(JSON.stringify(phases)).not.toContain("provider failed");
    } finally {
      stop();
      setDiagnosticsEnabledForProcess(previousDiagnostics);
    }
  });

  it("rejects a malformed provider result from open", async () => {
    provider().open.mockResolvedValueOnce({ state: "invalid" } as never);
    expect(await invoke()).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  });

  it("rejects an empty session key for open", async () => {
    expect(await invoke("session.discussion.open", { sessionKey: "" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  });
});
