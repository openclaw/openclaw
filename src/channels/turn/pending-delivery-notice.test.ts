import path from "node:path";
import { afterAll, assert, beforeEach, expect, it, vi } from "vitest";
import { drainFormattedSystemEvents } from "../../auto-reply/reply/session-system-events.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../../infra/system-events.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { admitPendingDeliveryNotice } from "./pending-delivery-notice.js";

const sendNotice = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/server-lifecycle-runtime-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/server-lifecycle-runtime-context.js")>()),
  getGatewayLifecycleRuntime: () => ({ sendNotice }),
}));

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-pending-notice-");
let storePath: string;
const sessionKey = "agent:main:telegram:direct:chat-1";
const route = { channel: "telegram", accountId: "default" };
const context = { ...route, to: "chat-1", threadId: 42 };
const createdAt = Date.UTC(2026, 10, 4, 3, 8, 31);
const locator = () => ({ sessionKey, storePath });
const entry = () => loadSessionEntry(locator())!;
const admit = () => admitPendingDeliveryNotice(sessionKey, storePath);
const turnContext = (key = sessionKey, agentId?: string) =>
  peekSystemEventEntries(resolveSystemEventQueueKey(key, agentId)).map((event) => event.text);
const expectNotice = (state: string) =>
  expect(entry().pendingDeliveryNotice).toMatchObject({ intentId: "intent-1", state });

beforeEach(async () => {
  vi.clearAllMocks();
  resetSystemEventsForTest();
  storePath = path.join(sessionDirs.make(), "sessions.json");
  await replaceSessionEntry(locator(), {
    sessionId: "session-1",
    status: "done",
    updatedAt: 1,
    delivery: { kind: "external", route, context, origin: {} },
    pendingDeliveryNotice: { createdAt, context, intentId: "intent-1", state: "owed" },
  });
});

const consume = () =>
  drainFormattedSystemEvents({
    cfg: {},
    agentId: "main",
    sessionKey,
    storePath,
    isMainSession: false,
    isNewSession: false,
  });

it("tells the next turn instead of posting fixed text to the chat", async () => {
  await admit();
  expect(sendNotice).not.toHaveBeenCalled();
  expect(turnContext()).toEqual([
    expect.stringContaining(
      "Your reply from 2026-11-04T03:08:31.000Z may not have reached this chat",
    ),
  ]);
  // The in-memory offer alone settles nothing: a restart would lose it.
  expectNotice("owed");
  expect(await consume()).toContain("may not have reached this chat");
  expectNotice("acknowledged");
  await admit();
  expect(turnContext()).toEqual([]);
});

it("re-offers owed debt when the earlier offer was lost", async () => {
  await admit();
  resetSystemEventsForTest();
  await admit();
  expect(turnContext()).toHaveLength(1);
  expectNotice("owed");
});

it("keeps one offer across concurrent admissions", async () => {
  await Promise.all([admit(), admit()]);
  await admit();
  expect(turnContext()).toHaveLength(1);
});

it("does not cross an account or thread route", async () => {
  const current = entry();
  assert(current.delivery?.kind === "external");
  await replaceSessionEntry(locator(), {
    ...current,
    delivery: { ...current.delivery, context: { ...context, accountId: "other" } },
  });
  await admit();
  expect(turnContext()).toEqual([]);
  expectNotice("owed");
});

it("keeps the supplied owner for a global session notice", async () => {
  const secondary = { agentId: "secondary", sessionKey: "global", storePath };
  await replaceSessionEntry(secondary, { ...entry(), sessionId: "secondary-global" });
  await admitPendingDeliveryNotice(secondary.sessionKey, storePath, secondary.agentId);
  expect(turnContext("global", "secondary")).toHaveLength(1);
  expect(turnContext()).toEqual([]);
  expectNotice("owed");
});

it.each([
  ["acknowledged", 0],
  ["unresolved", 1],
] as const)("offers %s debt %i time(s)", async (state, events) => {
  await replaceSessionEntry(locator(), {
    ...entry(),
    pendingDeliveryNotice: { ...entry().pendingDeliveryNotice!, state },
  });
  await admit();
  expect(turnContext()).toHaveLength(events);
  await consume();
  expectNotice("acknowledged");
});
