import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  installMockGateway,
  type MockGatewayRequest,
  waitForConfirmModal,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForSettledFormControls } from "./settle.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cloud workers settings mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const exactButton = (root: Page | Locator, name: string) =>
  root.getByRole("button", { name, exact: true });
const pendingRow = (page: Page) =>
  page.locator(".settings-row").filter({ has: page.locator("code", { hasText: /^pending$/ }) });
const profilesConfig = (profiles: Record<string, unknown>) => ({ cloudWorkers: { profiles } });
function profilePatch(backend: string, machineClass: string) {
  return {
    provider: "crabbox",
    install: "bundle",
    readyWorkers: null,
    suspendAfter: null,
    settings: {
      provider: backend,
      target: null,
      class: machineClass,
      ttl: "8h",
      idleTimeout: "45m",
      setup: null,
      setupEnv: null,
      warmImage: null,
      desktop: null,
      binary: null,
    },
  };
}

function configResponse(config: Record<string, unknown>, hash: string) {
  return {
    appliedConfigHash: hash,
    config,
    sourceConfig: config,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

function configuredCloudWorkerProfile(backend = "aws") {
  return {
    provider: "crabbox",
    install: "bundle",
    settings: {
      provider: backend,
      class: "standard",
      ttl: "8h",
      idleTimeout: "45m",
    },
  };
}

function requestRaw(request: MockGatewayRequest): Record<string, unknown> {
  if (!isRecord(request.params) || typeof request.params.raw !== "string") {
    throw new Error("Expected config.patch params");
  }
  const parsed: unknown = JSON.parse(request.params.raw);
  if (!isRecord(parsed)) {
    throw new Error("Expected config.patch raw object");
  }
  return parsed;
}

async function publishProfiles(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  profiles: Record<string, unknown>,
  hash: string,
) {
  const config = profilesConfig(profiles);
  await gateway.setMethodResponse("config.get", configResponse(config, hash));
  await gateway.resolveDeferred("config.patch", { ok: true, hash, config });
}

async function waitForConfigPatch(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  previousCount: number,
): Promise<Record<string, unknown>> {
  await expect.poll(() => gateway.getRequests("config.patch")).toHaveLength(previousCount + 1);
  const request = (await gateway.getRequests("config.patch"))[previousCount];
  if (!request) {
    throw new Error("Expected next config.patch request");
  }
  return requestRaw(request);
}

suite.define(() => {
  it("adds and edits advanced machine profiles while refreshing live availability", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1_000, width: 1_440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["config.patch", "environments.list"],
          methodResponses: {
            "config.get": configResponse({}, "cloud-workers-1"),
            "environments.list": { environments: [], profiles: [] },
          },
        });

        expect((await page.goto(`${suite.server.baseUrl}settings/cloud-workers`))?.status()).toBe(
          200,
        );
        const docsLink = page.getByRole("link", { name: "Docs", exact: true });
        await docsLink.waitFor();
        expect(await docsLink.getAttribute("href")).toBe(
          "https://docs.openclaw.ai/gateway/cloud-workers",
        );
        await page.locator(".cloud-environments__advanced > summary").click();
        await gateway.waitForRequest("environments.list");
        const socketCount = await gateway.getSocketCount();
        await page.getByText("No cloud worker profiles are configured.", { exact: true }).waitFor();

        await page.getByRole("button", { name: "Add profile" }).click();
        expect(
          await page.getByRole("combobox", { name: "Machine class", exact: true }).count(),
        ).toBe(0);
        await page.getByLabel("Profile ID").fill("build-fleet");
        await page.getByLabel("Crabbox backend").fill("hetzner");
        await waitForSettledFormControls(page, [
          { locator: page.getByLabel("Profile ID"), value: "build-fleet" },
          { locator: page.getByLabel("Crabbox backend"), value: "hetzner" },
        ]);
        const machineClass = page.getByRole("textbox", { name: "Machine class", exact: true });
        await expect.poll(() => machineClass.inputValue()).toBe("");
        expect(await machineClass.getAttribute("list")).toBeNull();
        expect(await page.locator("openclaw-cloud-workers-page datalist").count()).toBe(0);
        for (const invalidClass of ["", " ", "x".repeat(129)]) {
          await machineClass.fill(invalidClass);
          await waitForSettledFormControls(page, [{ locator: machineClass, value: invalidClass }]);
          await exactButton(page, "Save").click();
          await expect
            .poll(() => page.getByRole("alert").textContent())
            .toBe("Enter a machine class of 1 to 128 characters.");
          expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        }
        await machineClass.fill("standard");
        await waitForSettledFormControls(page, [{ locator: machineClass, value: "standard" }]);
        await gateway.deferNext("config.patch");
        const addRequestCount = (await gateway.getRequests("config.patch")).length;
        await exactButton(page, "Save").click();
        const addPatch = await waitForConfigPatch(gateway, addRequestCount);
        expect(addPatch).toEqual(
          profilesConfig({ "build-fleet": profilePatch("hetzner", "standard") }),
        );
        // The saved snapshot includes provider-owned fields absent from this editor.
        const buildFleet = {
          provider: "crabbox",
          install: "bundle",
          suspendAfter: "30m",
          settings: {
            provider: "hetzner",
            class: "standard",
            ttl: "8h",
            idleTimeout: "45m",
            region: "eu-west-1",
            resources: { cpu: 6, memoryGiB: 12 },
            providerOptions: { image: "qa-base" },
          },
        };
        // Keep the mocked config.get consistent with the patch response: the
        // config store may reconcile with a refetch, and a stale empty config
        // would flap the snapshot and silently drop the next save.
        await gateway.setMethodResponse(
          "config.get",
          configResponse(
            { cloudWorkers: { profiles: { "build-fleet": buildFleet } } },
            "cloud-workers-2",
          ),
        );
        await gateway.setMethodResponse("environments.list", {
          environments: [],
          profiles: [{ id: "build-fleet", providerId: "crabbox" }],
        });
        await gateway.resolveDeferred("config.patch", {
          ok: true,
          hash: "cloud-workers-2",
          config: { cloudWorkers: { profiles: { "build-fleet": buildFleet } } },
        });

        await page.getByText("Advertised", { exact: true }).waitFor();
        await page.getByText("Profile saved.", { exact: true }).waitFor();
        expect(await gateway.getSocketCount()).toBe(socketCount);

        await exactButton(page, "Edit: build-fleet").click();
        await expect.poll(() => machineClass.inputValue()).toBe("standard");
        await machineClass.fill("batch/ARM64.v2");
        await page.getByLabel("Crabbox backend").fill("daytona");
        await page.getByLabel("Max lifetime").fill("12h");
        await page
          .locator(".settings-row")
          .filter({ hasText: "Desktop" })
          .getByRole("switch")
          .click();
        await page.getByLabel("Crabbox binary").fill("/opt/bin/crabbox-draft");
        await page.getByLabel("Warm images", { exact: true }).selectOption("off");
        await page.getByLabel("Setup command", { exact: true }).fill("install-node");
        await page
          .getByLabel("Setup environment names", { exact: true })
          .fill("BUILD_TAG, CACHE_DIR");
        await page.getByLabel("Setup command", { exact: true }).fill("");
        await page.getByLabel("Setup command", { exact: true }).fill("install-node");
        await page.getByLabel("Ready workers", { exact: true }).fill("2");
        await page.getByLabel("Suspend after", { exact: true }).fill("2h");
        await waitForSettledFormControls(page, [
          { locator: machineClass, value: "batch/ARM64.v2" },
          { locator: page.getByLabel("Crabbox backend"), value: "daytona" },
          { locator: page.getByLabel("Max lifetime"), value: "12h" },
          {
            locator: page.getByRole("switch", { name: "Desktop", exact: true }),
            checked: true,
          },
          { locator: page.getByLabel("Crabbox binary"), value: "/opt/bin/crabbox-draft" },
          { locator: page.getByLabel("Warm images", { exact: true }), value: "off" },
          { locator: page.getByLabel("Setup command", { exact: true }), value: "install-node" },
          { locator: page.getByLabel("Setup environment names"), value: "BUILD_TAG, CACHE_DIR" },
          { locator: page.getByLabel("Ready workers", { exact: true }), value: "2" },
          { locator: page.getByLabel("Suspend after", { exact: true }), value: "2h" },
        ]);
        expect(
          await page.getByRole("combobox", { name: "Machine class", exact: true }).count(),
        ).toBe(0);
        expect(await machineClass.getAttribute("list")).toBeNull();
        const saveButton = exactButton(page, "Save");
        // Saved temporarily hides Apply changes; wait for the applied revision so
        // its background config.get cannot consume the notification refresh gate.
        await expect
          .poll(() =>
            evaluateControlUiContext(
              page,
              (application) => application.runtimeConfig.state.configSnapshot?.appliedConfigHash,
            ),
          )
          .toBe("cloud-workers-2");
        const configGetCount = (await gateway.getRequests("config.get")).length;
        await gateway.deferNext("config.get");
        await saveButton.focus();
        await gateway.emitGatewayEvent("config.changed", {
          path: "/tmp/openclaw.json",
          hash: "cloud-workers-2",
          ts: Date.now(),
        });
        await gateway.waitForRequest("config.get", { after: configGetCount });
        expect(await saveButton.isEnabled()).toBe(true);
        expect(await saveButton.evaluate((button) => button === document.activeElement)).toBe(true);
        expect(await machineClass.inputValue()).toBe("batch/ARM64.v2");
        await gateway.resolveDeferred(
          "config.get",
          configResponse(
            { cloudWorkers: { profiles: { "build-fleet": buildFleet } } },
            "cloud-workers-2",
          ),
        );
        await expect.poll(() => saveButton.isEnabled()).toBe(true);
        await gateway.deferNext("config.patch");
        const editRequestCount = (await gateway.getRequests("config.patch")).length;
        await saveButton.click();
        const editPatch = await waitForConfigPatch(gateway, editRequestCount);
        expect(editPatch).toEqual({
          cloudWorkers: {
            profiles: {
              "build-fleet": {
                provider: "crabbox",
                install: "bundle",
                readyWorkers: 2,
                suspendAfter: "2h",
                settings: {
                  provider: "daytona",
                  target: null,
                  class: "batch/ARM64.v2",
                  ttl: "12h",
                  idleTimeout: "45m",
                  setup: "install-node",
                  setupEnv: ["BUILD_TAG", "CACHE_DIR"],
                  warmImage: false,
                  desktop: true,
                  binary: "/opt/bin/crabbox-draft",
                },
              },
            },
          },
        });
        const editedFleet = {
          ...buildFleet,
          readyWorkers: 2,
          suspendAfter: "2h",
          settings: {
            ...buildFleet.settings,
            provider: "daytona",
            class: "batch/ARM64.v2",
            ttl: "12h",
            idleTimeout: "45m",
            setup: "install-node",
            setupEnv: ["BUILD_TAG", "CACHE_DIR"],
            warmImage: false,
            desktop: true,
            binary: "/opt/bin/crabbox-draft",
          },
        };
        // Keep the mocked config.get consistent with the patch response: the
        // config store may reconcile with a refetch, and a stale empty config
        // would flap the snapshot and silently drop the next save.
        await publishProfiles(gateway, { "build-fleet": editedFleet }, "cloud-workers-3");

        await page.getByText("Class: batch/ARM64.v2", { exact: false }).waitFor();
        await exactButton(page, "Edit: build-fleet").click();
        await waitForSettledFormControls(page, [
          { locator: machineClass, value: "batch/ARM64.v2" },
          { locator: page.getByLabel("Crabbox backend"), value: "daytona" },
          { locator: page.getByLabel("Crabbox binary"), value: "/opt/bin/crabbox-draft" },
        ]);
        await page.getByRole("button", { name: "Cancel" }).click();

        await page.getByRole("button", { name: "Add profile" }).click();
        await page.getByLabel("Profile ID").fill("pending");
        await page.getByLabel("Crabbox backend").fill("aws");
        await machineClass.fill("custom");
        await waitForSettledFormControls(page, [
          { locator: page.getByLabel("Profile ID"), value: "pending" },
          { locator: page.getByLabel("Crabbox backend"), value: "aws" },
          { locator: machineClass, value: "custom" },
        ]);
        await gateway.deferNext("config.patch");
        const pendingRequestCount = (await gateway.getRequests("config.patch")).length;
        await exactButton(page, "Save").click();
        const pendingPatch = await waitForConfigPatch(gateway, pendingRequestCount);
        expect(pendingPatch).toEqual(profilesConfig({ pending: profilePatch("aws", "custom") }));
        const pending = configuredCloudWorkerProfile();
        pending.settings.class = "custom";
        await publishProfiles(gateway, { "build-fleet": editedFleet, pending }, "cloud-workers-4");
        await page.getByText("Unavailable", { exact: true }).waitFor();
        await page
          .locator(".settings-row")
          .filter({
            has: page.locator("code", { hasText: /^pending$/ }),
          })
          .getByRole("button", { name: "Edit: pending", exact: true })
          .click();
        await expect.poll(() => machineClass.inputValue()).toBe("custom");
        await exactButton(page, "Cancel").click();
      },
    );
  });

  it("releases a retired profile save after reconnect while preserving the draft", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1_000, width: 1_440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["config.patch", "environments.list"],
          methodResponses: {
            "config.get": configResponse({}, "cloud-workers-reconnect-1"),
            "environments.list": { environments: [], profiles: [] },
          },
        });

        await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
        await page.locator(".cloud-environments__advanced > summary").click();
        await page.getByRole("button", { name: "Add profile" }).click();
        const editor = page.locator(".settings-section", {
          has: page.getByRole("heading", { name: "Add profile", exact: true }),
        });
        const profileId = page.getByLabel("Profile ID");
        const backend = page.getByLabel("Crabbox backend");
        await profileId.fill("reconnect-proof");
        await backend.fill("hetzner");
        await page.getByLabel("Machine class", { exact: true }).fill("standard");
        await waitForSettledFormControls(page, [
          { locator: profileId, value: "reconnect-proof" },
          { locator: backend, value: "hetzner" },
          { locator: page.getByLabel("Machine class", { exact: true }), value: "standard" },
        ]);

        await gateway.deferNext("config.patch");
        await exactButton(editor, "Save").click();
        await gateway.waitForRequest("config.patch");
        await expect.poll(() => profileId.isDisabled()).toBe(true);

        const socketCount = await gateway.getSocketCount();
        const configGetCount = (await gateway.getRequests("config.get")).length;
        await gateway.setMethodResponse(
          "config.get",
          configResponse({}, "cloud-workers-reconnect-2"),
        );
        await gateway.closeLatest(1012, "cloud worker save reconnect proof");
        await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
        await expect
          .poll(async () => (await gateway.getRequests("config.get")).length)
          .toBeGreaterThan(configGetCount);

        await expect.poll(() => profileId.isEnabled()).toBe(true);
        await expect.poll(() => backend.isEnabled()).toBe(true);
        await expect.poll(() => profileId.inputValue()).toBe("reconnect-proof");
        await expect.poll(() => backend.inputValue()).toBe("hetzner");
        await expect.poll(() => exactButton(editor, "Save").isEnabled()).toBe(true);
        await expect
          .poll(() => editor.getByRole("button", { name: "Cancel" }).isEnabled())
          .toBe(true);

        await gateway.resolveDeferred("config.patch", {
          ok: true,
          hash: "retired-cloud-workers-save",
          config: {},
        });
        await expect.poll(() => profileId.inputValue()).toBe("reconnect-proof");
        await expect.poll(() => page.getByText("Profile saved.", { exact: false }).count()).toBe(0);
        await expect.poll(() => page.getByRole("alert").count()).toBe(0);

        await gateway.deferNext("config.patch");
        const retryRequestCount = (await gateway.getRequests("config.patch")).length;
        await exactButton(editor, "Save").click();
        const retryPatch = await waitForConfigPatch(gateway, retryRequestCount);
        expect(retryPatch).toMatchObject({
          cloudWorkers: {
            profiles: {
              "reconnect-proof": {
                provider: "crabbox",
                settings: { provider: "hetzner" },
              },
            },
          },
        });
        const savedProfile = configuredCloudWorkerProfile("hetzner");
        await publishProfiles(
          gateway,
          { "reconnect-proof": savedProfile },
          "cloud-workers-reconnect-3",
        );
        await page.getByText("Profile saved.", { exact: true }).waitFor();
        await expect.poll(() => page.getByLabel("Profile ID").count()).toBe(0);
      },
    );
  });

  it.each([
    {
      name: "provider replacement",
      replacement: {
        provider: "static-ssh",
        install: "bundle",
        settings: {
          host: "worker.example.test",
          user: "openclaw",
          keyRef: { source: "env", provider: "default", id: "QA_PRIVATE_KEY" },
        },
      },
      description: "Provider: static-ssh",
      replacePaths: undefined,
    },
    {
      name: "class removal",
      replacement: {
        provider: "crabbox",
        install: "bundle",
        settings: {
          provider: "hetzner",
          ttl: "8h",
          idleTimeout: "45m",
          warmImage: false,
          setup: "install-node",
          setupEnv: ["WORKER_ARTIFACT"],
        },
      },
      description: "Class: Unknown",
      replacePaths: ["cloudWorkers.profiles.pending.settings.setupEnv"],
    },
  ])(
    "config.set preserves Advanced edits after $name and deletes project defaults",
    async ({ replacement, description, replacePaths }) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const pending = configuredCloudWorkerProfile();
        const retained = configuredCloudWorkerProfile("hetzner");
        const retainedProjectProfiles = { "github.com/acme/retained": "retained" };
        const initialConfig = {
          cloudWorkers: {
            profiles: { pending, retained },
            projectProfiles: {
              "github.com/acme/app": "pending",
              "github.com/acme/docs": "pending",
              ...retainedProjectProfiles,
            },
          },
        };
        const gateway = await installMockGateway(page, {
          featureMethods: ["config.patch", "config.set", "config.schema", "environments.list"],
          methodResponses: {
            "config.get": configResponse(initialConfig, "cloud-workers-delete-1"),
            "config.schema": {
              version: "e2e",
              generatedAt: "2026-08-25T00:00:00.000Z",
              uiHints: {},
              schema: {
                type: "object",
                properties: {
                  cloudWorkers: {
                    type: "object",
                    properties: {
                      profiles: {
                        type: "object",
                        additionalProperties: { type: "object" },
                      },
                    },
                  },
                },
              },
            },
            "config.patch": {
              ok: true,
              hash: "cloud-workers-delete-2",
              config: {
                cloudWorkers: { profiles: { retained }, projectProfiles: retainedProjectProfiles },
              },
            },
            "environments.list": { environments: [], profiles: [] },
          },
        });

        await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
        await page.locator(".cloud-environments__advanced > summary").click();
        const row = pendingRow(page);
        await exactButton(row, "Edit: pending").click();
        const editor = page.locator(".settings-section", {
          has: page.getByRole("heading", { name: "Edit profile", exact: true }),
        });
        await expect.poll(() => page.getByLabel("Crabbox backend").inputValue()).toBe("aws");

        const replacedConfig = {
          cloudWorkers: {
            profiles: { pending: replacement, retained },
            projectProfiles: initialConfig.cloudWorkers.projectProfiles,
          },
        };
        const configGetCount = (await gateway.getRequests("config.get")).length;
        await gateway.setMethodResponse(
          "config.get",
          configResponse(replacedConfig, "cloud-workers-provider-replaced"),
        );
        await gateway.emitGatewayEvent("config.changed", {
          path: "/tmp/openclaw.json",
          hash: "cloud-workers-provider-replaced",
          ts: Date.now(),
        });
        await gateway.waitForRequest("config.get", { after: configGetCount });
        await row.getByText(description, { exact: false }).waitFor();
        const saveButton = exactButton(editor, "Save");
        await expect.poll(() => saveButton.isEnabled()).toBe(true);
        await saveButton.click();
        await expect
          .poll(() => editor.getByRole("alert").textContent())
          .toBe("This profile changed or was removed. Reload the page and try again.");
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        await editor.getByRole("button", { name: "Cancel" }).click();

        await exactButton(row, "Edit: pending").click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/advanced");
        await expect
          .poll(() => new URL(page.url()).searchParams.get("section"))
          .toBe("cloudWorkers");
        await gateway.waitForRequest("config.schema");
        await page.locator(".page-title").getByText("Advanced", { exact: true }).waitFor();
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        await exactButton(page, "Raw").click();
        const rawEditor = page.locator(".config-raw-field textarea");
        const savedConfig = {
          cloudWorkers: {
            ...replacedConfig.cloudWorkers,
            profiles: { pending: { ...replacement, suspendAfter: "1h" }, retained },
          },
        };
        await rawEditor.fill(JSON.stringify(savedConfig, null, 2));
        const rawSave = exactButton(page, "Save");
        await expect.poll(() => rawSave.isEnabled()).toBe(true);
        await gateway.deferNext("config.set");
        await rawSave.click();
        expect(requestRaw(await gateway.waitForRequest("config.set"))).toEqual(savedConfig);
        await gateway.setMethodResponse(
          "config.get",
          configResponse(savedConfig, "cloud-workers-raw-saved"),
        );
        await gateway.resolveDeferred("config.set", {
          ok: true,
          hash: "cloud-workers-raw-saved",
          config: savedConfig,
        });
        await expect.poll(() => rawSave.isDisabled()).toBe(true);
        expect(await gateway.getRequests("config.set")).toHaveLength(1);
        await page.reload();
        await exactButton(page, "Raw").click();
        await expect
          .poll(async () => JSON.parse(await rawEditor.inputValue()))
          .toEqual(savedConfig);
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
        await page.goBack();
        await page.locator(".cloud-environments__advanced > summary").click();
        await row.getByText(description, { exact: false }).waitFor();

        await exactButton(row, "Delete: pending").click();
        const confirmation = await waitForConfirmModal(page);
        await expect.poll(() => confirmation.textContent()).toContain("Delete profile pending?");
        await expect.poll(() => confirmation.textContent()).toContain("Repository defaults");
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        await exactButton(confirmation, "Delete").click();
        await expect.poll(async () => (await gateway.getRequests("config.patch")).length).toBe(1);
        const deleteRequest = (await gateway.getRequests("config.patch"))[0];
        if (!deleteRequest) {
          throw new Error("Expected delete config.patch request");
        }
        expect(requestRaw(deleteRequest)).toEqual({
          cloudWorkers: {
            profiles: { pending: null },
            projectProfiles: { "github.com/acme/app": null, "github.com/acme/docs": null },
          },
        });
        expect(isRecord(deleteRequest.params) && deleteRequest.params.replacePaths).toEqual(
          replacePaths,
        );
        await expect.poll(() => row.count()).toBe(0);
        await page.locator(".settings-row code", { hasText: /^retained$/ }).waitFor();
      });
    },
  );

  it("deletes a confirmed profile after the Gateway reconnects during confirmation", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const pending = configuredCloudWorkerProfile();
      const initialConfig = { cloudWorkers: { profiles: { pending } } };
      const gateway = await installMockGateway(page, {
        featureMethods: ["config.patch", "environments.list"],
        methodResponses: {
          "config.get": configResponse(initialConfig, "cloud-workers-delete-reconnect-1"),
          "config.patch": {
            ok: true,
            hash: "cloud-workers-delete-reconnect-3",
            config: { cloudWorkers: { profiles: {} } },
          },
          "environments.list": { environments: [], profiles: [] },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page.locator(".cloud-environments__advanced > summary").click();
      const row = pendingRow(page);
      await exactButton(row, "Delete: pending").click();
      const confirmation = await waitForConfirmModal(page);
      const socketCount = await gateway.getSocketCount();
      const configGetCount = (await gateway.getRequests("config.get")).length;
      await gateway.setMethodResponse(
        "config.get",
        configResponse(initialConfig, "cloud-workers-delete-reconnect-2"),
      );
      await gateway.closeLatest(1012, "cloud worker delete confirmation reconnect proof");
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBeGreaterThan(configGetCount);
      await expect.poll(() => exactButton(row, "Delete: pending").isEnabled()).toBe(true);

      await exactButton(confirmation, "Delete").click();

      await expect.poll(async () => (await gateway.getRequests("config.patch")).length).toBe(1);
      await expect.poll(() => row.count()).toBe(0);
    });
  });

  it("rejects a confirmed deletion after same-URL Gateway credentials replace its client", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const initialConfig = {
        cloudWorkers: { profiles: { pending: configuredCloudWorkerProfile() } },
      };
      const gateway = await installMockGateway(page, {
        featureMethods: ["config.patch", "environments.list"],
        methodResponses: {
          "config.get": configResponse(initialConfig, "cloud-workers-delete-client-replacement-1"),
          "config.patch": {
            ok: true,
            hash: "cloud-workers-delete-client-replacement-2",
            config: { cloudWorkers: { profiles: {} } },
          },
          "environments.list": { environments: [], profiles: [] },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page.locator(".cloud-environments__advanced > summary").click();
      const row = pendingRow(page);
      await exactButton(row, "Delete: pending").click();
      const confirmation = await waitForConfirmModal(page);
      const socketCount = await gateway.getSocketCount();
      const configGetCount = (await gateway.getRequests("config.get")).length;
      const originalGateway = await evaluateControlUiContext(page, (application) => {
        const activeGateway = application.gateway;
        const client = activeGateway.snapshot.client;
        if (!client) {
          throw new Error("Expected a connected Gateway client before confirmation");
        }
        const identity = {
          clientInstanceId: client.instanceId,
          gatewayUrl: activeGateway.connection.gatewayUrl,
        };
        activeGateway.connect({ token: "replacement-credential-proof" });
        return identity;
      });
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBeGreaterThan(configGetCount);
      await expect
        .poll(() =>
          evaluateControlUiContext(page, (application) => {
            const activeGateway = application.gateway;
            return {
              clientInstanceId: activeGateway.snapshot.client?.instanceId,
              gatewayUrl: activeGateway.connection.gatewayUrl,
              phase: activeGateway.snapshot.phase,
            };
          }),
        )
        .toMatchObject({ gatewayUrl: originalGateway.gatewayUrl, phase: "connected" });
      const replacementClientInstanceId = await evaluateControlUiContext(
        page,
        (application) => application.gateway.snapshot.client?.instanceId,
      );
      expect(replacementClientInstanceId).not.toBe(originalGateway.clientInstanceId);
      await expect.poll(() => exactButton(row, "Delete: pending").isEnabled()).toBe(true);

      await exactButton(confirmation, "Delete").click();

      await expect
        .poll(async () => ({
          alerts: await page.getByRole("alert").count(),
          patches: (await gateway.getRequests("config.patch")).length,
        }))
        .not.toEqual({ alerts: 0, patches: 0 });
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await expect
        .poll(async () => page.getByRole("alert").textContent())
        .toBe("The profile was not deleted. Reload the config and try again.");
      await row.waitFor();
    });
  });

  it("reports a confirmed deletion that cannot run while Gateway config is reconnecting", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const initialConfig = {
        cloudWorkers: { profiles: { pending: configuredCloudWorkerProfile() } },
      };
      const gateway = await installMockGateway(page, {
        featureMethods: ["config.patch", "environments.list"],
        methodResponses: {
          "config.get": configResponse(initialConfig, "cloud-workers-delete-offline-1"),
          "environments.list": { environments: [], profiles: [] },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page.locator(".cloud-environments__advanced > summary").click();
      const row = pendingRow(page);
      await exactButton(row, "Delete: pending").click();
      const confirmation = await waitForConfirmModal(page);
      const configGetCount = (await gateway.getRequests("config.get")).length;
      await gateway.deferNext("config.get");
      await gateway.closeLatest(1012, "cloud worker delete unavailable reconnect proof");
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBeGreaterThan(configGetCount);

      await exactButton(confirmation, "Delete").click();

      await expect
        .poll(async () => page.getByRole("alert").textContent())
        .toBe("The profile was not deleted. Reload the config and try again.");
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await row.waitFor();
    });
  });

  it("keeps profile mutations admin-scoped", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page, {
        operatorScopes: ["operator.read"],
        featureMethods: ["config.patch", "environments.list"],
        methodResponses: {
          "config.get": configResponse({}, "cloud-workers-read-only"),
          "environments.list": { environments: [], profiles: [] },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page.locator(".cloud-environments__advanced > summary").click();
      await page
        .getByText("Administrator access is required to manage cloud worker profiles.", {
          exact: true,
        })
        .waitFor();
      expect(await page.getByRole("button", { name: "Add profile" }).count()).toBe(0);
    });
  });
});
