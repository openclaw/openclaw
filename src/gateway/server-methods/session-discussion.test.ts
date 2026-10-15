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
import { sessionDiscussionHandlers } from "./session-discussion.js";

const mocks = vi.hoisted(() => ({
  emitSessionTitleChanged: vi.fn(),
  generateConversationLabelWithFallback: vi.fn(),
  getProvider: vi.fn(),
  loadSessionTarget: vi.fn(),
  maybeGenerateSessionTitle: vi.fn(),
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
// mock-isolation: The title owner reads the same synthetic session through its worker API.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: async () => mocks.loadSessionTarget()?.entry,
}));
vi.mock("../dashboard-session-title.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../dashboard-session-title.js")>();
  mocks.maybeGenerateSessionTitle.mockImplementation(actual.maybeGenerateSessionTitle);
  return { ...actual, maybeGenerateSessionTitle: mocks.maybeGenerateSessionTitle };
});
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
  method: Method,
  params: Record<string, unknown>,
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
  return {
    value: { id: "test", info, open } satisfies SessionDiscussionProvider,
    info,
    open,
  };
}

describe("session discussion gateway methods", () => {
  beforeEach(() => {
    mocks.emitSessionTitleChanged.mockReset();
    mocks.generateConversationLabelWithFallback.mockReset();
    mocks.getProvider.mockReset();
    mocks.loadSessionTarget.mockReset();
    mocks.maybeGenerateSessionTitle.mockClear();
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

  it.each(["session.discussion.open"] as const)(
    "returns none when %s has no provider",
    async (method) => {
      mocks.getProvider.mockReturnValue(undefined);
      expect(await invoke(method, { sessionKey: "agent:main:thread" })).toMatchObject({
        ok: true,
        payload: { state: "none" },
      });
    },
  );

  it("admits bare fixed-store keys only through their persisted owner", async () => {
    const registered = provider();
    mocks.getProvider.mockReturnValue(registered.value);
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
    mocks.getProvider.mockReturnValue(registered.value);

    expect(
      await invoke("session.discussion.open", { sessionKey: "agent:main:thread-alias" }),
    ).toMatchObject({
      ok: true,
      payload: { state: "available" },
    });
    expect(registered.open).toHaveBeenCalledWith({
      sessionKey: "agent:main:thread-alias",
      agentId: "main",
    });

    expect(mocks.maybeGenerateSessionTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        entry,
        sessionId: "session-1",
        sessionKey,
        storePath,
        userMessage: "",
      }),
    );
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

  it("does not generate a title for an explicitly named session", async () => {
    mockSession({ sessionId: "session-1", updatedAt: 1, displayName: "Manual title" });
    const registered = provider();
    mocks.getProvider.mockReturnValue(registered.value);

    await invoke("session.discussion.open", { sessionKey });

    expect(mocks.maybeGenerateSessionTitle).not.toHaveBeenCalled();
    expect(mocks.readSessionTitleFields).not.toHaveBeenCalled();
    expect(registered.open).toHaveBeenCalledOnce();
  });

  it("opens the discussion when title generation times out", async () => {
    vi.useFakeTimers();
    mockSession({ sessionId: "session-timeout", updatedAt: 1 });
    mocks.readSessionTitleFields.mockReturnValue({
      firstUserMessage: "Plan the release",
      lastMessagePreview: null,
    });
    // Resolvable deferred: settling it after the assertions evicts the shared
    // single-flight map entry so module state stays clean across suites.
    let releaseGeneration: ((value: string | null) => void) | undefined;
    mocks.generateConversationLabelWithFallback.mockReturnValue(
      new Promise<string | null>((resolve) => {
        releaseGeneration = resolve;
      }),
    );
    const registered = provider();
    mocks.getProvider.mockReturnValue(registered.value);

    const responsePromise = invoke("session.discussion.open", { sessionKey });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(responsePromise).resolves.toMatchObject({
      ok: true,
      payload: { state: "available" },
    });
    expect(registered.open).toHaveBeenCalledOnce();
    expect(mocks.emitSessionTitleChanged).toHaveBeenCalledOnce();
    releaseGeneration?.(null);
    // Bounded flush: eviction settles via microtasks, so advancing 0ms is
    // enough. runAllTimersAsync livelocks (10000-timer abort) when any other
    // suite in a shared shard worker schedules an interval into this fake clock.
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.emitSessionTitleChanged).toHaveBeenCalledTimes(2);
  });

  it.each(["session.discussion.open"] as const)(
    "returns a retryable error when the provider throws from %s",
    async (method) => {
      const registered = provider();
      registered.open.mockRejectedValueOnce(new Error("provider failed"));
      mocks.getProvider.mockReturnValue(registered.value);
      const previousDiagnostics = areDiagnosticsEnabledForProcess();
      const phases: DiagnosticEventPayload[] = [];
      const stop = onTrustedInternalDiagnosticEvent((event) => phases.push(event), {
        include: ["diagnostic.phase.completed"],
      });
      setDiagnosticsEnabledForProcess(true);
      try {
        expect(await invoke(method, { sessionKey: "agent:main:thread" })).toMatchObject({
          ok: false,
          error: { code: "UNAVAILABLE" },
        });
        await waitForDiagnosticEventsDrained();
        expect(phases).toEqual([
          expect.objectContaining({
            type: "diagnostic.phase.completed",
            name: `${method}.provider`,
            durationMs: expect.any(Number),
          }),
        ]);
        expect(JSON.stringify(phases)).not.toContain(sessionKey);
        expect(JSON.stringify(phases)).not.toContain("provider failed");
      } finally {
        stop();
        setDiagnosticsEnabledForProcess(previousDiagnostics);
      }
    },
  );

  it.each(["session.discussion.open"] as const)(
    "rejects a malformed provider result from %s",
    async (method) => {
      const registered = provider();
      registered.open.mockResolvedValueOnce({ state: "invalid" } as never);
      mocks.getProvider.mockReturnValue(registered.value);

      expect(await invoke(method, { sessionKey: "agent:main:thread" })).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });
    },
  );

  it.each(["session.discussion.open"] as const)(
    "rejects an empty session key for %s",
    async (method) => {
      expect(await invoke(method, { sessionKey: "" })).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
    },
  );
});
