import { asRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { REDACTED_SENTINEL } from "../lib/config-form-utils.ts";
import { installMockGateway, type ControlUiMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  configMocks,
  inspection,
  inventory,
  workboard,
} from "./plugins-settings-admin.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI plugin credentials mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const credentialPath = ["plugins", "entries", "workboard", "config", "search", "apiKey"];
const configHash = configMocks["config.get"].hash;
const originalRef = { source: "file", provider: "team", id: "/search/apiKey" };
const searchConfig = { apiKey: originalRef, mode: "web", otherSecret: REDACTED_SENTINEL };
function configWithSearch(search: Record<string, unknown>) {
  return { plugins: { entries: { workboard: { enabled: true, config: { search } } } } };
}
function objectSchema(properties: Record<string, unknown>, strict = false) {
  return { type: "object", ...(strict ? { additionalProperties: false } : {}), properties };
}
const schema = ["search", "config", "workboard", "entries", "plugins"].reduce(
  (child, key) => objectSchema({ [key]: child }, key === "search"),
  objectSchema(
    {
      apiKey: { type: ["string", "object"] },
      mode: { type: "string" },
      otherSecret: { type: "string" },
    },
    true,
  ),
);

function keyButton(page: Page, action: "Show" | "Hide") {
  return page.getByRole("button", { name: `${action} API key: Search API key`, exact: true });
}
async function expectMasked(input: Locator) {
  expect([await input.inputValue(), await input.getAttribute("type")]).toEqual(["", "password"]);
}
function configSnapshot(config: ReturnType<typeof configWithSearch>, hash = configHash) {
  return { ...configMocks["config.get"], config, raw: JSON.stringify(config), hash };
}
const prefix = "plugins.entries.workboard.config.search";
const featureMethods = [
  "config.get",
  "config.schema",
  "config.set",
  "plugins.inspect",
  "plugins.list",
  "plugins.credentials.inspect",
];

suite.define(() => {
  it.each([
    { width: 390, readOnly: false, literal: false, missing: false },
    { width: 1174, readOnly: false, literal: false, missing: false },
    { width: 1174, readOnly: true, literal: false, missing: false },
    { width: 1174, readOnly: false, literal: true, missing: false },
    { width: 390, readOnly: false, literal: false, missing: true },
  ])(
    "edits the advertised nested reference through the acknowledged writer at $width (readOnly=$readOnly, literal=$literal, missing=$missing)",
    ({ width, readOnly, literal, missing }) =>
      suite.withPage(
        { colorScheme: "dark", viewport: { width, height: 900 } },
        async ({ page }) => {
          const { apiKey, ...siblings } = searchConfig;
          const initial = configWithSearch({
            ...siblings,
            ...(!missing ? { apiKey: literal ? REDACTED_SENTINEL : apiKey } : {}),
          });
          const gateway = await installMockGateway(page, {
            featureMethods,
            operatorScopes: readOnly ? ["operator.read"] : ["operator.read", "operator.admin"],
            methodResponses: {
              "plugins.list": { ...inventory, plugins: [workboard] },
              "plugins.inspect": {
                ...inspection,
                catalog: undefined,
                credentials: [
                  {
                    path: credentialPath,
                    label: "Search API key",
                    envVars: ["SEARCH_API_KEY"],
                    signupUrl: "https://provider.example/signup",
                    placeholder: "demo-key",
                  },
                ],
              },
              "plugins.credentials.inspect": {
                baseHash: configHash,
                credential: missing
                  ? { kind: "missing" }
                  : literal
                    ? { kind: "literal" }
                    : { kind: "reference", ref: originalRef, unresolved: false },
              },
              "config.get": configSnapshot(initial),
              "config.schema": {
                ...configMocks["config.schema"],
                schema,
                uiHints: {
                  [`${prefix}.apiKey`]: { label: "Search API key", sensitive: true },
                  [`${prefix}.otherSecret`]: { label: "Other secret", sensitive: true },
                  [`${prefix}.mode`]: { label: "Search mode" },
                },
              },
            },
          });
          const inspect = (credential: Record<string, unknown>, baseHash = configHash) =>
            gateway.setMethodResponse("plugins.credentials.inspect", { baseHash, credential });
          const ref = (id: string) => ({
            kind: "reference",
            ref: { ...originalRef, id },
            unresolved: false,
          });
          await page.goto(`${suite.server.baseUrl}settings/plugins/workboard?view=settings`);
          await page.locator("openclaw-plugin-settings-editor").waitFor();
          if (literal || missing) {
            const input = page.getByLabel("Search API key", { exact: true });
            await input.waitFor();
            await expectMasked(input);
            expect(
              await page
                .getByRole("link", { name: "Get an API key", exact: true })
                .getAttribute("href"),
            ).toBe("https://provider.example/signup");
            await input.focus();
            await page
              .locator("openclaw-plugin-settings-editor")
              .getByLabel("Search settings", { exact: true })
              .click();
            expect(await gateway.getRequests("config.set")).toHaveLength(0);
            const reveal = keyButton(page, "Show");
            await expect
              .poll(async () => (await gateway.getRequests("plugins.credentials.inspect")).length)
              .toBe(1);
            expect(
              (await gateway.getRequests("plugins.credentials.inspect"))[0]?.params,
            ).not.toHaveProperty("reveal");
            if (literal) {
              await inspect({ kind: "literal", value: "synthetic-stored-key" });
              await reveal.click();
              await expect.poll(() => input.inputValue()).toBe("synthetic-stored-key");
              expect(
                (await gateway.getRequests("plugins.credentials.inspect")).at(-1)?.params,
              ).toMatchObject({
                pluginId: "workboard",
                path: credentialPath,
                baseHash: configHash,
                reveal: true,
              });
              await keyButton(page, "Hide").click();
              expect(await input.inputValue()).toBe("");
              expect(await gateway.getRequests("config.set")).toHaveLength(0);
            } else {
              expect(await reveal.isDisabled()).toBe(true);
              expect(await input.getAttribute("placeholder")).toBe("demo-key");
            }
            await input.fill("synthetic-new-key");
            await keyButton(page, "Show").click();
            expect(await input.getAttribute("type")).toBe("text");
            await keyButton(page, "Hide").click();
            await gateway.deferNext("config.set");
            await input.press("Enter");
            const request = await gateway.waitForRequest("config.set");
            expect(JSON.parse(String(asRecord(request.params).raw))).toEqual(
              configWithSearch({
                ...initial.plugins.entries.workboard.config.search,
                apiKey: "synthetic-new-key",
              }),
            );
            expect(await input.isDisabled()).toBe(true);
            await inspect({ kind: "literal" }, "mock-config-hash-1");
            await gateway.resolveDeferred("config.set");
            await expect.poll(() => input.inputValue()).toBe("");
            expect(await gateway.getRequests("config.set")).toHaveLength(1);
            await page.reload();
            await input.waitFor();
            await expectMasked(input);
            return;
          }
          const reference = page.getByRole("button", {
            name: "Edit reference: Search API key",
            exact: true,
          });
          await reference.waitFor();
          const other = page.locator('input[aria-label$="Other secret"]');
          await expectMasked(other);
          expect(await page.locator('input[aria-label$="Search mode"]').inputValue()).toBe("web");
          expect(await reference.count()).toBe(1);
          expect(await page.locator("body").textContent()).not.toContain(REDACTED_SENTINEL);
          if (readOnly) {
            expect(await reference.isDisabled()).toBe(true);
            expect(await gateway.getRequests("plugins.credentials.inspect")).toHaveLength(0);
            expect(await gateway.getRequests("config.set")).toHaveLength(0);
            return;
          }
          await expect.poll(() => reference.isEnabled()).toBe(true);
          await reference.click();
          await page
            .getByRole("dialog", { name: "Secret reference: Search API key", exact: true })
            .waitFor();
          const dialog = page.locator("openclaw-modal-dialog");
          const expectFailedDraft = async (message: string) => {
            await expect.poll(() => dialog.getByRole("alert").textContent()).toContain(message);
            expect(await dialog.isVisible()).toBe(true);
            expect(await identifier.inputValue()).toBe("/search/failed");
          };
          const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
          const save = dialog.getByRole("button", { name: "Save", exact: true });
          const identifier = dialog.getByLabel("Identifier", { exact: true });
          for (const [label, value] of Object.entries({
            Source: "file",
            Provider: "team",
            Identifier: "/search/apiKey",
          })) {
            expect(await dialog.getByLabel(label, { exact: true }).inputValue()).toBe(value);
          }
          await identifier.fill("/search/cancelled");
          await cancel.click();
          expect(await gateway.getRequests("config.set")).toHaveLength(0);
          await reference.click();
          expect(await identifier.inputValue()).toBe("/search/apiKey");
          await identifier.fill("/search/updated");
          await gateway.deferNext("config.set");
          await save.click();
          const request = await gateway.waitForRequest("config.set");
          expect(await dialog.isVisible()).toBe(true);
          expect(await cancel.isDisabled()).toBe(true);
          await page.keyboard.press("Escape");
          expect(await dialog.isVisible()).toBe(true);
          expect(
            await dialog.getByRole("button", { name: "Saving…", exact: true }).isDisabled(),
          ).toBe(true);
          const changedRef = { ...originalRef, id: "/search/updated" };
          expect(JSON.parse(String(asRecord(request.params).raw))).toEqual(
            configWithSearch({ ...searchConfig, apiKey: changedRef }),
          );
          await inspect(ref(changedRef.id), "mock-config-hash-1");
          await gateway.resolveDeferred("config.set");
          await dialog.waitFor({ state: "hidden" });
          expect(await gateway.getRequests("config.set")).toHaveLength(1);
          await page.reload();
          await reference.waitFor();
          await expect.poll(() => reference.isEnabled()).toBe(true);
          await reference.click();
          expect(await identifier.inputValue()).toBe("/search/updated");
          await identifier.fill("/search/failed");
          const writesBeforeFailure = (await gateway.getRequests("config.set")).length;
          await gateway.deferNext("config.set");
          await save.click();
          const uncertainWrite = await gateway.waitForRequest("config.set", {
            after: writesBeforeFailure,
          });
          await gateway.rejectDeferred("config.set", {
            code: width === 390 ? "INVALID_REQUEST" : "UNAVAILABLE",
            message: "Fixture write rejected",
          });
          await expectFailedDraft("Fixture write rejected");
          expect(await cancel.isEnabled()).toBe(true);
          if (width === 1174) {
            // Arm the failure and click in one task so a poll cannot consume Cancel's deferral.
            const readsBeforeCancel = await cancel.evaluate((button: HTMLButtonElement) => {
              const mock = (
                window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway }
              ).openclawControlUiE2eGateway;
              if (!mock) {
                throw new Error("Mock Gateway is not installed");
              }
              const reads = mock.findRequests("config.get").length;
              mock.deferNext("config.get");
              button.click();
              return reads;
            });
            await gateway.waitForRequest("config.get", { after: readsBeforeCancel });
            await gateway.rejectDeferred("config.get", {
              code: "UNAVAILABLE",
              message: "Fixture config read unavailable",
            });
            await expectFailedDraft("Fixture config read unavailable");
            await cancel.click();
            await expectFailedDraft("The last save could not be confirmed");
            expect(await gateway.getRequests("config.set")).toHaveLength(writesBeforeFailure + 1);
            // A successful old snapshot cannot fence the unknown write. Its later
            // persisted bytes let Cancel reconcile without restoring the older reference.
            await gateway.setMethodResponse(
              "config.get",
              configSnapshot(
                JSON.parse(String(asRecord(uncertainWrite.params).raw)),
                "confirmed-credential-write",
              ),
            );
            await inspect(ref("/search/failed"), "confirmed-credential-write");
          }
          await cancel.click();
          await dialog.waitFor({ state: "hidden" });
          const writesBeforeSibling = (await gateway.getRequests("config.set")).length;
          const mode = page.locator('input[aria-label$="Search mode"]');
          await mode.fill("llm-context");
          await mode.press("Tab");
          const siblingWrite = await gateway.waitForRequest("config.set", {
            after: writesBeforeSibling,
          });
          expect(JSON.parse(String(asRecord(siblingWrite.params).raw))).toEqual(
            configWithSearch({
              ...searchConfig,
              apiKey: width === 1174 ? { ...originalRef, id: "/search/failed" } : changedRef,
              mode: "llm-context",
            }),
          );
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
        },
      ),
  );
});
