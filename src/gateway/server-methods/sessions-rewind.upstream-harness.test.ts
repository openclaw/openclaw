import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import {
  listSessionEntriesCore,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  upsertSessionUpstreamLink,
  upsertSessionUpstreamLinkAsync,
} from "../../sessions/session-upstream-links.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { sessionRewindHandlers } from "./sessions-rewind.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const mocks = { upstreamFork: vi.fn() };
const sessionKey = "agent:main:rewind-handler";
const sourceSessionId = "rewind-handler-source";
let state: OpenClawTestState;

beforeEach(async () => {
  mocks.upstreamFork.mockReset();
  setActivePluginRegistry(createEmptyPluginRegistry());
  state = await createOpenClawTestState({ label: "rewind-upstream", layout: "state-only" });
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    { sessionId: sourceSessionId, updatedAt: Date.now() },
  );
});

afterEach(async () => {
  await state.cleanup();
  resetPluginRuntimeStateForTest();
});

async function invoke(
  method:
    | "sessions.branches.list"
    | "sessions.branches.switch"
    | "sessions.fork"
    | "sessions.rewind",
  entryId?: string,
  client: GatewayClient | null = null,
  runtimeConfig?: GatewayRequestContext["getRuntimeConfig"],
) {
  const respond = vi.fn();
  await expectDefined(
    sessionRewindHandlers[method],
    `${method} handler`,
  )({
    req: { id: `${method}-request` } as never,
    params: {
      sessionKey,
      ...(method === "sessions.branches.switch"
        ? { leafEntryId: entryId }
        : method === "sessions.branches.list"
          ? {}
          : { entryId }),
    },
    respond,
    context: {
      broadcastToConnIds: vi.fn(),
      chatAbortControllers: new Map(),
      getRuntimeConfig: runtimeConfig ?? (() => ({ agents: { entries: { main: {} } } })),
      getSessionEventSubscriberConnIds: () => new Set(),
    } as unknown as GatewayRequestContext,
    client,
    isWebchatConnect: () => false,
  });
  return respond;
}

function linkToUpstreamConversation(): void {
  expect(
    upsertSessionUpstreamLink({
      agentId: "main",
      catalogId: "codex",
      hostId: "gateway:local",
      marker: { turnId: "turn-2", userMessageCount: 1 },
      sessionKey,
      threadId: "thread-source",
      upstreamKind: "codex-app-server",
      upstreamRef: { connectionFingerprint: "fingerprint", threadId: "thread-source" },
    }),
  ).toBe(true);
}

function installUpstreamForkHarness(
  executionEnvironment?: "host-only",
  contract: "dual" | "legacy" | "v2" = "v2",
): void {
  const sessionFork = {
    upstreamKinds: ["codex-app-server" as const],
    fork: mocks.upstreamFork,
  };
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: "test-harness",
    source: "runtime",
    harness: {
      id: "test-harness",
      label: "Test harness",
      runAttempt: async () => {
        throw new Error("not used");
      },
      ...(contract !== "v2"
        ? { ...(executionEnvironment ? { executionEnvironment } : {}), sessionFork }
        : {}),
      ...(contract !== "legacy"
        ? {
            sessionForkV2: {
              ...(executionEnvironment ? { executionEnvironment } : {}),
              ...sessionFork,
            },
          }
        : {}),
      supports: () => ({ supported: false }),
    },
  });
  setActivePluginRegistry(registry);
}

describe("upstream session message-cut methods", () => {
  it("rejects mutation but lists empty branches for externally owned conversations", async () => {
    linkToUpstreamConversation();
    const respond = await invoke("sessions.branches.switch", "off-path-entry");
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("external agent harness"),
      }),
    );
    // Listing is read-only: "no local branches" is the truthful steady state,
    // not an error to latch into the UI.
    const listed = await invoke("sessions.branches.list");
    expect(listed).toHaveBeenCalledWith(true, { branches: [] }, undefined);
  });

  it.each(["sessions.rewind", "sessions.branches.switch"] as const)(
    "rejects %s for upstream-linked sessions even with a fork-capable harness",
    async (method) => {
      linkToUpstreamConversation();
      installUpstreamForkHarness();
      const respond = await invoke(method, "user-entry");

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.INVALID_REQUEST,
          message: expect.stringContaining("external agent harness"),
        }),
      );
      expect(mocks.upstreamFork).not.toHaveBeenCalled();
    },
  );

  it("delegates complete upstream fork materialization to the harness", async () => {
    linkToUpstreamConversation();
    installUpstreamForkHarness(undefined, "dual");
    mocks.upstreamFork.mockResolvedValue({
      status: "created",
      key: "agent:main:dashboard:forked",
      editorText: "edit me",
    });

    const respond = await invoke("sessions.fork", "user-entry");
    expect(respond).toHaveBeenCalledWith(
      true,
      { editorText: "edit me", sessionKey: "agent:main:dashboard:forked" },
      undefined,
    );
    expect(mocks.upstreamFork).toHaveBeenCalledWith(
      expect.objectContaining({
        assertCurrent: expect.any(Function),
        source: expect.objectContaining({ entryId: "user-entry", sessionKey }),
        targetKey: expect.stringMatching(/^agent:main:dashboard:/),
        upstream: expect.objectContaining({
          catalogId: "codex",
          hostId: "gateway:local",
          kind: "codex-app-server",
          threadId: "thread-source",
        }),
      }),
    );
  });

  it.each(["created", "failed"] as const)(
    "expires native-write authority when the upstream fork settles %s",
    async (outcome) => {
      linkToUpstreamConversation();
      installUpstreamForkHarness();
      let retainedAssertCurrent: (() => void) | undefined;
      mocks.upstreamFork.mockImplementation(
        async ({ assertCurrent }: { assertCurrent: () => void }) => {
          assertCurrent();
          retainedAssertCurrent = assertCurrent;
          return outcome === "created"
            ? { status: "created", key: "agent:main:dashboard:forked" }
            : {
                status: "failed",
                code: "upstream-unavailable",
                message: "Codex is offline. Try again.",
              };
        },
      );

      await invoke("sessions.fork", "user-entry");

      const nativeWrites = vi.fn();
      expect(() => {
        expectDefined(retainedAssertCurrent, "retained native-write authority")();
        nativeWrites();
      }).toThrow("Session initialization source is closed");
      expect(nativeWrites).not.toHaveBeenCalled();
    },
  );

  it("rejects a worker-committed upstream source change before deferred native fork I/O", async () => {
    linkToUpstreamConversation();
    installUpstreamForkHarness();
    const nativeWrite = vi.fn();
    mocks.upstreamFork.mockImplementation(
      async ({ assertCurrent }: { assertCurrent: () => void }) => {
        assertCurrent();
        await Promise.resolve();
        expect(
          await upsertSessionUpstreamLinkAsync({
            agentId: "main",
            catalogId: "codex",
            hostId: "gateway:local",
            marker: null,
            sessionKey,
            threadId: "replacement-thread",
            upstreamKind: "codex-app-server",
            upstreamRef: { connectionFingerprint: "fingerprint", threadId: "replacement-thread" },
          }),
        ).toBe(true);
        assertCurrent();
        nativeWrite();
        return { status: "created", key: "agent:main:dashboard:forked" };
      },
    );

    await expect(invoke("sessions.fork", "user-entry")).rejects.toThrow(
      "changed during fork initialization",
    );
    expect(nativeWrite).not.toHaveBeenCalled();
    expect(loadSessionEntry({ agentId: "main", sessionKey })?.sessionId).toBe(sourceSessionId);
  });

  it.each(["dual", "legacy", "v2"] as const)(
    "rejects the current creator's required sandbox before invoking a host-only %s upstream fork",
    async (contract) => {
      const profile = ensureProfileForEmail(`sandbox-required-${contract}-fork@example.com`);
      setUserProfileRole(profile.id, "guest");
      const client = {
        connect: { scopes: ["operator.write"] },
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: profile.displayName,
          hasAvatar: false,
          updatedAt: profile.updatedAt,
        },
      } as GatewayClient;
      const runtimeConfig: GatewayRequestContext["getRuntimeConfig"] = () => ({
        agents: { entries: { main: {} } },
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others: "view" },
                agents: ["main"],
                scopes: ["operator.read", "operator.write"],
                sandbox: "required",
              },
            },
          },
        },
      });
      linkToUpstreamConversation();
      installUpstreamForkHarness("host-only", contract);
      const fork = await withPluginRuntimeGatewayRequestScope(
        { client, isWebchatConnect: () => false },
        () => invoke("sessions.fork", "user-entry", client, runtimeConfig),
      );
      expect(fork).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          details: expect.objectContaining({
            code: "AGENT_RUNTIME_RESTRICTED",
            reason: "sandbox-required",
          }),
        }),
      );
      expect(mocks.upstreamFork).not.toHaveBeenCalled();
      expect(listSessionEntriesCore({ agentId: "main" })).toHaveLength(1);
    },
  );

  it("does not mutate the local session when the upstream fork fails", async () => {
    linkToUpstreamConversation();
    installUpstreamForkHarness();
    mocks.upstreamFork.mockResolvedValue({
      status: "failed",
      code: "upstream-unavailable",
      message: "Codex is offline. Try again.",
    });

    const entryCount = listSessionEntriesCore({ agentId: "main" }).length;
    const respond = await invoke("sessions.fork", "user-entry");

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        details: { reason: "upstream-unavailable" },
      }),
    );
    expect(listSessionEntriesCore({ agentId: "main" })).toHaveLength(entryCount);
  });

  it("passes through an invalid fork boundary failure", async () => {
    const reason = "drift-mismatch";
    linkToUpstreamConversation();
    installUpstreamForkHarness();
    mocks.upstreamFork.mockResolvedValue({
      status: "failed",
      code: reason,
      message: `boundary failed: ${reason}`,
    });

    const respond = await invoke("sessions.fork", "user-entry");

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        details: { reason },
        message: `boundary failed: ${reason}`,
      }),
    );
  });
});
