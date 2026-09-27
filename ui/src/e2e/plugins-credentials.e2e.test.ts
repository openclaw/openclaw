import path from "node:path";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { REDACTED_SENTINEL } from "../lib/config-form-utils.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
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
const originalRef = { source: "file", provider: "team", id: "/search/apiKey" };
const sourceConfig = {
  plugins: {
    entries: {
      workboard: {
        enabled: true,
        config: {
          search: {
            apiKey: originalRef,
            mode: "web",
            otherSecret: REDACTED_SENTINEL,
          },
        },
      },
    },
  },
};
const schema = {
  type: "object",
  properties: {
    plugins: {
      type: "object",
      properties: {
        entries: {
          type: "object",
          properties: {
            workboard: {
              type: "object",
              properties: {
                config: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    search: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        apiKey: { type: ["string", "object"] },
                        mode: { type: "string" },
                        otherSecret: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
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
    async ({ width, readOnly, literal, missing }) => {
      await suite.withPage(
        { colorScheme: "dark", viewport: { width, height: 900 } },
        async ({ page }) => {
          const proofDir =
            process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
              ? createControlUiE2eArtifactDir(`plugin-credentials-${width}-${readOnly}`)
              : undefined;
          const initial = structuredClone(sourceConfig);
          if (literal) {
            Object.assign(initial.plugins.entries.workboard.config.search, {
              apiKey: REDACTED_SENTINEL,
            });
          }
          if (missing) {
            Reflect.deleteProperty(initial.plugins.entries.workboard.config.search, "apiKey");
          }
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
                baseHash: configMocks["config.get"].hash,
                credential: missing
                  ? { kind: "missing" }
                  : literal
                    ? { kind: "literal" }
                    : { kind: "reference", ref: originalRef, unresolved: false },
              },
              "config.get": {
                ...configMocks["config.get"],
                config: initial,
                raw: JSON.stringify(initial),
              },
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
          await page.goto(`${suite.server.baseUrl}settings/plugins/workboard?view=settings`);
          await page.locator("openclaw-plugin-settings-editor").waitFor();
          if (literal || missing) {
            const input = page.getByLabel("Search API key", { exact: true });
            await input.waitFor();
            expect(await input.inputValue()).toBe("");
            expect(await input.getAttribute("type")).toBe("password");
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
            const reveal = page.getByRole("button", {
              name: "Show API key: Search API key",
              exact: true,
            });
            await expect
              .poll(async () => (await gateway.getRequests("plugins.credentials.inspect")).length)
              .toBe(1);
            expect(
              (await gateway.getRequests("plugins.credentials.inspect"))[0]?.params,
            ).not.toHaveProperty("reveal");
            if (literal) {
              await gateway.setMethodResponse("plugins.credentials.inspect", {
                baseHash: configMocks["config.get"].hash,
                credential: { kind: "literal", value: "synthetic-stored-key" },
              });
              await reveal.click();
              await expect.poll(() => input.inputValue()).toBe("synthetic-stored-key");
              expect(
                (await gateway.getRequests("plugins.credentials.inspect")).at(-1)?.params,
              ).toMatchObject({
                pluginId: "workboard",
                path: credentialPath,
                baseHash: configMocks["config.get"].hash,
                reveal: true,
              });
              await page
                .getByRole("button", { name: "Hide API key: Search API key", exact: true })
                .click();
              expect(await input.inputValue()).toBe("");
              expect(await gateway.getRequests("config.set")).toHaveLength(0);
            } else {
              expect(await reveal.isDisabled()).toBe(true);
              expect(await input.getAttribute("placeholder")).toBe("demo-key");
            }
            await input.fill("synthetic-new-key");
            await page
              .getByRole("button", { name: "Show API key: Search API key", exact: true })
              .click();
            expect(await input.getAttribute("type")).toBe("text");
            await page
              .getByRole("button", { name: "Hide API key: Search API key", exact: true })
              .click();
            await gateway.deferNext("config.set");
            await input.press("Enter");
            const request = await gateway.waitForRequest("config.set");
            expect(JSON.parse(String(asRecord(request.params).raw))).toEqual({
              plugins: {
                entries: {
                  workboard: {
                    enabled: true,
                    config: {
                      search: {
                        ...initial.plugins.entries.workboard.config.search,
                        apiKey: "synthetic-new-key",
                      },
                    },
                  },
                },
              },
            });
            expect(await input.isDisabled()).toBe(true);
            await gateway.setMethodResponse("plugins.credentials.inspect", {
              baseHash: "mock-config-hash-1",
              credential: { kind: "literal" },
            });
            await gateway.resolveDeferred("config.set");
            await expect.poll(() => input.inputValue()).toBe("");
            expect(await gateway.getRequests("config.set")).toHaveLength(1);
            await page.reload();
            await input.waitFor();
            expect(await input.inputValue()).toBe("");
            expect(await input.getAttribute("type")).toBe("password");
            return;
          }
          const reference = page.getByRole("button", {
            name: "Edit reference: Search API key",
            exact: true,
          });
          await reference.waitFor();
          const other = page.locator('input[aria-label$="Other secret"]');
          expect(await other.getAttribute("type")).toBe("password");
          expect(await other.inputValue()).toBe("");
          expect(await page.locator('input[aria-label$="Search mode"]').inputValue()).toBe("web");
          expect(
            await page
              .getByRole("button", { name: "Edit reference: Search API key", exact: true })
              .count(),
          ).toBe(1);
          expect(await page.locator("body").textContent()).not.toContain(REDACTED_SENTINEL);
          if (readOnly) {
            expect(await reference.isDisabled()).toBe(true);
            expect(await gateway.getRequests("plugins.credentials.inspect")).toHaveLength(0);
            expect(await gateway.getRequests("config.set")).toHaveLength(0);
            return;
          }
          await expect.poll(() => reference.isEnabled()).toBe(true);
          if (proofDir) {
            await page.screenshot({
              path: path.join(proofDir, "settings.png"),
              animations: "disabled",
            });
          }
          await reference.click();
          await page
            .getByRole("dialog", { name: "Secret reference: Search API key", exact: true })
            .waitFor();
          const dialog = page.locator("openclaw-modal-dialog");
          expect(await dialog.getByLabel("Source", { exact: true }).inputValue()).toBe("file");
          expect(await dialog.getByLabel("Provider", { exact: true }).inputValue()).toBe("team");
          const identifier = dialog.getByLabel("Identifier", { exact: true });
          expect(await identifier.inputValue()).toBe("/search/apiKey");
          if (proofDir) {
            await page.screenshot({
              path: path.join(proofDir, "reference.png"),
              animations: "disabled",
            });
          }
          await identifier.fill("/search/cancelled");
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
          expect(await gateway.getRequests("config.set")).toHaveLength(0);
          await reference.click();
          expect(await identifier.inputValue()).toBe("/search/apiKey");
          await identifier.fill("/search/updated");
          await gateway.deferNext("config.set");
          await dialog.getByRole("button", { name: "Save", exact: true }).click();
          const request = await gateway.waitForRequest("config.set");
          expect(await dialog.isVisible()).toBe(true);
          expect(
            await dialog.getByRole("button", { name: "Cancel", exact: true }).isDisabled(),
          ).toBe(true);
          await page.keyboard.press("Escape");
          expect(await dialog.isVisible()).toBe(true);
          expect(
            await dialog.getByRole("button", { name: "Saving…", exact: true }).isDisabled(),
          ).toBe(true);
          const changedRef = { ...originalRef, id: "/search/updated" };
          expect(JSON.parse(String(asRecord(request.params).raw))).toEqual({
            plugins: {
              entries: {
                workboard: {
                  enabled: true,
                  config: {
                    search: {
                      ...sourceConfig.plugins.entries.workboard.config.search,
                      apiKey: changedRef,
                    },
                  },
                },
              },
            },
          });
          await gateway.setMethodResponse("plugins.credentials.inspect", {
            baseHash: "mock-config-hash-1",
            credential: { kind: "reference", ref: changedRef, unresolved: false },
          });
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
          await dialog.getByRole("button", { name: "Save", exact: true }).click();
          const uncertainWrite = await gateway.waitForRequest("config.set", {
            after: writesBeforeFailure,
          });
          await gateway.rejectDeferred("config.set", {
            code: width === 390 ? "INVALID_REQUEST" : "UNAVAILABLE",
            message: "Fixture write rejected",
          });
          await expect
            .poll(() => dialog.getByRole("alert").textContent())
            .toContain("Fixture write rejected");
          expect(await identifier.inputValue()).toBe("/search/failed");
          expect(
            await dialog.getByRole("button", { name: "Cancel", exact: true }).isEnabled(),
          ).toBe(true);
          if (width === 1174) {
            // Arm the failure and click in one task so a poll cannot consume Cancel's deferral.
            const readsBeforeCancel = await dialog
              .getByRole("button", { name: "Cancel", exact: true })
              .evaluate((button: HTMLButtonElement) => {
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
            await expect
              .poll(() => dialog.getByRole("alert").textContent())
              .toContain("Fixture config read unavailable");
            expect(await dialog.isVisible()).toBe(true);
            expect(await identifier.inputValue()).toBe("/search/failed");
            await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
            await expect
              .poll(() => dialog.getByRole("alert").textContent())
              .toContain("The last save could not be confirmed");
            expect(await dialog.isVisible()).toBe(true);
            expect(await identifier.inputValue()).toBe("/search/failed");
            expect(await gateway.getRequests("config.set")).toHaveLength(writesBeforeFailure + 1);
            // A successful old snapshot cannot fence the unknown write. Its later
            // persisted bytes let Cancel reconcile without restoring the older reference.
            const confirmedRaw = String(asRecord(uncertainWrite.params).raw);
            await gateway.setMethodResponse("config.get", {
              ...configMocks["config.get"],
              config: JSON.parse(confirmedRaw),
              raw: confirmedRaw,
              hash: "confirmed-credential-write",
            });
            await gateway.setMethodResponse("plugins.credentials.inspect", {
              baseHash: "confirmed-credential-write",
              credential: {
                kind: "reference",
                ref: { ...originalRef, id: "/search/failed" },
                unresolved: false,
              },
            });
          }
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
          await dialog.waitFor({ state: "hidden" });
          const writesBeforeSibling = (await gateway.getRequests("config.set")).length;
          const mode = page.locator('input[aria-label$="Search mode"]');
          await mode.fill("llm-context");
          await mode.press("Tab");
          const siblingWrite = await gateway.waitForRequest("config.set", {
            after: writesBeforeSibling,
          });
          expect(JSON.parse(String(asRecord(siblingWrite.params).raw))).toEqual({
            plugins: {
              entries: {
                workboard: {
                  enabled: true,
                  config: {
                    search: {
                      ...sourceConfig.plugins.entries.workboard.config.search,
                      apiKey:
                        width === 1174 ? { ...originalRef, id: "/search/failed" } : changedRef,
                      mode: "llm-context",
                    },
                  },
                },
              },
            },
          });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
        },
      );
    },
  );
});
