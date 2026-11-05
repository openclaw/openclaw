import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { fixedStoreOwnershipConfig } from "./sessions-fixed-store.test-support.js";

const mocks = vi.hoisted(() => ({
  emitSessionTitleChanged: vi.fn(),
  generateTitle: vi.fn<typeof import("../dashboard-session-title.js").maybeGenerateSessionTitle>(),
  getProvider: vi.fn(),
  loadSessionTarget: vi.fn(),
}));

vi.mock("../../plugins/session-discussion-registry.js", () => ({
  getSessionDiscussionProvider: mocks.getProvider,
}));
// mock-isolation: Capture title delegation without starting title generation or persistence workers.
vi.mock("../dashboard-session-title.js", () => ({
  maybeGenerateSessionTitle: mocks.generateTitle,
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

const cfg: OpenClawConfig = {};
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

function mockSession(sessionId?: string): void {
  mocks.loadSessionTarget.mockReturnValue({
    canonicalKey: sessionKey,
    entry: sessionId ? { sessionId, updatedAt: 1 } : undefined,
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
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.generateTitle.mockResolvedValue(true);
    mockSession(undefined);
  });

  afterEach(() => vi.useRealTimers());

  it("returns none when open has no provider", async () => {
    expect(await invoke()).toMatchObject({ ok: true, payload: { state: "none" } });
  });

  it("admits bare fixed-store keys only through their persisted owner", async () => {
    const registered = provider();
    mockSession("session-ops-global");
    const ownedConfig: OpenClawConfig = fixedStoreOwnershipConfig("/tmp/shared-sessions.sqlite");

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

  it("delegates title generation to the canonical session and publishes its title event", async () => {
    mockSession("session-1");
    const identity = { sessionKey, sessionId: "session-1", agentId: "main" };
    mocks.generateTitle.mockImplementation(async ({ onTitleStateChanged }) => {
      onTitleStateChanged?.();
      return true;
    });
    const registered = provider();

    expect(
      await invoke("session.discussion.open", { sessionKey: "agent:main:thread-alias" }),
    ).toMatchObject({ ok: true, payload: { state: "available" } });
    expect(registered.open).toHaveBeenCalledWith({
      sessionKey: "agent:main:thread-alias",
      agentId: "main",
    });

    expect(mocks.generateTitle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ...identity, storePath }),
    );
    expect(
      mocks.generateTitle.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    ).toBeLessThan(registered.open.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY);
    expect(mocks.emitSessionTitleChanged).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining(identity),
    );
  });

  it("opens the discussion when title generation times out", async () => {
    vi.useFakeTimers();
    mockSession("session-timeout");
    const generation = createDeferredCore<boolean>();
    const generationStarted = createDeferredCore();
    mocks.generateTitle.mockImplementation(() => {
      generationStarted.resolve();
      return generation.promise;
    });
    const registered = provider();
    const responsePromise = invoke();
    await generationStarted.promise;
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(responsePromise).resolves.toMatchObject({
      ok: true,
      payload: { state: "available" },
    });
    expect(registered.open).toHaveBeenCalledOnce();
    generation.resolve(false);
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
