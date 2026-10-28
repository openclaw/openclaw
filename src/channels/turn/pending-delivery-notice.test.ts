import path from "node:path";
import { afterAll, assert, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { deliverPendingDeliveryNotice } from "./pending-delivery-notice.js";

const PENDING_DELIVERY_NOTICE =
  "I couldn’t confirm whether my previous reply reached this chat, so I won’t resend it automatically. Please ask for any missing remainder.";

const sendRecoveryNotice = vi.hoisted(() => vi.fn());
const findDeliveryIntentOwner = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/server-recovery-runtime-context.js", () => ({
  getGatewayRecoveryRuntime: () => ({ sendRecoveryNotice }),
}));
vi.mock("../../infra/outbound/delivery-queue-storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/outbound/delivery-queue-storage.js")>()),
  findDeliveryIntentOwner,
}));

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-pending-notice-");
let storePath: string;
const sessionKey = "agent:main:telegram:direct:chat-1";
const route = { channel: "telegram", accountId: "default" };
const context = { ...route, to: "chat-1", threadId: 42 };
const locator = () => ({ sessionKey, storePath });
const entry = () => loadSessionEntry(locator())!;
const deliver = () => deliverPendingDeliveryNotice(sessionKey, storePath, undefined);
const expectNotice = (state: string) =>
  expect(entry().pendingDeliveryNotice).toMatchObject({ intentId: "intent-1", state });
function pendingNotice() {
  const started = createDeferred();
  const result = createDeferred<{ suppressed: boolean }>();
  sendRecoveryNotice.mockImplementationOnce(() => {
    started.resolve();
    return result.promise;
  });
  return { started: started.promise, ...result };
}

beforeEach(async () => {
  vi.clearAllMocks();
  sendRecoveryNotice.mockReset().mockResolvedValue({ suppressed: false });
  findDeliveryIntentOwner.mockReturnValue(null);
  storePath = path.join(sessionDirs.make(), "sessions.json");
  await replaceSessionEntry(locator(), {
    sessionId: "session-1",
    status: "done",
    updatedAt: 1,
    delivery: { kind: "external", route, context, origin: {} },
    pendingDeliveryNotice: { createdAt: 1, context, intentId: "intent-1", state: "owed" },
  });
});

it("does not cross an account or thread route", async () => {
  const current = entry();
  assert(current.delivery?.kind === "external");
  await replaceSessionEntry(locator(), {
    ...current,
    delivery: { ...current.delivery, context: { ...context, accountId: "other" } },
  });
  await deliver();
  expect(sendRecoveryNotice).not.toHaveBeenCalled();
  expectNotice("owed");
});

it.each([
  ["failed", "unresolved"],
  ["completed", "acknowledged"],
  ["pending", "owed"],
])("preserves %s durable notice status after a send error", async (status, state) => {
  sendRecoveryNotice.mockRejectedValue(new Error("notice send failed"));
  findDeliveryIntentOwner.mockReturnValue({ status });
  await deliver();
  if (status === "completed") {
    expect(sendRecoveryNotice).toHaveBeenCalledWith({
      ...context,
      text: PENDING_DELIVERY_NOTICE,
      idempotencyKey: "main-session-restart-recovery:pending-final:intent-1",
      generation: {
        agentId: "main",
        storePath,
        sessionKey,
        sessionId: "session-1",
        lifecycleRevision: null,
      },
      provenance: {
        kind: "recovery-notice",
        noticeId: "main-session-restart-recovery:pending-final:intent-1",
      },
    });
  }
  expectNotice(state);
});
it.each([false, true])("acknowledges with suppressed-first=%s", async (suppressedFirst) => {
  const [first, second] = [pendingNotice(), pendingNotice()];
  const attempts = [deliver(), deliver()];
  await Promise.all([first.started, second.started]);
  first.resolve({ suppressed: suppressedFirst });
  await Promise.race(attempts);
  second.resolve({ suppressed: !suppressedFirst });
  await Promise.all(attempts);
  expectNotice("acknowledged");
});
it("leaves a replacement notice owed when an earlier send finishes", async () => {
  const sent = pendingNotice();
  const attempt = deliver();
  await sent.started;
  const current = entry();
  const replacement = { ...current.pendingDeliveryNotice!, intentId: "intent-2" };
  await replaceSessionEntry(locator(), { ...current, pendingDeliveryNotice: replacement });
  sent.resolve({ suppressed: false });
  await attempt;
  expect(entry().pendingDeliveryNotice).toEqual(replacement);
});

it("does not acknowledge a new revision with the same session and notice identity", async () => {
  const sent = pendingNotice();
  const attempt = deliver();
  await sent.started;
  await replaceSessionEntry(locator(), { ...entry(), lifecycleRevision: "replacement-revision" });
  sent.resolve({ suppressed: false });
  await attempt;
  expect(entry().lifecycleRevision).toBe("replacement-revision");
  expectNotice("owed");
});

it("keeps the supplied owner for a global session notice", async () => {
  const secondary = { agentId: "secondary", sessionKey: "global", storePath };
  await replaceSessionEntry(secondary, { ...entry(), sessionId: "secondary-global" });
  await deliverPendingDeliveryNotice(secondary.sessionKey, storePath, secondary.agentId);
  expect(sendRecoveryNotice).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      generation: { ...secondary, sessionId: "secondary-global", lifecycleRevision: null },
    }),
  );
  expect(loadSessionEntry(secondary)?.pendingDeliveryNotice?.state).toBe("acknowledged");
  expectNotice("owed");
});
