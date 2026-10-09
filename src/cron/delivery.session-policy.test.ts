import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { setMinimalOutboundSessionPluginRegistryForTests } from "../infra/outbound/outbound-session.test-helpers.js";
import { makeJob } from "./isolated-agent.test-harness.js";

const mocks = vi.hoisted(() => ({
  updateSessionLastRoute: vi.fn(),
  loadSessionEntryReadOnly: vi.fn<() => SessionEntry | undefined>(),
  warn: vi.fn(),
}));
// mock-isolation: Observe route writes without opening a real session database.
vi.mock("../config/sessions/inbound.runtime.js", () => ({
  resolveSessionStorePathCore: (_store: unknown, params: { agentId: string }) =>
    `/stores/${params.agentId}.json`,
  updateSessionLastRoute: mocks.updateSessionLastRoute,
}));
// mock-isolation: Supply source policy and storage failures independently of SQLite.
vi.mock("../config/sessions/session-accessor.js", () => ({
  loadSessionEntryReadOnly: mocks.loadSessionEntryReadOnly,
}));
// mock-isolation: Capture policy warnings without writing process-global log files.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    warn: mocks.warn,
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));
// mock-isolation: Confirm transport success without queue custody or a network channel.
vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore: vi.fn(async () => ({ status: "sent" })),
  durableMessageBatchMayHaveReachedRecipient: () => true,
}));
// mock-isolation: Pin an explicit target without channel discovery or last-route reads.
vi.mock("./isolated-agent/delivery-target.js", () => ({
  resolveDeliveryTarget: vi.fn(async () => ({
    ok: true,
    channel: "fallbackchat",
    to: "user:recipient",
    mode: "explicit",
  })),
}));
// mock-isolation: Announcement identity must not read an agent workspace in this policy test.
vi.mock("../infra/outbound/identity.js", () => ({ resolveAgentOutboundIdentity: () => undefined }));
// mock-isolation: Delivery context must not load unrelated source-session metadata.
vi.mock("../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: () => ({}),
}));
// mock-isolation: No live channel send dependencies are needed behind the transport boundary.
vi.mock("../cli/outbound-send-deps.js", () => ({ createOutboundSendDeps: () => ({}) }));
// mock-isolation: Keep transcript mirroring outside this destination-policy test.
vi.mock("./isolated-agent/session.js", () => ({ loadCronSessionEntryLatest: () => undefined }));

// Load the announcement graph after Vitest installs the transport and storage boundaries.
const { sendCronAnnouncePayloadStrict } = await import("./delivery.js");

async function announce(sessionKey?: string) {
  const job = makeJob({ kind: "command", argv: ["echo", "report"] });
  return sendCronAnnouncePayloadStrict({
    cfg: { session: { dmScope: "per-channel-peer" } },
    deps: {},
    agentId: "main",
    jobId: job.id,
    target: { channel: "fallbackchat", to: "user:recipient", sessionKey },
    payload: { text: "report" },
    abortSignal: new AbortController().signal,
    completion: { job, runStartedAt: 1000, deliveryAttemptFence: null },
  });
}

describe("command announcement session policy", () => {
  beforeEach(() => {
    setMinimalOutboundSessionPluginRegistryForTests();
    vi.clearAllMocks();
    mocks.loadSessionEntryReadOnly.mockReset();
    mocks.updateSessionLastRoute.mockResolvedValue({ sessionId: "destination", updatedAt: 1 });
  });

  it("persists the destination route without interpreting a notification identity as a source session", async () => {
    await announce();
    expect(mocks.updateSessionLastRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:fallbackchat:direct:recipient",
        createIfMissing: true,
        channel: "fallbackchat",
        to: "user:recipient",
      }),
    );
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("inherits a real source session's required sandbox policy", async () => {
    mocks.loadSessionEntryReadOnly.mockReturnValue({
      sessionId: "source",
      updatedAt: 1,
      createdVia: "operator",
      sandbox: "required",
    });
    await announce("agent:other:main");
    expect(mocks.updateSessionLastRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          SessionCreation: expect.objectContaining({ via: "operator", sandbox: "required" }),
        }),
      }),
    );
  });

  it("still warns when a real source policy cannot be read without blocking delivery", async () => {
    mocks.loadSessionEntryReadOnly.mockImplementation(() => {
      throw new Error("source storage unavailable");
    });
    expect(await announce("agent:other:main")).toMatchObject({ status: "sent" });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to preserve outbound session creation policy"),
    );
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("source storage unavailable"));
    expect(mocks.updateSessionLastRoute).not.toHaveBeenCalled();
  });
});
