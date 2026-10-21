import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { readSessionEntrySummariesInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { upsertSessionUpstreamLink } from "../../sessions/session-upstream-links.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  cfg,
  expectCutFailure as expectFailure,
  expectCutReply,
  installHarness,
  invokeHandler as invoke,
  restrictedOperator,
  sessionKey,
  sourceSessionId,
} from "./sessions-rewind.handler.test-support.js";

const mocks = { upstreamFork: vi.fn() };
const forkFailure = {
  status: "failed",
  code: "upstream-unavailable",
  message: "Codex is offline. Try again.",
};
let state: OpenClawTestState;

beforeEach(async () => {
  mocks.upstreamFork.mockReset();
  setActivePluginRegistry(createEmptyPluginRegistry());
  state = await createOpenClawTestState({ label: "rewind-upstream", layout: "state-only" });
  setRuntimeConfigSnapshot(cfg);
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    { sessionId: sourceSessionId, updatedAt: Date.now() },
  );
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
});

afterEach(async () => {
  await state.cleanup();
  resetPluginRuntimeStateForTest();
});

function installUpstreamForkHarness(
  executionEnvironment?: "host-only",
  contract: "dual" | "legacy" | "v2" = "v2",
): void {
  const sessionFork = {
    upstreamKinds: ["codex-app-server" as const],
    fork: mocks.upstreamFork,
  };
  installHarness({
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
  });
}

function entries() {
  return readSessionEntrySummariesInWorker({
    agentId: "main",
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
  });
}

function expectExternalOwner(respond: ReturnType<typeof vi.fn>) {
  expectFailure(respond, {
    code: ErrorCodes.INVALID_REQUEST,
    message: expect.stringContaining("external agent harness"),
  });
}

describe("upstream session message-cut methods", () => {
  it("rejects mutation but lists empty branches for externally owned conversations", async () => {
    const respond = await invoke("sessions.branches.switch", "off-path-entry");
    expectExternalOwner(respond);
    // Listing is read-only: "no local branches" is the truthful steady state,
    // not an error to latch into the UI.
    const listed = await invoke("sessions.branches.list");
    expectCutReply(listed, { branches: [] });
  });

  it.each(["sessions.rewind", "sessions.branches.switch"] as const)(
    "rejects %s for upstream-linked sessions even with a fork-capable harness",
    async (method) => {
      installUpstreamForkHarness();
      expectExternalOwner(await invoke(method));
      expect(mocks.upstreamFork).not.toHaveBeenCalled();
    },
  );

  it("delegates complete upstream fork materialization to the harness", async () => {
    installUpstreamForkHarness(undefined, "dual");
    mocks.upstreamFork.mockResolvedValue({
      status: "created",
      key: "agent:main:dashboard:forked",
      editorText: "edit me",
    });

    const respond = await invoke("sessions.fork");
    expectCutReply(respond, { editorText: "edit me", sessionKey: "agent:main:dashboard:forked" });
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
      installUpstreamForkHarness();
      let retainedAssertCurrent: (() => void) | undefined;
      mocks.upstreamFork.mockImplementation(
        async ({ assertCurrent }: { assertCurrent: () => void }) => {
          assertCurrent();
          retainedAssertCurrent = assertCurrent;
          return outcome === "created"
            ? { status: "created", key: "agent:main:dashboard:forked" }
            : forkFailure;
        },
      );

      await invoke("sessions.fork");

      const nativeWrites = vi.fn();
      expect(() => {
        expectDefined(retainedAssertCurrent, "retained native-write authority")();
        nativeWrites();
      }).toThrow("Session initialization source is closed");
      expect(nativeWrites).not.toHaveBeenCalled();
    },
  );

  it.each(["dual", "legacy", "v2"] as const)(
    "rejects the current creator's required sandbox before invoking a host-only %s upstream fork",
    async (contract) => {
      const { options } = await restrictedOperator(
        `sandbox-required-${contract}-fork@example.com`,
        "main",
        "required",
        false,
      );
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      installUpstreamForkHarness("host-only", contract);
      const fork = await withPluginRuntimeGatewayRequestScope(
        { client: options.client, isWebchatConnect: () => false },
        () => invoke("sessions.fork", undefined, options),
      );
      expectFailure(fork, {
        details: expect.objectContaining({
          code: "AGENT_RUNTIME_RESTRICTED",
          reason: "sandbox-required",
        }),
      });
      expect(mocks.upstreamFork).not.toHaveBeenCalled();
      expect(await entries()).toHaveLength(1);
    },
  );

  it.each([
    { failure: forkFailure, code: ErrorCodes.UNAVAILABLE },
    {
      failure: {
        status: "failed",
        code: "drift-mismatch",
        message: "boundary failed: drift-mismatch",
      },
      code: ErrorCodes.INVALID_REQUEST,
    },
  ])(
    "passes through $failure.code without mutating the local session",
    async ({ failure, code }) => {
      installUpstreamForkHarness();
      mocks.upstreamFork.mockResolvedValue(failure);
      const entryCount = (await entries()).length;
      expectFailure(await invoke("sessions.fork"), {
        code,
        details: { reason: failure.code },
        message: failure.message,
      });
      expect(await entries()).toHaveLength(entryCount);
    },
  );
});
