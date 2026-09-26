import path from "node:path";
import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import {
  controlUiBundledGatewayUrl,
  createControlUiMockBootstrapConfig,
  createControlUiMockSameOriginGatewayScript,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eSuite,
  createControlUiE2eContextOptions,
} from "./control-ui-e2e-suite.test-support.ts";
import { installMockGateway, waitForCommittedChatRoute } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Configured fresh-session defaults",
});
const thinkingLevels = ["low", "medium", "high"].map((id) => ({ id, label: id }));
const preference = { model: "openai/gpt-4.1-mini", thinkingLevel: "low", fastMode: true };

suite.define(() => {
  it.each(["browser", "identity"] as const)(
    "uses configured defaults without erasing %s preferences",
    async (source) => {
      for (const policy of ["last-used", "configured"] as const) {
        await suite.withPage(
          { ...createControlUiE2eContextOptions(), reducedMotion: "reduce" },
          async ({ page }) => {
            await page.addInitScript(createControlUiMockSameOriginGatewayScript());
            const storageKey =
              "openclaw.new-session.preferences.v1:" +
              gatewayOriginScope(controlUiBundledGatewayUrl(suite.server.baseUrl));
            if (source === "browser") {
              await page.addInitScript(
                ({ storageKey: key, preference: stored }) => {
                  localStorage.setItem(key, JSON.stringify({ agents: { main: stored } }));
                },
                { storageKey, preference },
              );
            }
            const gateway = await installMockGateway(page, {
              agentModel: "openai/gpt-4.1",
              models: [
                {
                  id: "gpt-4.1",
                  provider: "openai",
                  name: "GPT-4.1",
                  reasoning: true,
                  thinkingLevels,
                  supportsFastMode: true,
                },
                {
                  id: "gpt-4.1-mini",
                  provider: "openai",
                  name: "GPT-4.1 mini",
                  reasoning: true,
                  thinkingLevels,
                  supportsFastMode: true,
                },
              ],
              ...(source === "identity"
                ? { presenceUsers: [{ self: true, id: "sample-user", name: "Sample User" }] }
                : {}),
              featureMethods: [
                "chat.metadata",
                "chat.startup",
                "sessions.create",
                ...(source === "identity" ? ["users.prefs.get", "users.prefs.set"] : []),
              ],
              sessions: [],
              methodResponses: {
                "agents.list": {
                  agents: [
                    {
                      id: "main",
                      name: "Main",
                      model: { primary: "openai/gpt-4.1" },
                      thinkingDefault: "high",
                      thinkingLevels,
                    },
                  ],
                  defaultId: "main",
                  mainKey: "main",
                  scope: "agent",
                },
                "users.prefs.get": {
                  status: "ok",
                  entries: { "new-session.migration.v1": true, "new-session.v1:main": preference },
                },
                "users.prefs.set": { status: "ok" },
                "sessions.create": {
                  key: "agent:main:configured-defaults-proof",
                  runStarted: true,
                },
              },
            });
            await page.route("**/control-ui-config.json", (route) =>
              route.fulfill({
                json: { ...createControlUiMockBootstrapConfig(), newSessionModelDefaults: policy },
              }),
            );
            await page.goto(suite.server.baseUrl + "new");
            const effort = page.locator('[data-chat-thinking-select="true"]');
            await expect
              .poll(() => effort.getAttribute("data-chat-thinking-value"))
              .toBe(policy === "configured" ? "" : "low");
            if (policy === "configured") {
              await expect
                .poll(async () => (await effort.textContent())?.toLowerCase())
                .toContain("high");
            }
            await expect
              .poll(() => page.locator('[data-chat-model-select="true"]').textContent())
              .toContain(policy === "configured" ? "GPT-4.1" : "GPT-4.1 mini");
            if (source === "browser" && process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
              await page.screenshot({
                path: path.join(
                  suite.artifactDir,
                  policy === "configured" ? "after.png" : "before.png",
                ),
                animations: "disabled",
              });
            }
            // Configured model metadata can render before the independent identity
            // preference request mirrors its result into browser storage.
            await expect
              .poll(() =>
                page.evaluate(
                  (key) =>
                    JSON.parse(localStorage.getItem(key) ?? "null")?.agents?.main?.thinkingLevel,
                  storageKey,
                ),
              )
              .toBe("low");
            if (policy === "configured") {
              if (source === "browser") {
                // A draft with no explicit model choice has exactly the pre-change row
                // format: content and blobs, without the optional modelSelection field.
                await page.locator(".new-session-page__message").fill("Unsent before upgrade");
                await page.locator(".agent-chat__file-input").setInputFiles({
                  name: "upgrade-notes.txt",
                  mimeType: "text/plain",
                  buffer: Buffer.from("Keep these attachment bytes"),
                });
                await expect
                  .poll(() =>
                    page.evaluate(async () => {
                      const db = await new Promise<IDBDatabase>((resolve, reject) => {
                        const request = indexedDB.open("openclaw-control-ui");
                        request.addEventListener("success", () => resolve(request.result), {
                          once: true,
                        });
                        request.addEventListener(
                          "error",
                          () => reject(request.error ?? new Error("IndexedDB request failed")),
                          { once: true },
                        );
                      });
                      try {
                        const rows = await new Promise<
                          {
                            text: string;
                            modelSelection?: unknown;
                            attachments: { blob: Blob }[];
                          }[]
                        >((resolve, reject) => {
                          const request = db
                            .transaction("composerDrafts")
                            .objectStore("composerDrafts")
                            .getAll();
                          request.addEventListener("success", () => resolve(request.result), {
                            once: true,
                          });
                          request.addEventListener(
                            "error",
                            () => reject(request.error ?? new Error("IndexedDB request failed")),
                            { once: true },
                          );
                        });
                        const row = rows.find((value) => value.text === "Unsent before upgrade");
                        return {
                          text: row?.text,
                          hasModelSelection: row ? Object.hasOwn(row, "modelSelection") : null,
                          attachmentText: await row?.attachments[0]?.blob.text(),
                        };
                      } finally {
                        db.close();
                      }
                    }),
                  )
                  .toEqual({
                    text: "Unsent before upgrade",
                    hasModelSelection: false,
                    attachmentText: "Keep these attachment bytes",
                  });
                // Remove the running app before seeding the old serializer shape. Only
                // its already-scoped identity/fence fields are reused; no new row fields.
                await page.route("**/legacy-draft-seed", (route) =>
                  route.fulfill({
                    contentType: "text/html",
                    body: "<!doctype html><title>Legacy draft fixture</title>",
                  }),
                );
                await page.goto(suite.server.baseUrl + "legacy-draft-seed");
                await page.evaluate(async () => {
                  const db = await new Promise<IDBDatabase>((resolve, reject) => {
                    const request = indexedDB.open("openclaw-control-ui");
                    request.addEventListener("success", () => resolve(request.result), {
                      once: true,
                    });
                    request.addEventListener(
                      "error",
                      () => reject(request.error ?? new Error("IndexedDB request failed")),
                      { once: true },
                    );
                  });
                  try {
                    await new Promise<void>((resolve, reject) => {
                      const transaction = db.transaction("composerDrafts", "readwrite");
                      const store = transaction.objectStore("composerDrafts");
                      const request = store.getAll();
                      request.addEventListener(
                        "success",
                        () => {
                          const old = request.result.find(
                            (row) => row.text === "Unsent before upgrade",
                          );
                          if (!old) {
                            transaction.abort();
                            return;
                          }
                          // Matches writeDurableComposerDraft at the pre-change base:
                          // 60d9d1042375f014944b94006f4b1c2b2f5af9c0.
                          store.put({
                            key: old.key,
                            ownerKey: old.ownerKey,
                            gatewayOwner: old.gatewayOwner,
                            recoveryScope: old.recoveryScope,
                            scopeKey: old.scopeKey,
                            revision: old.revision,
                            writeId: old.writeId,
                            updatedAt: old.updatedAt,
                            text: "Unsent before upgrade",
                            attachments: [
                              {
                                blob: new Blob(["Keep these attachment bytes"], {
                                  type: "text/plain",
                                }),
                                mimeType: "text/plain",
                                origin: "file",
                                fileName: "upgrade-notes.txt",
                                sizeBytes: 27,
                              },
                            ],
                          });
                        },
                        { once: true },
                      );
                      transaction.addEventListener("complete", () => resolve(), { once: true });
                      transaction.addEventListener(
                        "abort",
                        () => reject(transaction.error ?? new Error("Legacy fixture missing")),
                        { once: true },
                      );
                      transaction.addEventListener(
                        "error",
                        () => reject(transaction.error ?? new Error("Legacy fixture failed")),
                        { once: true },
                      );
                    });
                  } finally {
                    db.close();
                  }
                });
                await page.goto(suite.server.baseUrl + "new");
                await expect
                  .poll(() => page.locator(".new-session-page__message").inputValue())
                  .toBe("Unsent before upgrade");
                await expect
                  .poll(() => page.locator(".chat-attachment-file__name").textContent())
                  .toContain("upgrade-notes.txt");
                await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("");
                await expect.poll(() => effort.textContent()).toContain("High");
              }
              await page.locator('[data-chat-model-select="true"]').click();
              await page.locator('[data-chat-model-search="true"]').fill("mini");
              await page.locator('[data-chat-model-option="openai/gpt-4.1-mini"]').click();
              await effort.click();
              await page.locator('[data-chat-thinking-slider="true"]').fill("0");
              await page.keyboard.press("Escape");
              await page.locator(".new-session-page__message").fill("Resume this draft");
              await expect
                .poll(() =>
                  page.evaluate(async () => {
                    const db = await new Promise<IDBDatabase>((resolve, reject) => {
                      const request = indexedDB.open("openclaw-control-ui");
                      request.addEventListener("success", () => resolve(request.result), {
                        once: true,
                      });
                      request.addEventListener(
                        "error",
                        () => reject(request.error ?? new Error("IndexedDB request failed")),
                        { once: true },
                      );
                    });
                    try {
                      return await new Promise<unknown>((resolve, reject) => {
                        const request = db
                          .transaction("composerDrafts")
                          .objectStore("composerDrafts")
                          .getAll();
                        request.addEventListener(
                          "success",
                          () =>
                            resolve(
                              request.result.find((row) => row.text === "Resume this draft")
                                ?.modelSelection?.thinkingLevel,
                            ),
                          { once: true },
                        );
                        request.addEventListener(
                          "error",
                          () => reject(request.error ?? new Error("IndexedDB request failed")),
                          { once: true },
                        );
                      });
                    } finally {
                      db.close();
                    }
                  }),
                )
                .toBe("low");
              await page.reload();
              await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("low");
              await expect
                .poll(() => page.locator('[data-chat-model-select="true"]').textContent())
                .toContain("GPT-4.1 mini");
            }
            await page
              .locator(".new-session-page__message")
              .fill("Start with the selected defaults");
            await page.getByRole("button", { name: "Start session", exact: true }).click();
            const request = await gateway.waitForRequest("sessions.create");
            expect(request.params).toMatchObject({ model: preference.model, thinkingLevel: "low" });
            expect(request.params).toHaveProperty("fastMode", true);
            if (policy === "configured" && source === "browser") {
              expect(request.params).toMatchObject({
                attachments: [
                  {
                    fileName: "upgrade-notes.txt",
                    mimeType: "text/plain",
                    content: Buffer.from("Keep these attachment bytes").toString("base64"),
                  },
                ],
              });
            }
            if (policy === "configured") {
              await waitForCommittedChatRoute(page);
              await page.goto(suite.server.baseUrl + "new");
              await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("");
              await expect
                .poll(async () => (await effort.textContent())?.toLowerCase())
                .toContain("high");
              await expect
                .poll(() => page.locator('[data-chat-model-select="true"]').textContent())
                .not.toContain("mini");
              await page.keyboard.press("ControlOrMeta+K");
              const palette = page.locator("openclaw-command-palette");
              const prompt = palette.locator(".cmd-palette__input");
              await prompt.fill("Start another task\nUsing configured defaults");
              const start = palette.getByRole("button", {
                name: "Start new session in background",
                exact: true,
              });
              await expect.poll(() => start.isEnabled()).toBe(true);
              await start.click();
              const paletteRequest = await gateway.waitForRequest("sessions.create");
              expect(paletteRequest.params).not.toHaveProperty("model");
              expect(paletteRequest.params).not.toHaveProperty("thinkingLevel");
              expect(paletteRequest.params).toHaveProperty("fastMode", true);
            }
          },
        );
      }
    },
  );
});
