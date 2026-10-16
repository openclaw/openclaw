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
import {
  pollAttribute,
  pollText,
  pollValue,
  pollEnabled,
  installMockGateway,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Configured fresh-session defaults" });
const thinkingLevels = ["low", "medium", "high"].map((id) => ({ id, label: id }));
const preference = { model: "openai/gpt-4.1-mini", thinkingLevel: "low", fastMode: true };
const sessionKey = "agent:main:configured-defaults-proof";
const requiredProfile = { id: "dedicated", providerId: "device", executionModes: ["worker-turn"] };

// Serialized into the browser: keep all IndexedDB dependencies inside this function.
async function draftStorage(action: "read-old" | "seed-old" | "read-selection") {
  const once = (target: EventTarget, event: string, listener: () => void) =>
    target.addEventListener(event, listener, { once: true });
  const read = <T>(request: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      once(request, "success", () => resolve(request.result));
      once(request, "error", () => reject(request.error ?? new Error("IndexedDB request failed")));
    });
  const db = await read(indexedDB.open("openclaw-control-ui"));
  try {
    if (action === "seed-old") {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("composerDrafts", "readwrite");
        const store = transaction.objectStore("composerDrafts");
        const request = store.getAll();
        once(request, "success", () => {
          const old = request.result.find((row) => row.text === "Unsent before upgrade");
          if (!old) {
            transaction.abort();
            return;
          }
          // Exact pre-change serializer fields (60d9d1042375f014944b94006f4b1c2b2f5af9c0).
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
                blob: new Blob(["Keep these attachment bytes"], { type: "text/plain" }),
                mimeType: "text/plain",
                origin: "file",
                fileName: "upgrade-notes.txt",
                sizeBytes: 27,
              },
            ],
          });
        });
        once(transaction, "complete", () => resolve());
        once(transaction, "abort", () =>
          reject(transaction.error ?? new Error("Legacy fixture missing")),
        );
        once(transaction, "error", () =>
          reject(transaction.error ?? new Error("Legacy fixture failed")),
        );
      });
      return;
    }
    const rows: {
      text: string;
      modelSelection?: { thinkingLevel?: string };
      attachments: { blob: Blob }[];
    }[] = await read(db.transaction("composerDrafts").objectStore("composerDrafts").getAll());
    const row = rows.find(
      (value) =>
        value.text === (action === "read-old" ? "Unsent before upgrade" : "Resume this draft"),
    );
    if (action === "read-selection") {
      return row?.modelSelection?.thinkingLevel;
    }
    return {
      text: row?.text,
      hasModelSelection: row ? Object.hasOwn(row, "modelSelection") : null,
      attachmentText: await row?.attachments[0]?.blob.text(),
    };
  } finally {
    db.close();
  }
}

suite.define(() => {
  it.each([
    { source: "browser", required: false },
    { source: "identity", required: false },
    { source: "browser", required: true },
  ] as const)(
    "uses configured defaults without erasing $source preferences (required: $required)",
    async ({ source, required }) => {
      const policies = required
        ? ([undefined, "last-used", "configured"] as const)
        : (["last-used", "configured"] as const);
      for (const policy of policies) {
        const configuredDefaults = required || policy === "configured";
        await suite.withPage(
          { ...createControlUiE2eContextOptions(), reducedMotion: "reduce" },
          async ({ page }) => {
            const draftInput = page.locator(".new-session-page__message");
            const modelPicker = page.locator('[data-chat-model-select="true"]');
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
                { id: "gpt-4.1", name: "GPT-4.1" },
                { id: "gpt-4.1-mini", name: "GPT-4.1 mini" },
              ].map((model) =>
                Object.assign(model, {
                  provider: "openai",
                  reasoning: true,
                  thinkingLevels,
                  supportsFastMode: true,
                }),
              ),
              ...(source === "identity"
                ? { presenceUsers: [{ self: true, id: "sample-user", name: "Sample User" }] }
                : {}),
              featureMethods: [
                "chat.metadata",
                "chat.startup",
                "sessions.create",
                ...(required ? ["sessions.describe", "sessions.send"] : []),
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
                  sessionPlacement: required ? { requiredProfile } : {},
                },
                "sessions.describe": {
                  session: { key: sessionKey, placement: { state: "active" } },
                },
                "sessions.send": { runId: "configured-defaults-proof", status: "started" },
                "users.prefs.get": {
                  status: "ok",
                  entries: { "new-session.migration.v1": true, "new-session.v1:main": preference },
                },
                "users.prefs.set": { status: "ok" },
                "sessions.create": { key: sessionKey, runStarted: true },
              },
            });
            await page.route("**/control-ui-config.json", (route) =>
              route.fulfill({
                json: {
                  ...createControlUiMockBootstrapConfig(),
                  ...(policy === undefined ? {} : { newSessionModelDefaults: policy }),
                },
              }),
            );
            await page.goto(suite.server.baseUrl + "new");
            const effort = page.locator('[data-chat-thinking-select="true"]');
            await pollAttribute(effort, "data-chat-thinking-value").toBe(
              configuredDefaults ? "" : "low",
            );
            if (configuredDefaults) {
              await expect
                .poll(async () => (await effort.textContent())?.toLowerCase())
                .toContain("high");
            }
            await pollText(modelPicker).toContain(configuredDefaults ? "GPT-4.1" : "GPT-4.1 mini");
            if (source === "browser" && process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
              await page.screenshot({
                path: path.join(suite.artifactDir, configuredDefaults ? "after.png" : "before.png"),
                animations: "disabled",
              });
            }
            // Identity preferences mirror to storage independently of model rendering.
            await expect
              .poll(() =>
                page.evaluate(
                  (key) =>
                    JSON.parse(localStorage.getItem(key) ?? "null")?.agents?.main?.thinkingLevel,
                  storageKey,
                ),
              )
              .toBe("low");
            if (configuredDefaults) {
              if (source === "browser") {
                await draftInput.fill("Unsent before upgrade");
                await page.locator(".agent-chat__file-input").setInputFiles({
                  name: "upgrade-notes.txt",
                  mimeType: "text/plain",
                  buffer: Buffer.from("Keep these attachment bytes"),
                });
                await expect
                  .poll(() => page.evaluate(draftStorage, "read-old"))
                  .toEqual({
                    text: "Unsent before upgrade",
                    hasModelSelection: false,
                    attachmentText: "Keep these attachment bytes",
                  });
                // Unmount before seeding the legacy row with its existing identity/fences.
                await page.route("**/legacy-draft-seed", (route) =>
                  route.fulfill({
                    contentType: "text/html",
                    body: "<!doctype html><title>Legacy draft fixture</title>",
                  }),
                );
                await page.goto(suite.server.baseUrl + "legacy-draft-seed");
                await page.evaluate(draftStorage, "seed-old");
                await page.goto(suite.server.baseUrl + "new");
                await pollValue(draftInput).toBe("Unsent before upgrade");
                await pollText(page.locator(".chat-attachment-file__name")).toContain(
                  "upgrade-notes.txt",
                );
                await pollAttribute(effort, "data-chat-thinking-value").toBe("");
                await pollText(effort).toContain("High");
              }
              await modelPicker.click();
              await page.locator('[data-chat-model-search="true"]').fill("mini");
              await page.locator('[data-chat-model-option="openai/gpt-4.1-mini"]').click();
              await effort.click();
              await page.locator('[data-chat-thinking-slider="true"]').fill("0");
              await page.keyboard.press("Escape");
              await draftInput.fill("Resume this draft");
              await expect.poll(() => page.evaluate(draftStorage, "read-selection")).toBe("low");
              await page.reload();
              await pollAttribute(effort, "data-chat-thinking-value").toBe("low");
              await pollValue(draftInput).toBe("Resume this draft");
              await pollText(modelPicker).toContain("GPT-4.1 mini");
            }
            await draftInput.fill("Start with the selected defaults");
            await page.getByRole("button", { name: "Start session", exact: true }).click();
            const request = await gateway.waitForRequest("sessions.create");
            expect(request.params).toMatchObject(preference);
            const initialTurn = required ? await gateway.waitForRequest("sessions.send") : request;
            if (configuredDefaults && source === "browser") {
              expect(initialTurn.params).toMatchObject({
                attachments: [
                  {
                    fileName: "upgrade-notes.txt",
                    mimeType: "text/plain",
                    content: Buffer.from("Keep these attachment bytes").toString("base64"),
                  },
                ],
              });
            }
            if (configuredDefaults) {
              await waitForCommittedChatRoute(page);
              // Replacing the document must not interrupt the submitted draft's cleanup.
              await waitForCommittedComposerDraft(page, JSON.stringify(["", "", ""]), null, 0);
              await page.goto(suite.server.baseUrl + "new");
              await pollAttribute(effort, "data-chat-thinking-value").toBe("");
              await expect
                .poll(async () => (await effort.textContent())?.toLowerCase())
                .toContain("high");
              await pollText(modelPicker).not.toContain("mini");
              await page.keyboard.press("ControlOrMeta+K");
              const palette = page.locator("openclaw-command-palette");
              const prompt = palette.locator(".cmd-palette__input");
              await prompt.fill("Start another task\nUsing configured defaults");
              const start = palette.getByRole("button", {
                name: "Start new session in background",
                exact: true,
              });
              await pollEnabled(start).toBe(true);
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
