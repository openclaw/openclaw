import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { escapeHtml } from "../../../src/shared/html-escape.js";
import { waitForControlUiProofSurface } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { captureUiProofEnabled, waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI warm reload",
  trackBrowserContexts: true,
});
// A literal conversation can restore before hello; the shorthand main route needs live defaults.
const sessionKey = "agent:main:thread:warm-reload";
const transcriptText = "This conversation is ready before the Gateway reconnects.";
const reloadProfiles = [
  "matching",
  "different",
  "device-token",
  "trusted-proxy",
  "legacy-rail",
  "large",
  "short-tail",
  "imported",
  "offline",
];

async function expectOwnMessageAlignment(page: Page): Promise<void> {
  const own = page.locator(".chat-group.user", { hasText: "Morgan's saved message." });
  await expect
    .poll(() =>
      own.evaluate((row) => ({
        peer: row.classList.contains("chat-group--peer"),
        alignment: getComputedStyle(row).justifyContent,
      })),
    )
    .toEqual({ peer: false, alignment: "end" });
}

type SidebarRecord = { model: { entries: string[] } };

// Passed whole to Playwright: request and transaction helpers stay in the browser realm.
async function snapshotStorage(operation: "check" | "legacy" | SidebarRecord[]) {
  const name = "openclaw-chat-snapshots";
  const result = <T>(request: IDBRequest<T>, blockedMessage?: string) =>
    new Promise<T>((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () =>
        reject(request.error ?? new Error("Snapshot request failed")),
      );
      if (blockedMessage) {
        request.addEventListener("blocked", () => reject(new Error(blockedMessage)));
      }
    });
  const bootRecord = Object.keys(localStorage).some((key) =>
    key.startsWith("openclaw.control.bootRecord.v1:"),
  );
  if (operation === "check" && !(await indexedDB.databases()).some((db) => db.name === name)) {
    return { records: [], state: { bootRecord, roster: false, transcript: false } };
  }
  const restoring = Array.isArray(operation);
  if (restoring) {
    await result(indexedDB.deleteDatabase(name), "Old snapshot database remained open");
  }
  const open = restoring ? indexedDB.open(name, 6) : indexedDB.open(name);
  if (restoring) {
    open.addEventListener("upgradeneeded", () => {
      for (const store of ["snapshots", "snapshotMetadata", "sidebarSnapshots"]) {
        open.result.createObjectStore(store, { keyPath: "sessionKey" });
      }
    });
  }
  const database = await result(open);
  try {
    const transaction = database.transaction(
      operation === "check" ? ["sidebarSnapshots", "snapshots"] : "sidebarSnapshots",
      restoring ? "readwrite" : "readonly",
    );
    const complete = new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () =>
        reject(transaction.error ?? new Error("Snapshot transaction failed")),
      );
    });
    const store = transaction.objectStore("sidebarSnapshots");
    if (restoring) {
      for (const record of operation) {
        store.put(record);
      }
      await complete;
      return { records: operation };
    }
    const [records, snapshots] = await Promise.all([
      result<SidebarRecord[]>(store.getAll()),
      operation === "check"
        ? result<unknown[]>(transaction.objectStore("snapshots").getAll())
        : Promise.resolve([]),
      complete,
    ]);
    if (operation === "legacy") {
      for (const record of records) {
        record.model.entries = ["route:usage", "route:cron"];
      }
      return { records };
    }
    const field = (value: unknown, ...keys: string[]): unknown =>
      keys.reduce<unknown>(
        (current, key) =>
          typeof current === "object" && current !== null && key in current
            ? Reflect.get(current, key)
            : undefined,
        value,
      );
    return {
      records,
      state: {
        bootRecord,
        roster: records.some((record) => {
          const sessions = field(record, "model", "roster", "result", "sessions");
          return (
            Array.isArray(sessions) &&
            sessions.some((row) => field(row, "key") === "agent:main:cached-only")
          );
        }),
        transcript: snapshots.some(
          (snapshot) =>
            field(snapshot, "snapshot", "deltaCursor") === "warm-reload-cursor" &&
            field(snapshot, "snapshot", "composer", "name") === "Remembered model",
        ),
      },
    };
  } finally {
    database.close();
  }
}

async function waitForPersistedWarmState(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        (
          await page.evaluate<
            Awaited<ReturnType<typeof snapshotStorage>>,
            Parameters<typeof snapshotStorage>[0]
          >(snapshotStorage, "check")
        ).state,
    )
    .toEqual({ bootRecord: true, roster: true, transcript: true });
}

suite.define(() => {
  it.each(reloadProfiles)(
    "reconciles the cached shell, roster, and transcript with a %s profile",
    (profile) =>
      suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const capture = async (name: string) => {
          await waitForControlUiProofSurface(page.locator("body"), []);
          if (captureUiProofEnabled) {
            await page.screenshot({ path: path.join(suite.artifactDir, name) });
          }
        };
        const timestamp = Date.now();
        const imported = profile === "imported";
        const shortTail = profile === "short-tail";
        const olderMessages =
          profile === "large" || shortTail || imported
            ? Array.from({ length: imported ? 119 : 1_099 }, (_, index) => ({
                role: shortTail && index >= 1_020 ? "toolResult" : index % 2 ? "assistant" : "user",
                content: `Older history ${index + 1}`,
                ...(shortTail && index >= 1_020
                  ? { toolCallId: `older-tool-${index}`, toolName: "read" }
                  : {}),
                __openclaw: {
                  id: `older-${index + 1}`,
                  ...(imported ? { importedFrom: "claude-cli" } : { seq: index + 1 }),
                },
              }))
            : [];
        const rememberedMessage = {
          role: "assistant",
          content: transcriptText,
          openclawResponsesInputReplay: { items: ["retained for reconciliation identity"] },
          __openclaw: {
            id: "cached-message",
            ...(imported ? { importedFrom: "claude-cli" } : { seq: olderMessages.length + 1 }),
          },
        };
        const sessionRow = (
          id: string,
          label: string,
          updatedAt = timestamp,
          owner = "profile-a",
        ) => ({
          key: `agent:main:${id}`,
          sessionId: `${id}-session`,
          kind: "direct" as const,
          label,
          owner: { actor: { type: "human" as const, id: owner } },
          updatedAt,
        });
        const currentRow = {
          ...sessionRow("warm-reload", "Warm reload conversation"),
          key: sessionKey,
          model: "warm-model",
          modelProvider: "openai",
        };
        const gateway = await installMockGateway(page, {
          subscriptionInitialHistory: false,
          sessionKey,
          assistantName: "Observatory",
          // The typed hold applies again after reload and releases the normal hello payload.
          heldMethods: ["connect"],
          authMethod: profile === "trusted-proxy" || profile === "device-token" ? profile : "token",
          authMode: profile === "trusted-proxy" ? "trusted-proxy" : "token",
          presenceUsers: [
            {
              id: "profile-a",
              self: true,
              ...(profile === "matching"
                ? { identity: { type: "profile" as const, id: "profile-a" } }
                : {}),
            },
          ],
          sessions: [currentRow, sessionRow("cached-only", "Cached only session", timestamp - 1)],
          methodResponses: {
            "sessions.list": {
              cases: [
                {
                  match: { includeOwnerSessionCounts: true },
                  response: {
                    ts: timestamp,
                    path: "",
                    count: 0,
                    sessions: [],
                    defaults: { model: null, modelProvider: null, contextTokens: null },
                    ownerSessionCounts: [],
                  },
                },
              ],
            },
            "chat.startup": {
              sessionId: "warm-reload-session",
              sessionInfo: currentRow,
              messages: [
                ...olderMessages,
                rememberedMessage,
                ...(profile === "matching"
                  ? [
                      {
                        role: "user",
                        content: "Morgan's saved message.",
                        __openclaw: {
                          id: "own-message",
                          seq: 2,
                          senderId: "profile-a",
                          senderIdentity: { type: "profile", id: "profile-a" },
                          senderName: "Morgan",
                        },
                      },
                    ]
                  : []),
              ],
              deltaCursor: "warm-reload-cursor",
              hasMore: false,
              ...(olderMessages.length ? { totalMessages: olderMessages.length + 1 } : {}),
              metadata: {
                models: [{ id: "warm-model", provider: "openai", name: "Remembered model" }],
              },
            },
            "models.list": {
              models: [{ id: "warm-model", provider: "openai", name: "Remembered model" }],
            },
          },
        });
        // Observe the mock's real wire response, without reading renderer-owned runtime fields.
        await page.addInitScript(() => {
          window.WebSocket = new Proxy(window.WebSocket, {
            construct(Target, args) {
              const socket = Reflect.construct(Target, args) as WebSocket;
              socket.addEventListener("message", (event: MessageEvent) => {
                if (typeof event.data !== "string") {
                  return;
                }
                const frame = JSON.parse(event.data) as {
                  type?: string;
                  payload?: { type?: string };
                };
                if (frame.type === "res" && frame.payload?.type === "hello-ok") {
                  sessionStorage.setItem(
                    "openclaw.warm-boot-proof.hello",
                    JSON.stringify(frame.payload),
                  );
                }
              });
              return socket;
            },
          });
        });
        await page.goto(
          controlUiSessionUrl(suite.server.baseUrl, sessionKey) +
            (profile === "device-token" || profile === "trusted-proxy" ? "" : "#token=test-token"),
        );
        await gateway.waitForRequest("connect");
        await page.locator(".connect-splash").waitFor();
        await capture("cold-connecting.png");
        await gateway.resolveDeferred("connect");
        const sidebar = page.locator("openclaw-app-sidebar");
        const transcript = page.locator(".chat-thread-inner");
        await sidebar.getByText("Cached only session", { exact: true }).waitFor();
        await transcript.getByText(transcriptText, { exact: true }).waitFor();
        if (profile === "matching") {
          await expectOwnMessageAlignment(page);
          await page
            .locator(".agent-chat__composer-combobox textarea")
            .fill("A draft before reconnect");
        }
        await waitForPersistedWarmState(page);
        const hello: unknown = await page.evaluate(() =>
          JSON.parse(sessionStorage.getItem("openclaw.warm-boot-proof.hello") ?? "null"),
        );
        if (!isRecord(hello) || !isRecord(hello.auth) || !isRecord(hello.snapshot)) {
          throw new Error("Expected the mock Gateway's first hello response");
        }
        expect(hello.snapshot.presence).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ user: expect.objectContaining({ id: "profile-a" }) }),
          ]),
        );

        if (profile === "legacy-rail") {
          const { records } = await page.evaluate<
            Awaited<ReturnType<typeof snapshotStorage>>,
            Parameters<typeof snapshotStorage>[0]
          >(snapshotStorage, "legacy");
          expect(records.length).toBeGreaterThan(0);
          const url = page.url();
          await page.goto("about:blank");
          const modules = await holdModuleResponse(page, /\/assets\/.*\.js(?:\?|$)/u);
          await page.goto(url, { waitUntil: "commit" });
          await modules.request;
          await page.evaluate(snapshotStorage, records);
          modules.release();
          await gateway.waitForRequest("connect");
          await sidebar.locator("aside.sidebar").waitFor();
          expect(await sidebar.locator(".sidebar-rail__pin").count()).toBe(0);
          expect(await sidebar.locator("aside.sidebar").getAttribute("data-snapshot-state")).toBe(
            "live",
          );
          expect(await gateway.getRequests("sessions.list")).toEqual([]);
          await gateway.resolveDeferred("connect");
          await transcript.getByText(transcriptText, { exact: true }).waitFor();
          return;
        }

        let bootstrapRequests = 0;
        if (profile === "trusted-proxy") {
          const documentPath = new URL(page.url()).pathname;
          await page.route(
            (url) => url.pathname === documentPath,
            async (route) => {
              const response = await route.fetch();
              const config = {
                basePath: "",
                assistantAgentId: "main",
                assistantName: "Observatory",
                assistantAvatar: "🔭",
                terminalEnabled: false,
                pluginAssetsRequireAuth: true,
                pluginFrameGrants: [],
              };
              await route.fulfill({
                response,
                body: (await response.text()).replace(
                  "<html",
                  `<html ${CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE}="${escapeHtml(JSON.stringify(config))}"`,
                ),
              });
            },
          );
          page.on("request", (request) => {
            if (new URL(request.url()).pathname.endsWith("/control-ui-config.json")) {
              bootstrapRequests++;
            }
          });
        }
        if (profile === "offline") {
          await gateway.setOnline(false);
          await page.reload();
          await transcript.getByText(transcriptText, { exact: true }).waitFor();
          await sidebar.getByText("Cached only session", { exact: true }).waitFor();
          await page.locator(".chat-pane__connection-state").waitFor({ state: "visible" });
          expect(await page.locator(".chat-pane-cache__pane--active .skeleton").count()).toBe(0);
          expect(await gateway.getRequests("connect")).toEqual([]);
          expect(await gateway.getRequests("chat.send")).toEqual([]);
          await capture("warm-offline-before-socket.png");
          return;
        }
        await page.reload();
        const connect = await gateway.waitForRequest("connect");
        await sidebar.locator(".sidebar-footer-bar__home").waitFor();
        await sidebar.getByText("Cached only session", { exact: true }).waitFor();
        await transcript.getByText(transcriptText, { exact: true }).waitFor();
        expect(await gateway.getRequests("sessions.list")).toEqual([]);
        expect(await gateway.getRequests("chat.startup")).toEqual([]);
        if (profile === "trusted-proxy") {
          await capture("bootstrap-before-hello.png");
          expect(bootstrapRequests).toBe(0);
          await sidebar.getByRole("button", { name: /^Observatory ·/u }).waitFor();
        }
        if (profile === "matching") {
          await expectOwnMessageAlignment(page);
          const composer = page.locator(".agent-chat__composer-combobox textarea");
          await expect.poll(() => composer.inputValue()).toBe("A draft before reconnect");
          await expect.poll(() => composer.isEnabled()).toBe(true);
          await expect
            .poll(() => page.locator("[data-chat-model-select]").textContent())
            .toContain("Remembered model");
          await page.locator("[data-composer-catalog-state=stale]").waitFor({ state: "visible" });
          await composer.fill("Typing while the Gateway is still connecting");
          expect(await gateway.getRequests("chat.send")).toEqual([]);
        }
        await capture(`warm-${profile}-before-hello.png`);

        await gateway.setSessionsListResponse({
          ownerSessionCounts: [],
          ts: timestamp + 1,
          path: "",
          count: 2,
          defaults: { model: null, modelProvider: null, contextTokens: null },
          sessions: [
            { ...currentRow, label: "Live reload conversation", updatedAt: timestamp + 1 },
            sessionRow(
              "live-only",
              "Live only session",
              timestamp,
              profile === "different" ? "profile-b" : "profile-a",
            ),
          ],
        });
        await gateway.setMethodResponse("chat.startup", {
          kind: "delta",
          messages: [],
          deltaCursor: "warm-reload-next-cursor",
          sessionInfo: currentRow,
          metadata: { models: [] },
        });
        if (profile === "different") {
          const client = isRecord(connect.params) ? connect.params.client : null;
          if (!isRecord(client) || typeof client.instanceId !== "string") {
            throw new Error("Expected a client instance ID in the connect request");
          }
          await gateway.deferNext("chat.startup");
          await gateway.resolveDeferred("connect", {
            ...hello,
            // Presence attribution alone does not change the authenticated storage owner.
            auth: { ...hello.auth, recoveryScope: "e2e-profile-b-recovery-scope" },
            snapshot: {
              ...hello.snapshot,
              presence: [
                { instanceId: client.instanceId, reason: "connect", user: { id: "profile-b" } },
              ],
            },
          });
        } else {
          await gateway.resolveDeferred("connect");
        }
        const startup = await gateway.waitForRequest("chat.startup");
        if (profile === "different") {
          expect(startup.params).toMatchObject({ sessionKey });
          expect(startup.params).not.toHaveProperty("cursor");
          await expect
            .poll(() => transcript.getByText(transcriptText, { exact: true }).count())
            .toBe(0);
          await gateway.resolveDeferred("chat.startup", {
            sessionId: "profile-b-session",
            sessionInfo: { ...currentRow, sessionId: "profile-b-session" },
            messages: [{ role: "assistant", content: "This is profile B's conversation." }],
            hasMore: false,
            deltaCursor: "profile-b-cursor",
            metadata: { models: [] },
          });
        } else {
          expect(startup.params).toMatchObject({ sessionKey, cursor: "warm-reload-cursor" });
        }
        await gateway.waitForRequest("sessions.list");
        await sidebar.locator(".sidebar-footer-bar__home").waitFor();
        await sidebar.getByText("Live only session", { exact: true }).waitFor();
        expect(await sidebar.getByText("Cached only session", { exact: true }).count()).toBe(0);
        const finalText =
          profile === "different" ? "This is profile B's conversation." : transcriptText;
        await transcript.getByText(finalText, { exact: true }).waitFor();
        await capture(`warm-${profile}-after-hello.png`);
        if (profile === "large" || shortTail || imported) {
          await waitForChatScrollIdle(page);
          expect(await gateway.getRequests("chat.history")).toEqual([]);
          const messages = [
            ...olderMessages,
            {
              ...rememberedMessage,
              __openclaw: {
                ...rememberedMessage["__openclaw"],
                senderProfileAvatarUrl: "/api/users/synthetic/avatar?v=2",
              },
            },
          ];
          const pageSize = imported ? 50 : 1_000;
          const firstPage = messages.slice(-pageSize);
          await gateway.setMethodResponse("chat.history", {
            // Every long-history fixture spans two pages: 1,100/1,000 or 120/50.
            cases: [firstPage, messages.slice(0, -pageSize)].map((pageMessages, index) => ({
              match: { offset: index * pageSize },
              response: {
                messages: pageMessages,
                sessionId: currentRow.sessionId,
                totalMessages: messages.length,
                hasMore: index === 0,
                ...(index === 0 ? { nextOffset: pageSize } : {}),
              },
            })),
          });
          const messageCount = () =>
            page
              .locator(".chat-pane-cache__pane--active")
              .evaluate((element) => Reflect.get(element, "state").chatMessages.length);
          const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
          await thread.hover();
          await page.mouse.wheel(0, -100_000);
          const history = await gateway.waitForRequest("chat.history", { match: { offset: 0 } });
          expect(history.params).toMatchObject({ offset: 0 });
          await expect.poll(messageCount).toBe(firstPage.length);
          await page
            .getByText(
              `Older history ${Math.max(messages.length - pageSize + 1, olderMessages.length - 79)}`,
              { exact: true },
            )
            .waitFor({ state: "attached" });
          await waitForChatScrollIdle(page);
          await page.mouse.wheel(0, -1_000_000);
          const older = await gateway.waitForRequest("chat.history", {
            match: { offset: pageSize },
          });
          expect(older.params).toMatchObject({ offset: pageSize });
          await expect.poll(messageCount).toBe(messages.length);
          await page
            .getByText(`Older history ${messages.length - pageSize}`, { exact: true })
            .waitFor({ state: "attached" });
          await page
            .getByText(`Older history ${messages.length - pageSize + 1}`, { exact: true })
            .waitFor();
        }
        if (profile === "matching") {
          await expectOwnMessageAlignment(page);
          const connectCount = (await gateway.getRequests("connect")).length;
          const startupCount = (await gateway.getRequests("chat.startup")).length;
          await gateway.deferNext("connect");
          await gateway.closeLatest(1001, "Own-message alignment reconnect");
          await gateway.waitForRequest("connect", { after: connectCount });
          await expectOwnMessageAlignment(page);
          await gateway.resolveDeferred("connect");
          await gateway.waitForRequest("chat.startup", { after: startupCount });
          await expectOwnMessageAlignment(page);
        }
      }),
  );
});
