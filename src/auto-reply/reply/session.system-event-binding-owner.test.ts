/** System events (restart resume, cron, heartbeat) must not read channel-owned conversation bindings. */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  isSessionBindingError,
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "../../infra/outbound/session-binding-service.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { initSessionState } from "./session.js";

// mock-isolation: Session init runs without the process-global plugin hook registry.
vi.mock("../../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => null }));
// mock-isolation: Skip channel summary building; this suite only checks binding-owner reads.
vi.mock("../../infra/channel-summary.js", () => ({ buildChannelSummary: vi.fn(async () => []) }));

const CHANNEL = "owned-chat";
const SESSION_KEY = `agent:main:${CHANNEL}:group:room-1`;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;

// A channel whose bindings live in an account adapter that only registers once the
// channel account starts (Telegram, Discord, Matrix). Startup restart resume runs first.
function installAdapterOwnedChannel() {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: CHANNEL,
        source: "test",
        plugin: {
          id: CHANNEL,
          meta: { aliases: [] },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
            bindingStore: "adapter",
          },
        },
      },
    ] as never),
  );
}

async function seedSession() {
  stateDir = tempDirs.make("openclaw-system-event-binding-");
  const storePath = path.join(stateDir, "sessions.json");
  await replaceSessionEntry(
    { storePath, sessionKey: SESSION_KEY },
    { sessionId: "interrupted-session", updatedAt: Date.now(), systemSent: true },
  );
  return {
    agents: { defaults: { workspace: stateDir } },
    session: { store: storePath },
  };
}

function routedTurn(extra: Record<string, unknown>) {
  return finalizeInboundContext({
    AgentId: "main",
    SessionKey: SESSION_KEY,
    Provider: CHANNEL,
    Surface: CHANNEL,
    OriginatingChannel: CHANNEL,
    OriginatingTo: "room-1",
    To: "room-1",
    AccountId: "default",
    ChatType: "group",
    ...extra,
  });
}

// Mirrors buildSessionEventContext for a restart-resume event.
const restartResumeEvent = () =>
  routedTurn({
    Body: "Gateway restarted; continue the interrupted turn.",
    InternalTurnSource: "event",
    CommandAuthorized: false,
    BodyForCommands: "",
    CommandBody: "",
    RawBody: "",
  });

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  installAdapterOwnedChannel();
});
afterEach(async () => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  await cleanupSessionStateForTest({ stateDir });
});

describe("system event session initialization and conversation binding owners", () => {
  it("initializes a restart-resume event before the channel binding adapter registers", async () => {
    const cfg = await seedSession();

    const result = await initSessionState({
      cfg,
      commandAuthorized: false,
      ctx: restartResumeEvent(),
    });

    expect(result).toMatchObject({
      sessionKey: SESSION_KEY,
      sessionId: "interrupted-session",
      isNewSession: false,
      resetTriggered: false,
    });
  });

  it("does not consult a registered channel binding adapter for a system event", async () => {
    const cfg = await seedSession();
    const resolveByConversationAsync = vi.fn(async () => null);
    registerSessionBindingAdapter({
      channel: CHANNEL,
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => null,
      inspectByConversationAsync: async () => null,
      resolveByConversationAsync,
    });

    await initSessionState({ cfg, commandAuthorized: false, ctx: restartResumeEvent() });

    expect(resolveByConversationAsync).not.toHaveBeenCalled();
  });

  it("still fails closed for a user turn while the channel binding adapter is unavailable", async () => {
    const cfg = await seedSession();

    const failure = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: routedTurn({
        Body: "hello",
        From: "user-1",
        SenderId: "user-1",
        CommandAuthorized: true,
      }),
    }).catch((error: unknown) => error);

    expect(isSessionBindingError(failure)).toBe(true);
    expect((failure as { code?: string }).code).toBe("BINDING_ADAPTER_UNAVAILABLE");
  });
});
