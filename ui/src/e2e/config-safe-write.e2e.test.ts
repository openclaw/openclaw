// Control UI browser proof covers the config snapshot and guarded-write lifecycle.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import {
  objectSchema,
  configSnapshot,
  configSchema,
  pageRunner,
  configProof,
  settingsRow,
  settingsPageOptions,
  createConfigSuite,
} from "./config-composer-fixtures.test-support.ts";

const suite = createConfigSuite("Control UI guarded config writes mocked Gateway E2E");

const proof = configProof("config-safe-write");

function configResponse(config: Record<string, unknown>, hash: string, appliedConfigHash = hash) {
  return {
    ...configSnapshot(config, hash, true),
    appliedConfigHash,
    raw: JSON.stringify(config, null, 2),
  };
}

function configSchemaResponse() {
  return configSchema(
    objectSchema("", {
      laboratory: objectSchema("Safe writes", {
        endpoint: {
          type: "string",
          title: "Endpoint",
          description: "Endpoint selected by the operator.",
        },
        retryBudget: { type: "integer", title: "Retry budget", minimum: 0, maximum: 10 },
      }),
      tools: objectSchema(
        "Tools",
        {
          elevated: objectSchema("", {
            allowFrom: {
              type: "object",
              additionalProperties: {
                type: "array",
                items: { anyOf: [{ type: "string", pattern: "^[0-9]+$" }, { type: "number" }] },
              },
            },
          }),
        },
        { additionalProperties: true },
      ),
    }),
    { "laboratory.endpoint": { advanced: false }, "laboratory.retryBudget": { advanced: false } },
  );
}

function laboratoryConfig(endpoint: string, retryBudget = 2) {
  return { laboratory: { endpoint, retryBudget }, tools: {} };
}

async function installConfig(page: Page, config: Record<string, unknown>, hash: string) {
  return installMockGateway(page, {
    methodResponses: {
      "config.get": configResponse(config, hash),
      "config.schema": configSchemaResponse(),
    },
  });
}

type MutationParams = {
  baseHash?: string;
  note?: string;
  raw?: string;
  sessionKey?: string;
};
function mutationParams(request: MockGatewayRequest): MutationParams {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`Expected ${request.method} mutation params`);
  }
  return params as MutationParams;
}

const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const expectSaveStatus = (page: Page, status: string) =>
  expect
    .poll(() => page.locator("openclaw-settings-save-indicator").textContent())
    .toContain(status);
const requestCount = async (gateway: Awaited<ReturnType<typeof installConfig>>, method: string) =>
  (await gateway.getRequests(method)).length;

async function openLaboratory(page: Page, endpoint: string, checkStatus = false) {
  const response = await page.goto(`${suite.server.baseUrl}settings/advanced?section=laboratory`);
  if (checkStatus) {
    expect(response?.status()).toBe(200);
  }
  const field = page.getByRole("textbox", { name: "Endpoint", exact: true });
  await expect.poll(() => field.inputValue()).toBe(endpoint);
  return field;
}

async function reconnect(gateway: Awaited<ReturnType<typeof installConfig>>, before: number) {
  await gateway.setOnline(false);
  await gateway.setOnline(true);
  await expect.poll(() => requestCount(gateway, "config.get")).toBe(before + 1);
}

function overlapArea(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
): number {
  const width = Math.max(
    0,
    Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x),
  );
  const height = Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y),
  );
  return width * height;
}

async function expectSeparateControls(first: Locator, second: Locator) {
  const [firstBounds, secondBounds] = await Promise.all([
    first.boundingBox(),
    second.boundingBox(),
  ]);
  expect(firstBounds).not.toBeNull();
  expect(secondBounds).not.toBeNull();
  if (!firstBounds || !secondBounds) {
    throw new Error("Expected visible settings footer controls");
  }
  expect(overlapArea(firstBounds, secondBounds)).toBe(0);
}

async function capture(page: Page, name: string, content: Locator): Promise<void> {
  if (!proof.enabled) {
    return;
  }
  await writeFile(
    path.join(proof.directory(), name),
    await takeControlUiViewportScreenshot(page, page.locator(".shell"), [content]),
  );
}

const withPage = pageRunner(suite, () => ({
  ...settingsPageOptions,
  recordVideo: proof.enabled
    ? { dir: proof.directory(), size: { height: 1000, width: 1440 } }
    : undefined,
}));

suite.define(() => {
  it("keeps autosaves silent and preserves untouched 64-bit identifiers through reload", async () => {
    await withPage(async ({ page }) => {
      const identifier = "1048113311314608148";
      const initialConfig = {
        ...laboratoryConfig("before-save"),
        tools: { elevated: { allowFrom: { discord: [identifier, 42] } } },
      };
      const gateway = await installConfig(page, initialConfig, "id-snapshot-1");
      const endpoint = await openLaboratory(page, "before-save", true);
      await capture(page, "08-id-before-unrelated-save.png", endpoint);

      await gateway.deferNext("config.set");
      await endpoint.fill("after-save");
      const save = mutationParams(await gateway.waitForRequest("config.set"));
      const submitted = JSON.parse(String(save.raw)) as typeof initialConfig;
      expect(save.baseHash).toBe("id-snapshot-1");
      expect(String(save.raw)).toContain(`"${identifier}"`);
      expect(String(save.raw)).not.toContain(String(Number(identifier)));
      expect(submitted).toEqual({
        laboratory: { endpoint: "after-save", retryBudget: 2 },
        tools: { elevated: { allowFrom: { discord: [identifier, 42] } } },
      });
      expect(submitted.tools.elevated.allowFrom.discord[0]).toBe(identifier);
      expect(typeof submitted.tools.elevated.allowFrom.discord[0]).toBe("string");
      if (proof.enabled) {
        await writeFile(
          path.join(proof.directory(), "09-id-config-set-payload.json"),
          `${JSON.stringify({ before: initialConfig, submitted }, null, 2)}\n`,
        );
      }

      const indicator = page.locator("openclaw-settings-save-indicator");
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 1366, height: 768 },
        { width: 768, height: 1024 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        await capture(page, `quiet-autosave-${viewport.width}.png`, endpoint);
        expect.soft(await indicator.textContent()).toBe("");
        expect.soft(await indicator.getByRole("status").count()).toBe(0);
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await gateway.resolveDeferred("config.set");
      await expectSaveStatus(page, "Apply changes");
      expect(await indicator.textContent()).not.toMatch(/Saving|Saved/u);
      await page.reload();
      await expect.poll(() => endpoint.inputValue()).toBe("after-save");
      await button(page, "Raw").click();
      const rawEditor = page.locator(".config-raw-field textarea");
      await rawEditor.waitFor();
      await expect.poll(() => rawEditor.inputValue()).toContain(`"${identifier}"`);
      await capture(page, "10-id-after-unrelated-save.png", rawEditor);
    });
  });

  it.each([
    {
      name: "authored activation and limits",
      initialMode: { enabled: "auto", timeoutMs: 5000 },
      expectedPatch: { executor: "quickjs" },
    },
    {
      name: "inherited automatic activation",
      initialMode: undefined,
      expectedPatch: { enabled: "auto", executor: "quickjs" },
    },
  ])(
    "saves and reloads the Code Mode executor with $name",
    async ({ initialMode, expectedPatch }) => {
      await withPage(
        async ({ page }) => {
          const initialConfig = initialMode ? { tools: { codeMode: initialMode } } : {};
          const retainedMode = { enabled: "auto", ...initialMode };
          const quickjsConfig = {
            tools: { codeMode: { ...retainedMode, executor: "quickjs" } },
          };
          const gateway = await installMockGateway(page, {
            methodResponses: {
              "config.get": configResponse(initialConfig, "executor-node"),
            },
          });

          expect((await page.goto(`${suite.server.baseUrl}settings/labs`))?.status()).toBe(200);
          const executorRow = settingsRow(page, "Code Mode executor");
          const executor = executorRow.getByRole("combobox", { name: "Code Mode executor" });
          const enabled = settingsRow(page, "Code Mode").getByRole("switch", {
            name: "Code Mode",
            exact: true,
          });
          await expect.poll(() => executor.inputValue()).toBe("node");
          expect(await executorRow.textContent()).toContain("not a security sandbox");
          expect(await enabled.isChecked()).toBe(true);
          await capture(page, "code-mode-node-default.png", executor);

          await gateway.deferNext("config.patch");
          await executor.selectOption("quickjs");
          const quickjsPatch = mutationParams(await gateway.waitForRequest("config.patch"));
          expect(quickjsPatch.baseHash).toBe("executor-node");
          expect(JSON.parse(String(quickjsPatch.raw))).toEqual({
            tools: { codeMode: expectedPatch },
          });
          expect(await executor.isDisabled()).toBe(true);

          const quickjsResponse = configResponse(quickjsConfig, "executor-quickjs");
          await gateway.setMethodResponse("config.get", quickjsResponse);
          await gateway.resolveDeferred("config.patch", { ok: true, ...quickjsResponse });
          await expect.poll(() => executor.isDisabled()).toBe(false);
          expect((await page.reload())?.status()).toBe(200);
          await expect.poll(() => executor.inputValue()).toBe("quickjs");
          expect(await enabled.isChecked()).toBe(true);
          await capture(page, "code-mode-quickjs-reloaded.png", executor);

          const priorPatches = (await gateway.getRequests("config.patch")).length;
          await gateway.deferNext("config.patch");
          await executor.selectOption("node");
          const nodePatch = mutationParams(
            await gateway.waitForRequest("config.patch", { after: priorPatches }),
          );
          expect(nodePatch.baseHash).toBe("executor-quickjs");
          expect(JSON.parse(String(nodePatch.raw))).toEqual({
            tools: { codeMode: { executor: null } },
          });

          const nodeResponse = configResponse(
            { tools: { codeMode: retainedMode } },
            "executor-node-restored",
          );
          await gateway.setMethodResponse("config.get", nodeResponse);
          await gateway.resolveDeferred("config.patch", { ok: true, ...nodeResponse });
          await expect.poll(() => executor.isDisabled()).toBe(false);
          expect((await page.reload())?.status()).toBe(200);
          await expect.poll(() => executor.inputValue()).toBe("node");
          expect(await enabled.isChecked()).toBe(true);
        },
        { recordVideo: undefined },
      );
    },
  );

  it("retains a Raw revert when an autosave commits after its connection closes", async () => {
    await withPage(async ({ page }) => {
      const initialConfig = laboratoryConfig("original-api");
      const gateway = await installConfig(page, initialConfig, "revision-original");
      const endpoint = await openLaboratory(page, "original-api");
      await button(page, "Raw").click();
      const raw = page.locator(".config-raw-field textarea");
      const originalRaw = await raw.inputValue();
      await button(page, "Form").click();

      await gateway.deferNext("config.set");
      await endpoint.fill("committed-api");
      const submitted = mutationParams(await gateway.waitForRequest("config.set"));
      expect(JSON.parse(String(submitted.raw))).toMatchObject({
        laboratory: { endpoint: "committed-api" },
      });
      await button(page, "Raw").click();
      await raw.fill(originalRaw);
      await capture(page, "14-lost-ack-raw-revert.png", raw);

      const getsBeforeReconnect = (await gateway.getRequests("config.get")).length;
      await gateway.setOnline(false);
      // Commit through the stateful mock after closing the socket: its late
      // acknowledgment is dropped, but reconnect must observe the saved revision.
      await gateway.resolveDeferred("config.set");
      await gateway.setOnline(true);
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBe(getsBeforeReconnect + 1);
      await expect.poll(() => raw.isEnabled()).toBe(true);
      await capture(page, "15-lost-ack-retained-draft.png", raw);
      expect(await raw.inputValue()).toBe(originalRaw);
      expect(await gateway.getRequests("config.set")).toHaveLength(1);

      const saveButton = page.getByRole("button", { name: "Save", exact: true });
      await expect.poll(() => saveButton.isEnabled()).toBe(true);
      await gateway.deferNext("config.set");
      await saveButton.click();
      const saved = mutationParams(await gateway.waitForRequest("config.set", { after: 1 }));
      expect(saved.baseHash).toBe("mock-config-hash-1");
      expect(saved.raw).toBe(originalRaw);
      await gateway.resolveDeferred("config.set");
      await expect.poll(() => saveButton.isEnabled()).toBe(false);
      await expect
        .poll(() => page.getByRole("button", { name: "Apply changes", exact: true }).count())
        .toBe(1);
      await page.reload();
      await expect.poll(() => endpoint.inputValue()).toBe("original-api");
      await capture(page, "16-lost-ack-explicit-save-reload.png", endpoint);
    });
  });

  it("preserves a refreshed external edit after reverting a retained Raw draft", async () => {
    await withPage(async ({ page }) => {
      const initialConfig = laboratoryConfig("original-api");
      const gateway = await installConfig(page, initialConfig, "revision-original");
      const endpoint = await openLaboratory(page, "original-api");
      await button(page, "Raw").click();
      const raw = page.locator(".config-raw-field textarea");
      const originalRaw = await raw.inputValue();
      await raw.fill(originalRaw.replace("original-api", "unsaved-api"));

      const getsBeforeReconnect = (await gateway.getRequests("config.get")).length;
      await gateway.setMethodResponse(
        "config.get",
        configResponse(
          { ...initialConfig, laboratory: { endpoint: "external-api", retryBudget: 2 } },
          "revision-external",
        ),
      );
      await reconnect(gateway, getsBeforeReconnect);
      await expect.poll(() => raw.isEnabled()).toBe(true);
      await raw.fill(originalRaw);
      await button(page, "Form").click();
      await endpoint.waitFor();
      await capture(page, "12-reconnect-raw-revert.png", endpoint);
      expect.soft(await endpoint.inputValue()).toBe("external-api");

      await gateway.deferNext("config.set");
      await page.getByRole("spinbutton", { name: "Retry budget", exact: true }).fill("3");
      const save = mutationParams(await gateway.waitForRequest("config.set"));
      expect(save.baseHash).toBe("revision-external");
      expect.soft(JSON.parse(String(save.raw))).toEqual({
        ...initialConfig,
        laboratory: { endpoint: "external-api", retryBudget: 3 },
      });
      await gateway.resolveDeferred("config.set");
      await expectSaveStatus(page, "Apply changes");
      await page.reload();
      await endpoint.waitFor();
      await capture(page, "13-reconnect-save-reload.png", endpoint);
      expect(await endpoint.inputValue()).toBe("external-api");
    });
  });

  it("restores form values when a failed edit is reverted in Raw mode", async () => {
    await withPage(async ({ page }) => {
      const initialConfig = laboratoryConfig("saved-api");
      const gateway = await installConfig(page, initialConfig, "revert-snapshot");
      const endpoint = await openLaboratory(page, "saved-api");

      await gateway.deferNext("config.set");
      await endpoint.fill("discarded-api");
      await gateway.waitForRequest("config.set");
      await gateway.rejectDeferred("config.set", {
        code: "UNAVAILABLE",
        message: "QA configuration save failed",
      });
      const saveIndicator = page.locator("openclaw-settings-save-indicator");
      await expect.poll(() => saveIndicator.textContent()).toContain("Save failed");
      await button(page, "Raw").click();
      await page.locator(".config-raw-field textarea").fill(JSON.stringify(initialConfig, null, 2));
      await button(page, "Form").click();
      await endpoint.waitFor();
      await capture(page, "11-form-after-raw-revert.png", endpoint);
      expect.soft(await endpoint.inputValue()).toBe("saved-api");

      const previousSaves = (await gateway.getRequests("config.set")).length;
      await gateway.deferNext("config.set");
      await page.getByRole("spinbutton", { name: "Retry budget", exact: true }).fill("3");
      const save = mutationParams(
        await gateway.waitForRequest("config.set", { after: previousSaves }),
      );
      expect(save.baseHash).toBe("revert-snapshot");
      expect(JSON.parse(String(save.raw))).toEqual({
        ...initialConfig,
        laboratory: { endpoint: "saved-api", retryBudget: 3 },
      });
      await gateway.resolveDeferred("config.set");
      await expect.poll(() => saveIndicator.textContent()).toContain("Apply changes");
    });
  });

  it("edits schema and raw config with guarded set, patch, reload, and apply requests", async () => {
    await withPage(async ({ page }) => {
      const initialConfig = {
        ...laboratoryConfig("local-api"),
        tools: { codeMode: { timeoutMs: 5000 } },
      };
      const patchedConfig = {
        laboratory: initialConfig.laboratory,
        tools: { codeMode: { enabled: "auto", timeoutMs: 5000 } },
      };
      const gateway = await installConfig(page, initialConfig, "snapshot-1");

      expect((await page.goto(`${suite.server.baseUrl}settings/labs`))?.status()).toBe(200);
      const labsLink = page.locator('.settings-sidebar__item[href="/settings/labs"]');
      await expect.poll(() => labsLink.getAttribute("aria-current")).toBe("page");
      const codeModeRow = settingsRow(page, "Code Mode");
      const codeModeSwitch = codeModeRow.getByRole("switch", { name: "Code Mode", exact: true });
      await codeModeSwitch.waitFor();
      await expect.poll(() => codeModeRow.textContent()).not.toContain("Using default:");

      const configGetsBeforePatch = (await gateway.getRequests("config.get")).length;
      await gateway.deferNext("config.patch");
      await codeModeSwitch.click();
      const patchParams = mutationParams(await gateway.waitForRequest("config.patch"));
      expect(patchParams.baseHash).toBe("snapshot-1");
      expect(patchParams.sessionKey).toBe("agent:main:main");
      expect(JSON.parse(String(patchParams.raw))).toEqual({
        tools: { codeMode: { enabled: "auto" } },
      });

      const patchedResponse = configResponse(patchedConfig, "snapshot-2", "snapshot-1");
      await gateway.setMethodResponse("config.get", patchedResponse);
      await gateway.resolveDeferred("config.patch", {
        config: patchedConfig,
        hash: "snapshot-2",
        ok: true,
      });
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBe(configGetsBeforePatch);
      await expect.poll(() => codeModeRow.textContent()).toContain("Default: Disabled");
      await expect.poll(() => labsLink.getAttribute("aria-current")).toBe("page");
      await capture(page, "00-labs-canonical-refresh.png", codeModeSwitch);

      const endpoint = await openLaboratory(page, "local-api", true);
      const advancedLink = page.locator('.settings-sidebar__item[href="/settings/advanced"]');
      await expect.poll(() => advancedLink.getAttribute("aria-current")).toBe("page");

      await gateway.deferNext("config.set");
      await endpoint.fill("form-api");
      const staleSetParams = mutationParams(await gateway.waitForRequest("config.set"));
      expect(staleSetParams.baseHash).toBe("snapshot-2");
      expect(JSON.parse(String(staleSetParams.raw))).toMatchObject({
        laboratory: { endpoint: "form-api", retryBudget: 2 },
      });
      await gateway.rejectDeferred("config.set", {
        code: "INVALID_REQUEST",
        message: "config changed since last load; re-run config.get and retry",
      });

      const saveIndicator = page.locator("openclaw-settings-save-indicator");
      await expect.poll(() => saveIndicator.textContent()).toContain("Settings changed elsewhere");
      await expect
        .poll(() => saveIndicator.getByRole("button", { name: "Reload" }).count())
        .toBe(1);
      await capture(page, "01-base-hash-conflict.png", saveIndicator);

      const externalConfig = laboratoryConfig("external-api", 4);
      await gateway.setMethodResponse(
        "config.get",
        configResponse(externalConfig, "snapshot-3", "snapshot-1"),
      );
      const configGetsBeforeReload = (await gateway.getRequests("config.get")).length;
      await saveIndicator.getByRole("button", { name: "Reload" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBeGreaterThan(configGetsBeforeReload);
      await expect.poll(() => endpoint.inputValue()).toBe("external-api");

      const setRequestsBeforeRetry = (await gateway.getRequests("config.set")).length;
      const retriedSetRequest = gateway.waitForRequest("config.set", {
        after: setRequestsBeforeRetry,
      });
      await endpoint.fill("form-api");
      const retriedSetParams = mutationParams(await retriedSetRequest);
      expect(await gateway.getRequests("config.set")).toHaveLength(setRequestsBeforeRetry + 1);
      expect(retriedSetParams.baseHash).toBe("snapshot-3");
      expect(JSON.parse(String(retriedSetParams.raw))).toMatchObject({
        laboratory: { endpoint: "form-api", retryBudget: 4 },
      });
      await expect.poll(() => saveIndicator.textContent()).toContain("Apply changes");

      await button(page, "Raw").click();
      const rawEditor = page.locator(".config-raw-field textarea");
      await rawEditor.waitFor();
      const rawDraft = `{
  laboratory: {
    endpoint: "raw-api",
    retryBudget: 8,
  },
  tools: {},
}
`;
      const rawSave = page.getByRole("button", { name: "Save", exact: true });
      await rawEditor.fill(rawDraft);
      await expect
        .poll(async () => ({
          raw: await rawEditor.inputValue(),
          saveEnabled: await rawSave.isEnabled(),
        }))
        .toEqual({ raw: rawDraft, saveEnabled: true });
      await capture(page, "02-raw-draft.png", rawEditor);

      const setRequestsBeforeRawSave = (await gateway.getRequests("config.set")).length;
      const rawSetRequest = gateway.waitForRequest("config.set", {
        after: setRequestsBeforeRawSave,
      });
      await rawSave.click();
      const rawSetParams = mutationParams(await rawSetRequest);
      expect(await gateway.getRequests("config.set")).toHaveLength(setRequestsBeforeRawSave + 1);
      expect(rawSetParams.baseHash).toBe("mock-config-hash-1");
      expect(rawSetParams.raw).toBe(rawDraft);
      await expect
        .poll(() => page.getByRole("button", { name: "Apply changes", exact: true }).count(), {
          timeout: 5_000,
        })
        .toBe(1);
      await gateway.deferNext("config.apply");
      await page.getByRole("button", { name: "Apply changes", exact: true }).click();
      const applyParams = mutationParams(await gateway.waitForRequest("config.apply"));
      expect(applyParams.baseHash).toBe("mock-config-hash-2");
      expect(applyParams.raw).toBe(rawDraft);
      expect(applyParams.sessionKey).toBe("agent:main:main");
      await expect.poll(() => saveIndicator.textContent()).toContain("Applying");
      await capture(page, "03-applying.png", saveIndicator);

      const configGetsBeforeApply = (await gateway.getRequests("config.get")).length;
      await gateway.resolveDeferred("config.apply");
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBeGreaterThan(configGetsBeforeApply);
      await expect
        .poll(() => page.getByRole("button", { name: "Apply changes", exact: true }).count())
        .toBe(0);
      await expect.poll(() => rawEditor.inputValue()).toBe(rawDraft);
      await capture(page, "04-apply-complete.png", rawEditor);
    });
  });

  it("config.set refreshes config after reconnect and client replacement before the next save", async () => {
    await withPage(async ({ page }) => {
      const initialConfig = laboratoryConfig("initial-api");
      const gateway = await installConfig(page, initialConfig, "snapshot-initial");

      const endpoint = await openLaboratory(page, "initial-api", true);
      const initialConfigGets = (await gateway.getRequests("config.get")).length;

      await page.locator('.settings-sidebar__item[href="/settings/connection"]').click();
      await page.waitForURL(/\/settings\/connection$/u);
      const reconnectedConfig = laboratoryConfig("reconnected-api", 4);
      await gateway.setMethodResponse(
        "config.get",
        configResponse(reconnectedConfig, "snapshot-reconnected"),
      );
      await reconnect(gateway, initialConfigGets);

      await page.locator('.settings-sidebar__item[href="/settings/advanced"]').click();
      await page.waitForURL(/\/settings\/advanced/u);
      await expect.poll(() => endpoint.inputValue()).toBe("reconnected-api");
      await capture(page, "05-reconnected-config.png", endpoint);

      await page.locator('.settings-sidebar__item[href="/settings/connection"]').click();
      await page.waitForURL(/\/settings\/connection$/u);
      const replacementConfig = laboratoryConfig("replacement-api", 6);
      await gateway.setMethodResponse(
        "config.get",
        configResponse(replacementConfig, "snapshot-replacement"),
      );
      const configGetsBeforeReplacement = (await gateway.getRequests("config.get")).length;
      const connectsBeforeReplacement = (await gateway.getRequests("connect")).length;
      await page.getByRole("textbox", { name: "Gateway URL" }).fill("ws://127.0.0.1:19999");
      await page.getByRole("button", { name: "Apply and reconnect", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests("connect")).length)
        .toBe(connectsBeforeReplacement + 1);
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBe(configGetsBeforeReplacement + 1);

      await page.locator('.settings-sidebar__item[href="/settings/advanced"]').click();
      await page.waitForURL(/\/settings\/advanced/u);
      await expect.poll(() => endpoint.inputValue()).toBe("replacement-api");
      await gateway.deferNext("config.set");
      const setsBeforeEdit = (await gateway.getRequests("config.set")).length;
      await endpoint.fill("saved-on-replacement");
      const save = mutationParams(await gateway.waitForRequest("config.set"));
      expect(save.baseHash).toBe("snapshot-replacement");
      expect(JSON.parse(String(save.raw))).toEqual({
        laboratory: { endpoint: "saved-on-replacement", retryBudget: 6 },
        tools: {},
      });
      expect(await gateway.getRequests("config.set")).toHaveLength(setsBeforeEdit + 1);
      await gateway.resolveDeferred("config.set", {
        config: JSON.parse(String(save.raw)),
        hash: "snapshot-saved",
      });
      await expectSaveStatus(page, "Apply changes");
      await capture(page, "06-replacement-save.png", endpoint);
    });
  });

  it("config.set keeps a dirty draft and adopts an opaque revision after an unchanged reconnect", async () => {
    await withPage(async ({ page }) => {
      const config = laboratoryConfig("initial-api");
      const gateway = await installConfig(page, config, "legacy-raw-hash");

      const endpoint = await openLaboratory(page, "initial-api", true);
      await endpoint.fill("retained-draft");

      const getsBeforeReconnect = (await gateway.getRequests("config.get")).length;
      await gateway.setMethodResponse(
        "config.get",
        configResponse(config, "hmac-sha256:v1:opaque-current"),
      );
      await reconnect(gateway, getsBeforeReconnect);
      await expect.poll(() => endpoint.inputValue()).toBe("retained-draft");

      const saveIndicator = page.locator("openclaw-settings-save-indicator");
      await expect
        .poll(() => saveIndicator.textContent())
        .toContain("Autosave paused after reconnect");
      const saveButton = saveIndicator.getByRole("button", { name: "Save", exact: true });
      const buildLink = page.locator(".settings-sidebar__footer .sidebar-footer-build");
      await saveButton.focus();
      await expect
        .poll(() => saveButton.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await expectSeparateControls(saveButton, buildLink);
      expect(await buildLink.textContent()).not.toBe("");
      await capture(page, "07-opaque-revision-reconnect.png", saveButton);

      await page.setViewportSize({ height: 900, width: 1280 });
      await expectSeparateControls(saveButton, buildLink);
      await capture(page, "07-opaque-revision-reconnect-1280.png", saveButton);

      await gateway.deferNext("config.set");
      await saveButton.click();
      const save = mutationParams(await gateway.waitForRequest("config.set"));
      expect(save.baseHash).toBe("hmac-sha256:v1:opaque-current");
      expect(JSON.parse(String(save.raw))).toMatchObject({
        laboratory: { endpoint: "retained-draft", retryBudget: 2 },
      });
      await gateway.setMethodResponse(
        "config.get",
        configResponse(
          { ...config, laboratory: { ...config.laboratory, endpoint: "retained-draft" } },
          "hmac-sha256:v1:opaque-next",
        ),
      );
      await gateway.resolveDeferred("config.set", {
        config: JSON.parse(String(save.raw)),
        hash: "hmac-sha256:v1:opaque-next",
      });
      await expect.poll(() => endpoint.inputValue()).toBe("retained-draft");
    });
  });
});
