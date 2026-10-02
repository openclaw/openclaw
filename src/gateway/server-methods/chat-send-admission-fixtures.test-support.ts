import { vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { runExclusiveSessionStoreWrite } from "../../config/sessions/store-writer.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import { setClientProfile, setNativeIosClient } from "./chat-send-pending-inputs.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export function bindChatProfile(client: GatewayClient, email: string, native = false) {
  const profile = ensureProfileForEmail(email);
  const successor = ensureProfileForEmail(`successor-${email}`);
  setClientProfile(client, profile);
  if (native) {
    setNativeIosClient(client);
  }
  return { profile, successor, merge: () => linkEmail(email, successor.id) };
}

export function holdSessionWriter(storePath: string) {
  const entered = createDeferred();
  const release = createDeferred();
  const finished = runExclusiveSessionStoreWrite(storePath, async () => {
    entered.resolve();
    await release.promise;
  });
  return { entered: entered.promise, release: release.resolve, finished };
}

export function observeChatReservation(context: GatewayRequestContext, runId: string) {
  const key = pendingChatSendDedupeKey(runId);
  const reserved = createDeferred();
  const set = context.dedupe.set.bind(context.dedupe);
  const spy = vi.spyOn(context.dedupe, "set").mockImplementation((pendingKey, entry) => {
    const result = set(pendingKey, entry);
    if (pendingKey === key) {
      reserved.resolve();
    }
    return result;
  });
  return {
    key,
    wait(request: Promise<unknown>) {
      return awaitGateBeforeSettlement(
        reserved.promise,
        request,
        "chat.send settled before its pending reservation",
      );
    },
    [Symbol.dispose]: () => spy.mockRestore(),
  };
}
