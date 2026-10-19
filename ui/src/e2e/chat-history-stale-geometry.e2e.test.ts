import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import {
  CHAT_SNAPSHOT_DB_NAME,
  CHAT_SNAPSHOT_STORE_NAME,
} from "../pages/chat/session-snapshot-database.ts";
import { resolveChatSnapshotKey } from "../pages/chat/session-snapshot-key.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  newChatPage,
  waitForChatScrollIdle,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionId = "durable-geometry-session";
const sessionInfo = {
  key: "agent:main:main",
  kind: "direct",
  sessionId,
} satisfies GatewaySessionRow;

function historyMessage(seq: number, text: string) {
  return {
    __openclaw: { id: `durable-geometry-${seq}`, seq },
    content: [{ type: seq % 2 === 0 ? "output_text" : "input_text", text }],
    role: seq % 2 === 0 ? "assistant" : "user",
    timestamp: 1_800_000_000_000 + seq,
  };
}

suite.define(() => {
  it("discards stale transcript geometry before restored history bootstrap", async () => {
    const page = await newChatPage(suite, {
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 600, width: 520 },
    });
    const pane = page.locator(".chat-pane-cache__pane--active");
    const recentMessages = Array.from({ length: 16 }, (_, index) =>
      historyMessage(
        index + 3,
        `Restored message ${index + 3}: ${"prior narrow presentation text ".repeat(18)}`,
      ),
    );
    const compactRecentMessages = recentMessages.map((_, index) =>
      historyMessage(index + 3, `Restored message ${index + 3}`),
    );
    const olderMessages = [historyMessage(1, "Older 1"), historyMessage(2, "Older 2")];
    const totalMessages = compactRecentMessages.length + olderMessages.length;
    const startup = (messages: unknown[], hasMore: boolean) => ({
      messages,
      hasMore,
      sessionInfo,
      sessionId,
      ...(hasMore ? { nextOffset: messages.length } : {}),
      totalMessages: hasMore ? totalMessages : messages.length,
    });
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.startup": startup(recentMessages, false),
      },
      sessionKey: "agent:main:main",
      sessions: [sessionInfo],
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByText("Restored message 18:", { exact: false }).waitFor({ timeout: 10_000 });
    const rowKeys = await page
      .locator(".chat-virtual-row")
      .evaluateAll((rows) => rows.flatMap((row) => row.getAttribute("data-virtual-row-key") || []));
    expect(rowKeys.length).toBeGreaterThan(0);
    const snapshotHost = await pane.evaluate((element) => {
      const { state } = element as HTMLElement & { state: ChatPageHost };
      if (!state.client?.recoveryScopeReady || !state.client.recoveryScope) {
        throw new Error("Expected the authenticated snapshot owner");
      }
      return {
        settings: { gatewayUrl: state.settings.gatewayUrl },
        client: { recoveryScopeReady: true, recoveryScope: state.client.recoveryScope },
        agentsList: state.agentsList,
        hello: state.hello,
        assistantAgentId: state.assistantAgentId,
      };
    });
    const snapshotKey = resolveChatSnapshotKey(snapshotHost, { sessionKey: "agent:main:main" });
    await expect
      .poll(
        () =>
          page.evaluate(
            async ({ databaseName, keys, storeName, key, id }) => {
              const read = <T>(request: IDBRequest<T>) =>
                new Promise<T>((resolve, reject) => {
                  request.addEventListener("success", () => resolve(request.result));
                  request.addEventListener("error", () =>
                    reject(request.error ?? new Error("Snapshot request failed")),
                  );
                });
              const database = await read(indexedDB.open(databaseName));
              const transaction = database.transaction(storeName, "readwrite");
              const store = transaction.objectStore(storeName);
              const record = await read<unknown>(store.get(key));
              if (!record || typeof record !== "object") {
                database.close();
                return false;
              }
              if (
                !("sessionKey" in record) ||
                record.sessionKey !== key ||
                !("sessionId" in record) ||
                record.sessionId !== id
              ) {
                database.close();
                throw new Error("Snapshot record does not belong to the expected conversation");
              }
              (record as Record<string, unknown>).rowHeights = new Map(
                keys.map((rowKey) => [rowKey, 1_000]),
              );
              store.put(record);
              await new Promise<void>((resolve, reject) => {
                transaction.addEventListener("complete", () => resolve());
                transaction.addEventListener("error", () =>
                  reject(new Error(transaction.error?.message ?? "snapshot write failed")),
                );
                transaction.addEventListener("abort", () =>
                  reject(new Error(transaction.error?.message ?? "snapshot write aborted")),
                );
              });
              database.close();
              return true;
            },
            {
              databaseName: CHAT_SNAPSHOT_DB_NAME,
              keys: rowKeys,
              storeName: CHAT_SNAPSHOT_STORE_NAME,
              key: snapshotKey,
              id: sessionId,
            },
          ),
        { timeout: 10_000 },
      )
      .toBe(true);

    await gateway.setMethodResponse("chat.startup", startup(compactRecentMessages, true));
    await gateway.setMethodResponse("chat.history", {
      cases: [
        {
          match: { offset: compactRecentMessages.length, sessionKey: "agent:main:main" },
          response: { hasMore: false, messages: olderMessages, sessionId, totalMessages },
        },
      ],
    });
    const historyRequestsBeforeReload = (await gateway.getRequests("chat.history")).length;
    await page.setViewportSize({ height: 2_400, width: 1_400 });
    await page.reload();

    const requests = await waitForRequests(
      gateway,
      "chat.history",
      historyRequestsBeforeReload + 1,
    );
    expect(requests.at(-1)?.params).toMatchObject({
      offset: compactRecentMessages.length,
      sessionKey: "agent:main:main",
    });
    await expect
      .poll(() =>
        pane.evaluate((element) => {
          const host = element as HTMLElement & { state?: { chatMessages?: unknown[] } };
          return host.state?.chatMessages?.length ?? 0;
        }),
      )
      .toBe(totalMessages);
    await waitForChatScrollIdle(page);
    await page.getByText("Older 1", { exact: true }).waitFor();
    await page.getByText("Restored message 3", { exact: true }).waitFor();
    await expect
      .poll(() =>
        pane
          .locator(".chat-thread")
          .evaluate((element) => element.scrollHeight - element.clientHeight),
      )
      .toBeLessThanOrEqual(1);
  }, 120_000);
});
