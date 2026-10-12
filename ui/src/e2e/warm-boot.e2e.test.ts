import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { escapeHtml } from "../../../src/shared/html-escape.js";
import type { ApplicationRuntime } from "../app/bootstrap.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
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

async function waitForPersistedWarmState(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const hasBootRecord = Object.keys(localStorage).some((key) =>
          key.startsWith("openclaw.control.bootRecord.v1:"),
        );
        const databases = await indexedDB.databases();
        async function readRecords(databaseName: string, storeName: string): Promise<unknown[]> {
          if (!databases.some((database) => database.name === databaseName)) {
            return [];
          }
          return new Promise((resolve, reject) => {
            const open = indexedDB.open(databaseName);
            open.addEventListener("error", () =>
              reject(open.error ?? new Error("IndexedDB open failed")),
            );
            open.addEventListener("success", () => {
              const database = open.result;
              const transaction = database.transaction(storeName, "readonly");
              const request = transaction.objectStore(storeName).getAll();
              request.addEventListener("error", () =>
                reject(request.error ?? new Error("IndexedDB read failed")),
              );
              transaction.addEventListener("complete", () => {
                database.close();
                resolve(request.result);
              });
            });
          });
        }
        const [rosters, snapshots] = await Promise.all([
          readRecords("openclaw-chat-snapshots", "sidebarSnapshots"),
          readRecords("openclaw-chat-snapshots", "snapshots"),
        ]);
        return {
          bootRecord: hasBootRecord,
          roster: rosters.some((record) => {
            if (typeof record !== "object" || record === null || !("model" in record)) {
              return false;
            }
            const model = record.model;
            if (typeof model !== "object" || model === null || !("roster" in model)) {
              return false;
            }
            const roster = model.roster;
            if (typeof roster !== "object" || roster === null || !("result" in roster)) {
              return false;
            }
            const result = roster.result;
            return (
              typeof result === "object" &&
              result !== null &&
              "sessions" in result &&
              Array.isArray(result.sessions) &&
              result.sessions.some(
                (row: unknown) =>
                  typeof row === "object" &&
                  row !== null &&
                  "key" in row &&
                  row.key === "agent:main:cached-only",
              )
            );
          }),
          transcript: snapshots.some(
            (snapshot) =>
              typeof snapshot === "object" &&
              snapshot !== null &&
              "snapshot" in snapshot &&
              typeof snapshot.snapshot === "object" &&
              snapshot.snapshot !== null &&
              "deltaCursor" in snapshot.snapshot &&
              snapshot.snapshot.deltaCursor === "warm-reload-cursor",
          ),
        };
      }),
    )
    .toEqual({ bootRecord: true, roster: true, transcript: true });
}

suite.define(() => {
  it.each(["matching", "different", "device-token", "trusted-proxy", "legacy-rail"])(
    "reconciles the cached shell, roster, and transcript with a %s profile",
    async (profile) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const timestamp = Date.now();
        const currentRow = {
          key: sessionKey,
          sessionId: "warm-reload-session",
          kind: "direct" as const,
          label: "Warm reload conversation",
          owner: { actor: { type: "human" as const, id: "profile-a" } },
          updatedAt: timestamp,
        };
        const gateway = await installMockGateway(page, {
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
          sessions: [
            currentRow,
            {
              key: "agent:main:cached-only",
              sessionId: "cached-only-session",
              kind: "direct",
              label: "Cached only session",
              owner: { actor: { type: "human", id: "profile-a" } },
              updatedAt: timestamp - 1,
            },
          ],
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
                {
                  role: "assistant",
                  content: transcriptText,
                  __openclaw: { id: "cached-message", seq: 1 },
                },
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
              metadata: { models: [] },
            },
          },
        });
        await page.goto(
          controlUiSessionUrl(suite.server.baseUrl, sessionKey) +
            (profile === "device-token" || profile === "trusted-proxy" ? "" : "#token=test-token"),
        );
        await gateway.waitForRequest("connect");
        await page.locator(".connect-splash").waitFor();
        await page.screenshot({ path: path.join(suite.artifactDir, "cold-connecting.png") });
        await gateway.resolveDeferred("connect");
        const sidebar = page.locator("openclaw-app-sidebar");
        const transcript = page.locator(".chat-thread-inner");
        await sidebar.getByText("Cached only session", { exact: true }).waitFor();
        await transcript.getByText(transcriptText, { exact: true }).waitFor();
        if (profile === "matching") {
          await expectOwnMessageAlignment(page);
        }
        await waitForPersistedWarmState(page);
        const hello = await page.evaluate(() => {
          const app = document.querySelector<HTMLElement & { runtime?: ApplicationRuntime }>(
            "openclaw-app",
          );
          const snapshot = app?.runtime?.context.gateway.snapshot;
          if (snapshot?.selfUser?.id !== "profile-a" || !snapshot.hello) {
            throw new Error("Expected the first connection to belong to profile-a");
          }
          return snapshot.hello;
        });

        if (profile === "legacy-rail") {
          const records = await page.evaluate(async () => {
            const open = indexedDB.open("openclaw-chat-snapshots");
            await new Promise<void>((resolve, reject) => {
              open.addEventListener("success", () => resolve());
              open.addEventListener("error", () =>
                reject(open.error ?? new Error("Snapshot open failed")),
              );
            });
            const database = open.result;
            const request = database
              .transaction("sidebarSnapshots")
              .objectStore("sidebarSnapshots")
              .getAll();
            const saved = await new Promise<Array<{ model: { entries: string[] } }>>(
              (resolve, reject) => {
                request.addEventListener("success", () => resolve(request.result));
                request.addEventListener("error", () =>
                  reject(request.error ?? new Error("Snapshot read failed")),
                );
              },
            );
            database.close();
            for (const record of saved) {
              record.model.entries = ["route:usage", "route:cron"];
            }
            return saved;
          });
          expect(records.length).toBeGreaterThan(0);
          const url = page.url();
          await page.goto("about:blank");
          const modules = await holdModuleResponse(page, /\/assets\/.*\.js(?:\?|$)/u);
          await page.goto(url, { waitUntil: "commit" });
          await modules.request;
          await page.evaluate(async (saved) => {
            const deleted = indexedDB.deleteDatabase("openclaw-chat-snapshots");
            await new Promise<void>((resolve, reject) => {
              deleted.addEventListener("success", () => resolve());
              deleted.addEventListener("error", () =>
                reject(deleted.error ?? new Error("Snapshot deletion failed")),
              );
              deleted.addEventListener("blocked", () =>
                reject(new Error("Old snapshot database remained open")),
              );
            });
            const open = indexedDB.open("openclaw-chat-snapshots", 6);
            open.addEventListener("upgradeneeded", () => {
              for (const name of ["snapshots", "snapshotMetadata", "sidebarSnapshots"]) {
                open.result.createObjectStore(name, { keyPath: "sessionKey" });
              }
            });
            await new Promise<void>((resolve, reject) => {
              open.addEventListener("success", () => resolve());
              open.addEventListener("error", () =>
                reject(open.error ?? new Error("Legacy snapshot open failed")),
              );
            });
            const database = open.result;
            const transaction = database.transaction("sidebarSnapshots", "readwrite");
            for (const record of saved) {
              transaction.objectStore("sidebarSnapshots").put(record);
            }
            await new Promise<void>((resolve, reject) => {
              transaction.addEventListener("complete", () => resolve());
              transaction.addEventListener("error", () =>
                reject(transaction.error ?? new Error("Legacy snapshot write failed")),
              );
            });
            database.close();
          }, records);
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
        await page.reload();
        const connect = await gateway.waitForRequest("connect");
        await sidebar.locator(".sidebar-footer-bar__home").waitFor();
        await sidebar.getByText("Cached only session", { exact: true }).waitFor();
        await transcript.getByText(transcriptText, { exact: true }).waitFor();
        expect(await gateway.getRequests("sessions.list")).toEqual([]);
        expect(await gateway.getRequests("chat.startup")).toEqual([]);
        if (profile === "trusted-proxy") {
          await page.screenshot({
            path: path.join(suite.artifactDir, "bootstrap-before-hello.png"),
          });
          expect(
            await page.evaluate(
              () =>
                document.querySelector<HTMLElement & { runtime?: ApplicationRuntime }>(
                  "openclaw-app",
                )?.runtime?.context.config.current.assistantIdentity.name,
            ),
          ).toBe("Observatory");
          expect(bootstrapRequests).toBe(0);
          await sidebar.getByRole("button", { name: /^Observatory ·/u }).waitFor();
        }
        if (profile === "matching") {
          await expectOwnMessageAlignment(page);
        }
        await page.screenshot({
          path: path.join(suite.artifactDir, `warm-${profile}-before-hello.png`),
        });

        await gateway.setSessionsListResponse({
          ownerSessionCounts: [],
          ts: timestamp + 1,
          path: "",
          count: 2,
          defaults: { model: null, modelProvider: null, contextTokens: null },
          sessions: [
            { ...currentRow, label: "Live reload conversation", updatedAt: timestamp + 1 },
            {
              key: "agent:main:live-only",
              sessionId: "live-only-session",
              kind: "direct",
              label: "Live only session",
              owner: {
                actor: { type: "human", id: profile === "different" ? "profile-b" : "profile-a" },
              },
              updatedAt: timestamp,
            },
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
              ...(typeof hello.snapshot === "object" && hello.snapshot !== null
                ? hello.snapshot
                : {}),
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
        await transcript
          .getByText(
            profile === "different" ? "This is profile B's conversation." : transcriptText,
            { exact: true },
          )
          .waitFor();
        await page.screenshot({
          path: path.join(suite.artifactDir, `warm-${profile}-after-hello.png`),
        });
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
      });
    },
  );
});
