import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { preserveSessionCatalogHistory } from "../../plugins/session-catalog-history-import.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import type { createGatewaySession } from "../session-create-service.js";
import type { resolveSessionMutationAuthorization } from "../session-sharing.js";
import type { SessionCatalogThreadVisibility } from "./session-catalog-visibility.js";
import { createSessionMutationTestContext } from "./sessions-mutations.owner.test-support.js";

const mocks = vi.hoisted(() => ({
  create: vi.fn<typeof createGatewaySession>(),
  preserve: vi.fn<typeof preserveSessionCatalogHistory>(),
  record: vi.fn(),
  authorize: vi.fn<typeof resolveSessionMutationAuthorization>(),
  visibility: vi.fn<() => SessionCatalogThreadVisibility["visibility"]>(),
  visibilityAllowed:
    vi.fn<typeof import("../session-sharing-policy.js").isSessionVisibilityAllowed>(),
}));

// Durable creation, projection, and transcript custody remain covered together
// in the release-tier integration suite; this file exercises import orchestration.
vi.mock("../session-create-service.js", () => ({ createGatewaySession: mocks.create }));
vi.mock("../../sessions/session-state-events.js", () => ({
  recordSessionStateEventAsync: mocks.record,
}));
vi.mock("../../plugin-sdk/session-transcript-runtime.js", () => ({
  withSessionTranscriptWriteLock: vi.fn(),
}));
vi.mock("../../plugins/session-catalog-history-import.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/session-catalog-history-import.js")>()),
  preserveSessionCatalogHistory: mocks.preserve,
}));
vi.mock("../session-sharing.js", () => ({
  resolveSessionMutationAuthorization: mocks.authorize,
}));
vi.mock("../session-sharing-policy.js", () => ({
  hasSessionReadAccessChanged: vi.fn(),
  isSessionVisibilityAllowed: mocks.visibilityAllowed,
}));
vi.mock("../session-sharing-target-read.js", () => ({
  readProjectedSessionMutationTarget: vi.fn(),
}));
vi.mock("./session-catalog-visibility.js", () => ({
  resolveSessionCatalogVisibility: mocks.visibility,
  isPublishedCatalogVisible: vi.fn(() => true),
}));
vi.mock("../session-identity-projection.js", () => ({ projectSessionParticipant: vi.fn() }));
// Keep the real commit-guard composition without loading unrelated WS admission owners.
vi.mock("../auth-policy.js", () => ({}));
vi.mock("../operator-role-policy.js", () => ({}));
vi.mock("../server-shared-auth-generation.js", () => ({}));

const { importAuthorizedSessionCatalog } = await import("./session-catalog-import.js");

const visibility: SessionCatalogThreadVisibility["visibility"] = {
  kind: "unrestricted",
  cacheKey: "original-grant",
};
const denied: ErrorShape = { code: "FORBIDDEN", message: "Destination is not writable" };

function fixture(config: OpenClawConfig = {}) {
  const read = vi.fn<SessionCatalogProvider["read"]>(async ({ hostId, threadId }) => ({
    hostId,
    threadId,
    label: "Private host title",
    items: [{ id: "first", type: "userMessage", text: "Synthetic source message" }],
  }));
  const reauthorize = vi.fn<() => Promise<SessionCatalogThreadVisibility | null>>(async () => ({
    visibility,
  }));
  const commitGuard = vi.fn();
  const provider: SessionCatalogProvider = {
    id: "fixture",
    label: "Fixture",
    list: vi.fn(),
    read,
  };
  const run = () =>
    importAuthorizedSessionCatalog({
      request: {
        catalogId: "fixture",
        hostId: "node:fixture",
        threadId: "thread-one",
      },
      provider,
      agentId: "main",
      allowProcessHomeFallback: false,
      client: null,
      context: createSessionMutationTestContext(config),
      reauthorize,
      commitGuard,
    });
  return { read, reauthorize, commitGuard, run };
}

function expectNoWrites() {
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.preserve).not.toHaveBeenCalled();
  expect(mocks.record).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.visibility.mockReturnValue(visibility);
  mocks.visibilityAllowed.mockReturnValue(true);
  mocks.authorize.mockReturnValue({ error: null });
});

describe("session catalog import orchestration", () => {
  it("leaves creation visibility to the Gateway default when drafts are disabled", async () => {
    const config: OpenClawConfig = { session: { sharing: { drafts: false } } };
    mocks.visibilityAllowed.mockReturnValue(false);
    mocks.create.mockResolvedValue({
      ok: true,
      agentId: "main",
      key: "agent:main:imported",
      entry: { sessionId: "imported", updatedAt: 1 },
      resolved: { modelProvider: "fixture", model: "fixture" },
      resetExisting: false,
      postCommit: { status: "completed" },
    });
    await expect(fixture(config).run()).resolves.toMatchObject({ ok: true });
    expect(mocks.visibilityAllowed).toHaveBeenCalledWith(config, "draft");
    expect(mocks.create.mock.calls[0]?.[0]).not.toHaveProperty("defaultVisibility");
  });

  it("returns destination authorization failures without creating or recording an import", async () => {
    mocks.authorize.mockReturnValue({ error: denied });
    await expect(fixture().run()).resolves.toEqual({ ok: false, error: denied });
    expectNoWrites();
  });

  it("discards fetched history when source reauthorization denies access", async () => {
    const subject = fixture();
    subject.reauthorize.mockResolvedValue(null);
    await expect(subject.run()).resolves.toBeNull();
    expect(subject.read).toHaveBeenCalledOnce();
    expectNoWrites();
  });

  it("stops before reading another page after request custody is revoked", async () => {
    const subject = fixture();
    subject.read.mockImplementationOnce(async ({ hostId, threadId }) => {
      subject.commitGuard.mockImplementation(() => {
        throw new Error("Request custody revoked");
      });
      return {
        hostId,
        threadId,
        items: [{ id: "newest", type: "userMessage", text: "Newest page" }],
        nextCursor: "older-page",
      };
    });
    await expect(subject.run()).rejects.toThrow("Request custody revoked");
    expect(subject.read).toHaveBeenCalledOnce();
    expect(subject.reauthorize).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("rechecks the source grant at the creation commit boundary", async () => {
    mocks.create.mockImplementation(async ({ commitGuard }) => {
      mocks.visibility.mockReturnValue({ kind: "unrestricted", cacheKey: "replacement-grant" });
      commitGuard?.();
      throw new Error("Stale source grant reached creation");
    });
    await expect(fixture().run()).rejects.toThrow("Session catalog source visibility changed");
    expect(mocks.preserve).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("retains destination authority in the creation commit guard", async () => {
    mocks.authorize.mockReturnValue({
      error: null,
      authorization: {
        assertCurrent: () => {
          throw new Error("Destination authority revoked");
        },
        assertTargetCurrent: vi.fn(),
      },
    });
    mocks.create.mockImplementation(async ({ commitGuard }) => {
      commitGuard?.();
      throw new Error("Revoked destination reached creation");
    });
    await expect(fixture().run()).rejects.toThrow("Destination authority revoked");
    expect(mocks.preserve).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("returns creation refusal without a successful import event", async () => {
    mocks.create.mockResolvedValue({ ok: false, error: denied });
    await expect(fixture().run()).resolves.toEqual({ ok: false, error: denied });
    expect(mocks.preserve).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("reports a post-commit import failure instead of recording success", async () => {
    const failure = new Error("Transcript write failed");
    mocks.create.mockResolvedValue({
      ok: true,
      agentId: "main",
      key: "agent:main:imported",
      entry: { sessionId: "imported", updatedAt: 1 },
      resolved: { modelProvider: "fixture", model: "fixture" },
      resetExisting: false,
      postCommit: { status: "failed", error: failure },
    });
    await expect(fixture().run()).rejects.toBe(failure);
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
