import { beforeEach, expect, it, vi } from "vitest";
import type { ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { preserveSessionCatalogHistory } from "../../plugins/session-catalog-history-import.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import type { createGatewaySession } from "../session-create-service.js";
import type { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import type { SessionCatalogThreadVisibility } from "./session-catalog-visibility.js";
import { createSessionMutationTestContext } from "./sessions-mutations.owner.test-support.js";

const mocks = vi.hoisted(() => ({
  create: vi.fn<typeof createGatewaySession>(),
  preserve: vi.fn<typeof preserveSessionCatalogHistory>(),
  record: vi.fn(),
  authorize: vi.fn<typeof resolveSessionMutationAuthorizationAsync>(),
  visibility: vi.fn<() => SessionCatalogThreadVisibility["visibility"]>(),
  visibilityAllowed:
    vi.fn<typeof import("../session-sharing-policy.js").isSessionVisibilityAllowed>(),
}));

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
// mock-isolation: Exercise import orchestration without loading the live sharing/admission owners.
vi.mock("../session-sharing-authorization-async.js", () => ({
  resolveSessionMutationAuthorizationAsync: mocks.authorize,
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
const source = { hostId: "node:fixture", threadId: "thread-one" };
const page = { ...source, items: [{ id: "first", type: "userMessage" as const, text: "source" }] };

function fixture(config: OpenClawConfig = {}) {
  const read = vi.fn<SessionCatalogProvider["read"]>(async () => page);
  const reauthorize = vi.fn<() => Promise<SessionCatalogThreadVisibility | null>>(async () => ({
    visibility,
  }));
  const commitGuard = vi.fn();
  const run = () =>
    importAuthorizedSessionCatalog({
      request: { catalogId: "fixture", ...source },
      provider: { id: "fixture", label: "Fixture", list: vi.fn(), read },
      agentId: "main",
      allowProcessHomeFallback: false,
      client: null,
      context: createSessionMutationTestContext(config),
      reauthorize,
      commitGuard,
    });
  return { read, reauthorize, commitGuard, run };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.visibility.mockReturnValue(visibility);
  mocks.visibilityAllowed.mockReturnValue(true);
  mocks.authorize.mockResolvedValue({ error: null });
});

it.each(["completed", "failed"] as const)("handles %s post-commit import", async (status) => {
  const config: OpenClawConfig = { session: { sharing: { drafts: false } } };
  const failure = new Error("Transcript write failed");
  mocks.visibilityAllowed.mockReturnValue(status === "failed");
  mocks.create.mockResolvedValue({
    ok: true,
    agentId: "main",
    key: "agent:main:imported",
    entry: { sessionId: "imported", updatedAt: 1 },
    resolved: { modelProvider: "fixture", model: "fixture" },
    resetExisting: false,
    postCommit: status === "completed" ? { status } : { status, error: failure },
  });
  if (status === "completed") {
    await expect(fixture(config).run()).resolves.toMatchObject({ ok: true });
    expect(mocks.visibilityAllowed).toHaveBeenCalledWith(config, "draft");
    expect(mocks.create.mock.calls[0]?.[0]).not.toHaveProperty("defaultVisibility");
  } else {
    await expect(fixture().run()).rejects.toBe(failure);
    expect(mocks.record).not.toHaveBeenCalled();
  }
});

it.each(["destination", "source", "custody", "creation"] as const)(
  "does not preserve or record an import after %s refusal",
  async (stage) => {
    const subject = fixture();
    if (stage === "destination") {
      mocks.authorize.mockResolvedValue({ error: denied });
    } else if (stage === "source") {
      subject.reauthorize.mockResolvedValue(null);
    } else if (stage === "creation") {
      mocks.create.mockResolvedValue({ ok: false, error: denied });
    } else {
      subject.read.mockImplementationOnce(async () => {
        subject.commitGuard.mockImplementation(() => {
          throw new Error("Request custody revoked");
        });
        return { ...page, nextCursor: "older-page" };
      });
    }
    if (stage === "custody") {
      await expect(subject.run()).rejects.toThrow("Request custody revoked");
      expect(subject.reauthorize).not.toHaveBeenCalled();
    } else if (stage === "source") {
      await expect(subject.run()).resolves.toBeNull();
    } else {
      await expect(subject.run()).resolves.toEqual({ ok: false, error: denied });
    }
    expect(subject.read).toHaveBeenCalledOnce();
    if (stage !== "creation") {
      expect(mocks.create).not.toHaveBeenCalled();
    }
    expect(mocks.preserve).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  },
);

it.each([
  ["source", "Session catalog source visibility changed"],
  ["destination", "Destination authority revoked"],
] as const)("rechecks %s authority at the creation commit boundary", async (authority, error) => {
  if (authority === "destination") {
    mocks.authorize.mockResolvedValue({
      error: null,
      authorization: {
        assertCurrent: () => {
          throw new Error("Destination authority revoked");
        },
        assertTargetCurrent: vi.fn(),
      },
    });
  }
  mocks.create.mockImplementation(async ({ commitGuard }) => {
    if (authority === "source") {
      mocks.visibility.mockReturnValue({ kind: "unrestricted", cacheKey: "replacement-grant" });
    }
    commitGuard?.();
    throw new Error("Revoked authority reached creation");
  });
  await expect(fixture().run()).rejects.toThrow(error);
  expect(mocks.preserve).not.toHaveBeenCalled();
  expect(mocks.record).not.toHaveBeenCalled();
});
