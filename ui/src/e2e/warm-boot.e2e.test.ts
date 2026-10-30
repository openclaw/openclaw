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
  it("rebuilds stable-format history without losing independent draft or queued input on reload", () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const key = "agent:main:thread:stable-reload";
      const physicalSession = "stable-reload-session";
      const draftText = "Synthetic stable unsent draft";
      const queueText = "Synthetic stable held input";
      const attachmentText = "Exact synthetic stable attachment bytes.";
      const messages = Array.from({ length: 120 }, (_, index) => ({
        role: index % 2 ? "assistant" : "user",
        content: `Stable history ${index + 1}`,
        __openclaw: { id: `stable-${index + 1}`, seq: index + 1 },
      }));
      const tail = messages.slice(-80);
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        subscriptionInitialHistory: false,
        heldMethods: ["connect"],
        sessions: [{ key, sessionId: physicalSession, kind: "direct", updatedAt: 1 }],
        methodResponses: {
          "chat.startup": {
            messages: tail,
            sessionId: physicalSession,
            hasMore: true,
            nextOffset: 80,
            totalMessages: messages.length,
            olderCursor: "stable-before-tail",
            deltaCursor: "stable-current-delta",
            metadata: { models: [] },
          },
          "chat.history": {
            cases: [
              {
                match: { cursor: "stable-before-tail" },
                response: { messages: messages.slice(0, 40), sessionId: physicalSession },
              },
            ],
          },
        },
      });
      await page.route("**/stable-data-seed", (route) =>
        route.fulfill({ contentType: "text/html", body: "Synthetic stable persisted data" }),
      );
      await page.goto(`${suite.server.baseUrl}stable-data-seed`);
      // Literal v2026.10.8 storage shapes: snapshot schema 4/projection 1 and
      // the independent schema-2 draft owner plus v4 queue metadata.
      const seeded = await page.evaluate(
        async (stored) => {
          const request = <T>(value: IDBRequest<T>) =>
            new Promise<T>((resolve, reject) => {
              value.addEventListener("success", () => resolve(value.result));
              value.addEventListener("error", () =>
                reject(value.error ?? new Error("Stable storage request failed")),
              );
            });
          const complete = (value: IDBTransaction) =>
            new Promise<void>((resolve, reject) => {
              value.oncomplete = () => resolve();
              const failed = () =>
                reject(value.error ?? new Error("Stable input transaction failed"));
              value.addEventListener("abort", failed);
              value.addEventListener("error", failed);
            });
          const gatewayOwner = `ws://${location.host}`;
          const recoveryScope = "e2e-recovery-scope";
          const cacheKey = `scope:${JSON.stringify([gatewayOwner, recoveryScope])}\u0000${stored.key}`;
          const envelope = {
            projectionVersion: 1,
            savedAt: Date.now(),
            sessionId: stored.physicalSession,
            sessionKey: cacheKey,
          };
          const snapshot = {
            messages: stored.tail,
            sessionId: stored.physicalSession,
            pagination: { hasMore: true, nextOffset: 80, totalMessages: 120 },
            deltaCursor: "stable-retired-delta",
          };
          const oldCache = indexedDB.open("openclaw-chat-snapshots", 4);
          oldCache.onupgradeneeded = () => {
            for (const name of ["snapshots", "snapshotMetadata"]) {
              oldCache.result.createObjectStore(name, { keyPath: "sessionKey" });
            }
          };
          const cache = await request(oldCache);
          const cached = cache.transaction(["snapshots", "snapshotMetadata"], "readwrite");
          const cacheDone = complete(cached);
          cached.objectStore("snapshots").put({ ...envelope, snapshot });
          cached.objectStore("snapshotMetadata").put({
            savedAt: envelope.savedAt,
            sessionKey: cacheKey,
            weight: JSON.stringify(snapshot).length + JSON.stringify(envelope).length,
          });
          await cacheDone;
          cache.close();
          const scopeKey = `chat:v3:${stored.key}\u0000agent:main`;
          const draftKey = JSON.stringify([gatewayOwner, recoveryScope, scopeKey]);
          const oldInputs = indexedDB.open("openclaw-control-ui", 2);
          oldInputs.onupgradeneeded = () => {
            oldInputs.result
              .createObjectStore("composerDrafts", { keyPath: "key" })
              .createIndex("ownerKey", "ownerKey", { unique: false });
            oldInputs.result.createObjectStore("outboxPayloads", { keyPath: "key" });
          };
          const inputs = await request(oldInputs);
          const writing = inputs.transaction("composerDrafts", "readwrite");
          const inputDone = complete(writing);
          writing.objectStore("composerDrafts").put({
            key: draftKey,
            ownerKey: JSON.stringify([gatewayOwner, recoveryScope]),
            gatewayOwner,
            recoveryScope,
            scopeKey,
            updatedAt: Date.now(),
            writeId: "stable-draft-write",
            text: stored.draftText,
            revision: 1,
            attachments: [
              {
                mimeType: "text/plain",
                fileName: "stable-draft.txt",
                blob: new Blob([stored.attachmentText], { type: "text/plain" }),
              },
            ],
          });
          await inputDone;
          inputs.close();
          const queueKey = `openclaw.control.chatComposer.v4:${encodeURIComponent(gatewayOwner)}:account:${encodeURIComponent(recoveryScope)}`;
          sessionStorage.setItem(
            queueKey,
            JSON.stringify({
              version: 4,
              gatewayOwner,
              recovery: {},
              sessions: {
                [`${stored.key}\u0000agent:main`]: {
                  updatedAt: Date.now(),
                  queue: [
                    {
                      id: "stable-held-input",
                      text: stored.queueText,
                      createdAt: Date.now(),
                      sessionKey: stored.key,
                      agentId: "main",
                      storageScope: JSON.stringify([gatewayOwner, recoveryScope]),
                      sendState: "held",
                      sendRunId: "stable-held-run",
                      sendAttempts: 0,
                    },
                  ],
                },
              },
            }),
          );
          return { cacheKey, draftKey, queueKey };
        },
        { key, physicalSession, tail, draftText, queueText, attachmentText },
      );
      const pane = page.locator(".chat-pane-cache__pane--active");
      const composer = pane.locator(".agent-chat__composer-combobox textarea");
      const retainedInputs = async () => {
        await expect.poll(() => composer.inputValue()).toBe(draftText);
        await expect.poll(() => pane.locator(".chat-attachment-thumb").count()).toBe(1);
        await expect
          .poll(() =>
            page.evaluate((queueKey) => {
              const value = JSON.parse(sessionStorage.getItem(queueKey)!);
              return Object.values(value.sessions).flatMap(
                (session) => (session as { queue?: unknown[] }).queue ?? [],
              );
            }, seeded.queueKey),
          )
          .toMatchObject([
            {
              id: "stable-held-input",
              text: queueText,
              sendRunId: "stable-held-run",
              sendAttempts: 0,
            },
          ]);
        await expect
          .poll(() => pane.locator(".chat-queue__item").filter({ hasText: queueText }).count())
          .toBe(1);
        expect(
          await page.evaluate(async (draftKey) => {
            const database = await new Promise<IDBDatabase>((resolve, reject) => {
              const open = indexedDB.open("openclaw-control-ui");
              open.addEventListener("success", () => resolve(open.result));
              open.addEventListener("error", () =>
                reject(open.error ?? new Error("Stable storage request failed")),
              );
            });
            try {
              const value = await new Promise<{ attachments: Array<{ blob: Blob }> }>(
                (resolve, reject) => {
                  const read = database
                    .transaction("composerDrafts")
                    .objectStore("composerDrafts")
                    .get(draftKey);
                  read.addEventListener("success", () => resolve(read.result));
                  read.addEventListener("error", () =>
                    reject(read.error ?? new Error("Stable storage request failed")),
                  );
                },
              );
              return Promise.all(value.attachments.map(({ blob }) => blob.text()));
            } finally {
              database.close();
            }
          }, seeded.draftKey),
        ).toEqual([attachmentText]);
        expect(await gateway.getRequests("chat.send")).toEqual([]);
      };
      const url = controlUiSessionUrl(suite.server.baseUrl, key) + "#token=test-token";
      await page.goto(url);
      await gateway.waitForRequest("connect");
      await gateway.resolveDeferred("connect");
      const startup = await gateway.waitForRequest("chat.startup");
      expect(startup.params).not.toHaveProperty("cursor");
      await pane.getByText("Stable history 120", { exact: true }).waitFor();
      await retainedInputs();
      await expect
        .poll(() =>
          page.evaluate(async (cacheKey) => {
            const database = await new Promise<IDBDatabase>((resolve, reject) => {
              const open = indexedDB.open("openclaw-chat-snapshots");
              open.addEventListener("success", () => resolve(open.result));
              open.addEventListener("error", () =>
                reject(open.error ?? new Error("Stable storage request failed")),
              );
            });
            try {
              return await new Promise<number | undefined>((resolve, reject) => {
                const read = database
                  .transaction("snapshots")
                  .objectStore("snapshots")
                  .get(cacheKey);
                read.addEventListener("success", () => resolve(read.result?.projectionVersion));
                read.addEventListener("error", () =>
                  reject(read.error ?? new Error("Stable storage request failed")),
                );
              });
            } finally {
              database.close();
            }
          }, seeded.cacheKey),
        )
        .toBe(12);
      await page.reload();
      await gateway.waitForRequest("connect");
      await gateway.resolveDeferred("connect");
      await pane.getByText("Stable history 120", { exact: true }).waitFor();
      await retainedInputs();
      await waitForChatScrollIdle(page);
      const thread = pane.locator(".chat-thread");
      await thread.hover();
      await page.mouse.wheel(0, -100_000);
      const older = await gateway.waitForRequest("chat.history", {
        match: { cursor: "stable-before-tail" },
      });
      expect(older.params).not.toHaveProperty("offset");
      await expect
        .poll(() =>
          pane.evaluate((element) =>
            Reflect.get(element, "state").chatMessages.map(
              (message: { content: string }) => message.content,
            ),
          ),
        )
        .toEqual(messages.map((message) => message.content));
      await retainedInputs();
    }));

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
        if (profile === "offline" || profile === "matching") {
          // The service worker's offline document has no embedded bootstrap identity,
          // and an unreachable Gateway cannot answer the bootstrap config fetch.
          await page.route("**/control-ui-config.json", (route) => route.abort());
          await page.addInitScript(() => {
            const names: string[] = [];
            sessionStorage.setItem("openclaw.identity-proof.placeholders", "[]");
            new MutationObserver(() => {
              const composer = document.querySelector<HTMLTextAreaElement>(
                ".agent-chat__composer-combobox textarea",
              );
              if (composer && names.at(-1) !== composer.placeholder) {
                names.push(composer.placeholder);
                sessionStorage.setItem(
                  "openclaw.identity-proof.placeholders",
                  JSON.stringify(names),
                );
              }
            }).observe(document, { subtree: true, childList: true, attributes: true });
          });
        }
        if (profile === "offline") {
          await gateway.setOnline(false);
          await page.reload();
          await transcript.getByText(transcriptText, { exact: true }).waitFor();
          await sidebar.getByText("Cached only session", { exact: true }).waitFor();
          await page.locator(".chat-pane__connection-state").waitFor({ state: "visible" });
          expect(
            await page.evaluate(() =>
              JSON.parse(sessionStorage.getItem("openclaw.identity-proof.placeholders") ?? "null"),
            ),
          ).toEqual(["Message Observatory"]);
          expect(await page.locator(".chat-pane-cache__pane--active .skeleton").count()).toBe(0);
          expect(await gateway.getRequests("connect")).toEqual([]);
          expect(await gateway.getRequests("chat.send")).toEqual([]);
          await capture("warm-offline-before-socket.png");
          return;
        }
        if (profile === "matching") {
          // A cached reload must render even if the Gateway never sends its challenge.
          await page.addInitScript(() => {
            let heldChallenge = false;
            window.WebSocket = new Proxy(window.WebSocket, {
              construct(Target, args) {
                const socket = Reflect.construct(Target, args) as WebSocket;
                const dispatch = socket.dispatchEvent.bind(socket);
                socket.dispatchEvent = (event) => {
                  if (
                    !heldChallenge &&
                    event instanceof MessageEvent &&
                    typeof event.data === "string" &&
                    JSON.parse(event.data).event === "connect.challenge"
                  ) {
                    heldChallenge = true;
                    document.addEventListener(
                      "openclaw-proof-release-challenge",
                      () => dispatch(event),
                      { once: true },
                    );
                    return true;
                  }
                  return dispatch(event);
                };
                return socket;
              },
            });
          });
        }
        await page.reload({ waitUntil: "commit" });
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
        if (profile === "matching") {
          expect(await gateway.getRequests("connect")).toEqual([]);
          expect(await gateway.getSocketCount()).toBe(1);
          await page.evaluate(() =>
            document.dispatchEvent(new Event("openclaw-proof-release-challenge")),
          );
        }
        const connect = await gateway.waitForRequest("connect");
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
        if (profile === "matching") {
          expect(
            await page.evaluate(() =>
              JSON.parse(sessionStorage.getItem("openclaw.identity-proof.placeholders") ?? "null"),
            ),
          ).toEqual(["Message Observatory"]);
        }
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
          const heldStart = messages.length - 80;
          const firstStart = Math.max(0, heldStart - pageSize);
          const firstPage = messages.slice(firstStart, heldStart);
          await gateway.setMethodResponse("chat.history", {
            // Disk trimming retains 80 groups but no certified page edge. Reopen
            // that held source, then fetch strictly before it without replacing rows.
            cases: [
              {
                match: { messageId: `older-${heldStart + 1}`, limit: 1 },
                response: {
                  messages: [messages[heldStart]],
                  sessionId: currentRow.sessionId,
                  olderCursor: "warm-before-held",
                },
              },
              {
                match: { cursor: "warm-before-held" },
                response: {
                  messages: firstPage,
                  sessionId: currentRow.sessionId,
                  ...(firstStart ? { olderCursor: "warm-before-first" } : {}),
                },
              },
              {
                match: { cursor: "warm-before-first" },
                response: {
                  messages: messages.slice(0, firstStart),
                  sessionId: currentRow.sessionId,
                },
              },
            ],
          });
          const messageCount = () =>
            page
              .locator(".chat-pane-cache__pane--active")
              .evaluate((element) => Reflect.get(element, "state").chatMessages.length);
          const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
          await thread.hover();
          await page.mouse.wheel(0, -100_000);
          const history = await gateway.waitForRequest("chat.history", {
            match: { messageId: `older-${heldStart + 1}` },
          });
          expect(history.params).toMatchObject({ messageId: `older-${heldStart + 1}`, limit: 1 });
          expect(history.params).not.toHaveProperty("offset");
          await gateway.waitForRequest("chat.history", { match: { cursor: "warm-before-held" } });
          await expect.poll(messageCount).toBe(firstPage.length + 80);
          await page
            .getByText(`Older history ${heldStart}`, { exact: true })
            .waitFor({ state: "attached" });
          await waitForChatScrollIdle(page);
          await page.mouse.wheel(0, -1_000_000);
          if (firstStart) {
            const older = await gateway.waitForRequest("chat.history", {
              match: { cursor: "warm-before-first" },
            });
            expect(older.params).not.toHaveProperty("offset");
          }
          await expect.poll(messageCount).toBe(messages.length);
          // An exhausted imported page only scrolls to the top on the second wheel;
          // otherwise the second prepend preserves its own adjacent source boundary.
          const finalBoundary = Math.max(1, firstStart);
          if (!firstStart) {
            await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
            expect(await gateway.getRequests("chat.history")).toHaveLength(2);
          }
          await page
            .getByText(`Older history ${finalBoundary}`, { exact: true })
            .waitFor({ state: "attached" });
          await page.getByText(`Older history ${finalBoundary + 1}`, { exact: true }).waitFor();
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
