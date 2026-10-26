import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { assert, expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  installMockGateway,
  type MockGatewayRequest,
  waitForConfirmModal,
} from "../test-helpers/control-ui-e2e.ts";
import {
  configSchema,
  configSnapshot,
  objectSchema,
} from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForSettledFormControls } from "./settle.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cloud workers settings mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const editorPageOptions = {
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 1_000, width: 1_440 },
} as const;
const exactButton = (root: Page | Locator, name: string) =>
  root.getByRole("button", { name, exact: true });
const pendingRow = (page: Page) =>
  page.locator(".settings-row").filter({ has: page.locator("code", { hasText: /^pending$/ }) });
type FormStep = [Locator, string, "select"?] | [Locator, boolean];
async function fillForm(page: Page, steps: FormStep[]) {
  const expected = new Map<Locator, Parameters<typeof waitForSettledFormControls>[1][number]>();
  for (const [locator, value, kind] of steps) {
    if (typeof value === "boolean") {
      await locator.click();
      expected.set(locator, { locator, checked: value });
    } else {
      if (kind === "select") {
        await locator.selectOption(value);
      } else {
        await locator.fill(value);
      }
      expected.set(locator, { locator, value });
    }
  }
  await waitForSettledFormControls(page, [...expected.values()]);
}
const profilesConfig = (profiles: Record<string, unknown>) => ({ cloudWorkers: { profiles } });
function profilePatch(backend: string, machineClass: string) {
  const profile = configuredCloudWorkerProfile(backend);
  return {
    ...profile,
    readyWorkers: null,
    suspendAfter: null,
    settings: {
      ...profile.settings,
      class: machineClass,
      target: null,
      setup: null,
      setupEnv: null,
      warmImage: null,
      desktop: null,
      binary: null,
    },
  };
}

type Scenario = NonNullable<Parameters<typeof installMockGateway>[1]>;
function workerGateway(
  page: Page,
  hash: string,
  config: Record<string, unknown> = {},
  extra: Scenario = {},
) {
  return installMockGateway(page, {
    featureMethods: ["config.patch", "environments.list"],
    ...extra,
    methodResponses: {
      "config.get": configResponse(config, hash),
      "environments.list": { environments: [], profiles: [] },
      ...extra.methodResponses,
    },
  });
}
function configResponse(config: Record<string, unknown>, hash: string) {
  return {
    ...configSnapshot(config, hash),
    appliedConfigHash: hash,
    sourceConfig: config,
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
  assert(
    isRecord(request.params) && typeof request.params.raw === "string",
    "Expected config.patch params",
  );
  const parsed: unknown = JSON.parse(request.params.raw);
  assert(isRecord(parsed), "Expected config.patch raw object");
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
  assert(request, "Expected next config.patch request");
  return requestRaw(request);
}

suite.define(() => {
  it("adds and edits advanced machine profiles while refreshing live availability", async () => {
    await suite.withPage(editorPageOptions, async ({ page }) => {
      const gateway = await workerGateway(page, "initial");

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
      expect(await page.getByRole("combobox", { name: "Machine class", exact: true }).count()).toBe(
        0,
      );
      await fillForm(page, [
        [page.getByLabel("Profile ID"), "build-fleet"],
        [page.getByLabel("Crabbox backend"), "hetzner"],
      ]);
      const machineClass = page.getByRole("textbox", { name: "Machine class", exact: true });
      await expect.poll(() => machineClass.inputValue()).toBe("");
      expect(await machineClass.getAttribute("list")).toBeNull();
      expect(await page.locator("openclaw-cloud-workers-page datalist").count()).toBe(0);
      for (const invalidClass of ["", " ", "x".repeat(129)]) {
        await fillForm(page, [[machineClass, invalidClass]]);
        await exactButton(page, "Save").click();
        await expect
          .poll(() => page.getByRole("alert").textContent())
          .toBe("Enter a machine class of 1 to 128 characters.");
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      }
      await fillForm(page, [[machineClass, "standard"]]);
      await gateway.deferNext("config.patch");
      const addRequestCount = (await gateway.getRequests("config.patch")).length;
      await exactButton(page, "Save").click();
      const addPatch = await waitForConfigPatch(gateway, addRequestCount);
      expect(addPatch).toEqual(
        profilesConfig({ "build-fleet": profilePatch("hetzner", "standard") }),
      );
      // The saved snapshot includes provider-owned fields absent from this editor.
      const baseFleet = configuredCloudWorkerProfile("hetzner");
      const buildFleet = {
        ...baseFleet,
        suspendAfter: "30m",
        settings: {
          ...baseFleet.settings,
          region: "eu-west-1",
          resources: { cpu: 6, memoryGiB: 12 },
          providerOptions: { image: "qa-base" },
        },
      };
      await gateway.setMethodResponse("environments.list", {
        environments: [],
        profiles: [{ id: "build-fleet", providerId: "crabbox" }],
      });
      await publishProfiles(gateway, { "build-fleet": buildFleet }, "added");

      await page.getByText("Advertised", { exact: true }).waitFor();
      await page.getByText("Profile saved.", { exact: true }).waitFor();
      expect(await gateway.getSocketCount()).toBe(socketCount);

      await exactButton(page, "Edit: build-fleet").click();
      await expect.poll(() => machineClass.inputValue()).toBe("standard");
      const setup = page.getByLabel("Setup command", { exact: true });
      await fillForm(page, [
        [machineClass, "batch/ARM64.v2"],
        [page.getByLabel("Crabbox backend"), "daytona"],
        [page.getByLabel("Max lifetime"), "12h"],
        [page.getByRole("switch", { name: "Desktop", exact: true }), true],
        [page.getByLabel("Crabbox binary"), "/opt/bin/crabbox-draft"],
        [page.getByLabel("Warm images", { exact: true }), "off", "select"],
        [setup, "install-node"],
        [page.getByLabel("Setup environment names", { exact: true }), "BUILD_TAG, CACHE_DIR"],
        [setup, ""],
        [setup, "install-node"],
        [page.getByLabel("Ready workers", { exact: true }), "2"],
        [page.getByLabel("Suspend after", { exact: true }), "2h"],
      ]);
      expect(await page.getByRole("combobox", { name: "Machine class", exact: true }).count()).toBe(
        0,
      );
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
        .toBe("added");
      const configGetCount = (await gateway.getRequests("config.get")).length;
      await gateway.deferNext("config.get");
      await saveButton.focus();
      await gateway.emitGatewayEvent("config.changed", {
        path: "/tmp/openclaw.json",
        hash: "added",
        ts: Date.now(),
      });
      await gateway.waitForRequest("config.get", { after: configGetCount });
      expect(await saveButton.isEnabled()).toBe(true);
      expect(await saveButton.evaluate((button) => button === document.activeElement)).toBe(true);
      expect(await machineClass.inputValue()).toBe("batch/ARM64.v2");
      await gateway.resolveDeferred(
        "config.get",
        configResponse(profilesConfig({ "build-fleet": buildFleet }), "added"),
      );
      await expect.poll(() => saveButton.isEnabled()).toBe(true);
      await gateway.deferNext("config.patch");
      const editRequestCount = (await gateway.getRequests("config.patch")).length;
      await saveButton.click();
      const editPatch = await waitForConfigPatch(gateway, editRequestCount);
      const editedSettings = {
        provider: "daytona",
        class: "batch/ARM64.v2",
        ttl: "12h",
        idleTimeout: "45m",
        setup: "install-node",
        setupEnv: ["BUILD_TAG", "CACHE_DIR"],
        warmImage: false,
        desktop: true,
        binary: "/opt/bin/crabbox-draft",
      };
      const editedProfile = {
        ...configuredCloudWorkerProfile("daytona"),
        readyWorkers: 2,
        suspendAfter: "2h",
        settings: editedSettings,
      };
      expect(editPatch).toEqual(
        profilesConfig({
          "build-fleet": { ...editedProfile, settings: { ...editedSettings, target: null } },
        }),
      );
      const editedFleet = {
        ...buildFleet,
        ...editedProfile,
        settings: { ...buildFleet.settings, ...editedSettings },
      };
      await publishProfiles(gateway, { "build-fleet": editedFleet }, "edited");

      await page.getByText("Class: batch/ARM64.v2", { exact: false }).waitFor();
      await exactButton(page, "Edit: build-fleet").click();
      await waitForSettledFormControls(page, [
        { locator: machineClass, value: "batch/ARM64.v2" },
        { locator: page.getByLabel("Crabbox backend"), value: "daytona" },
        { locator: page.getByLabel("Crabbox binary"), value: "/opt/bin/crabbox-draft" },
      ]);
      await page.getByRole("button", { name: "Cancel" }).click();

      await page.getByRole("button", { name: "Add profile" }).click();
      await fillForm(page, [
        [page.getByLabel("Profile ID"), "pending"],
        [page.getByLabel("Crabbox backend"), "aws"],
        [machineClass, "custom"],
      ]);
      await gateway.deferNext("config.patch");
      const pendingRequestCount = (await gateway.getRequests("config.patch")).length;
      await exactButton(page, "Save").click();
      const pendingPatch = await waitForConfigPatch(gateway, pendingRequestCount);
      expect(pendingPatch).toEqual(profilesConfig({ pending: profilePatch("aws", "custom") }));
      const pending = configuredCloudWorkerProfile();
      pending.settings.class = "custom";
      await publishProfiles(gateway, { "build-fleet": editedFleet, pending }, "pending");
      await page.getByText("Unavailable", { exact: true }).waitFor();
      await exactButton(pendingRow(page), "Edit: pending").click();
      await expect.poll(() => machineClass.inputValue()).toBe("custom");
      await exactButton(page, "Cancel").click();
    });
  });

  it("releases a retired profile save after reconnect while preserving the draft", async () => {
    await suite.withPage(editorPageOptions, async ({ page }) => {
      const gateway = await workerGateway(page, "retry-initial");

      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page.locator(".cloud-environments__advanced > summary").click();
      await page.getByRole("button", { name: "Add profile" }).click();
      const editor = page.locator(".settings-section", {
        has: page.getByRole("heading", { name: "Add profile", exact: true }),
      });
      const profileId = page.getByLabel("Profile ID");
      const backend = page.getByLabel("Crabbox backend");
      await fillForm(page, [
        [profileId, "reconnect-proof"],
        [backend, "hetzner"],
        [page.getByLabel("Machine class", { exact: true }), "standard"],
      ]);

      await gateway.deferNext("config.patch");
      await exactButton(editor, "Save").click();
      await gateway.waitForRequest("config.patch");
      await expect.poll(() => profileId.isDisabled()).toBe(true);

      const socketCount = await gateway.getSocketCount();
      const configGetCount = (await gateway.getRequests("config.get")).length;
      await gateway.setMethodResponse("config.get", configResponse({}, "retry-refreshed"));
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
      await expect.poll(() => exactButton(editor, "Cancel").isEnabled()).toBe(true);

      await gateway.resolveDeferred("config.patch", {
        ok: true,
        hash: "retired-save",
        config: {},
      });
      await expect.poll(() => profileId.inputValue()).toBe("reconnect-proof");
      await expect.poll(() => page.getByText("Profile saved.", { exact: false }).count()).toBe(0);
      await expect.poll(() => page.getByRole("alert").count()).toBe(0);

      await gateway.deferNext("config.patch");
      const retryRequestCount = (await gateway.getRequests("config.patch")).length;
      await exactButton(editor, "Save").click();
      const retryPatch = await waitForConfigPatch(gateway, retryRequestCount);
      expect(retryPatch).toMatchObject(
        profilesConfig({
          "reconnect-proof": { provider: "crabbox", settings: { provider: "hetzner" } },
        }),
      );
      const savedProfile = configuredCloudWorkerProfile("hetzner");
      await publishProfiles(gateway, { "reconnect-proof": savedProfile }, "retry-saved");
      await page.getByText("Profile saved.", { exact: true }).waitFor();
      await expect.poll(() => page.getByLabel("Profile ID").count()).toBe(0);
    });
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
        const deletedConfig = {
          cloudWorkers: { profiles: { retained }, projectProfiles: retainedProjectProfiles },
        };
        const gateway = await workerGateway(page, "before-delete", initialConfig, {
          featureMethods: ["config.patch", "config.set", "config.schema", "environments.list"],
          methodResponses: {
            "config.schema": configSchema(
              objectSchema("", {
                cloudWorkers: objectSchema("", {
                  profiles: { type: "object", additionalProperties: { type: "object" } },
                }),
              }),
            ),
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
          configResponse(replacedConfig, "provider-replaced"),
        );
        await gateway.emitGatewayEvent("config.changed", {
          path: "/tmp/openclaw.json",
          hash: "provider-replaced",
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
        await gateway.setMethodResponse("config.get", configResponse(savedConfig, "raw-saved"));
        await gateway.resolveDeferred("config.set", {
          ok: true,
          hash: "raw-saved",
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
        await gateway.deferNext("config.patch");
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
        await gateway.setMethodResponse("config.get", configResponse(deletedConfig, "deleted"));
        await gateway.resolveDeferred("config.patch", {
          ok: true,
          hash: "deleted",
          config: deletedConfig,
        });
        await expect.poll(() => row.count()).toBe(0);
        await page.locator(".settings-row code", { hasText: /^retained$/ }).waitFor();
      });
    },
  );

  it.each(["reconnect", "credentials", "offline"] as const)(
    "revalidates a confirmed profile deletion after %s",
    async (mode) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const initialConfig = profilesConfig({ pending: configuredCloudWorkerProfile() });
        const gateway = await workerGateway(page, "delete-1", initialConfig, {
          methodResponses:
            mode === "offline"
              ? {}
              : {
                  "config.patch": { ok: true, hash: "delete-3", config: profilesConfig({}) },
                },
        });
        await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
        await page.locator(".cloud-environments__advanced > summary").click();
        const row = pendingRow(page);
        await exactButton(row, "Delete: pending").click();
        const confirmation = await waitForConfirmModal(page);
        const socketCount = await gateway.getSocketCount();
        const configGetCount = (await gateway.getRequests("config.get")).length;
        if (mode === "offline") {
          await gateway.deferNext("config.get");
        } else if (mode === "reconnect") {
          await gateway.setMethodResponse("config.get", configResponse(initialConfig, "delete-2"));
        }
        if (mode === "credentials") {
          const original = await evaluateControlUiContext(page, (application) => {
            const active = application.gateway;
            const client = active.snapshot.client;
            if (!client) {
              throw new Error("Expected a connected Gateway client before confirmation");
            }
            const identity = {
              clientInstanceId: client.instanceId,
              gatewayUrl: active.connection.gatewayUrl,
            };
            active.connect({ token: "replacement-credential-proof" });
            return identity;
          });
          await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
          await expect
            .poll(async () => (await gateway.getRequests("config.get")).length)
            .toBeGreaterThan(configGetCount);
          await expect
            .poll(() =>
              evaluateControlUiContext(page, (application) => ({
                clientInstanceId: application.gateway.snapshot.client?.instanceId,
                gatewayUrl: application.gateway.connection.gatewayUrl,
                phase: application.gateway.snapshot.phase,
              })),
            )
            .toMatchObject({ gatewayUrl: original.gatewayUrl, phase: "connected" });
          expect(
            await evaluateControlUiContext(
              page,
              (application) => application.gateway.snapshot.client?.instanceId,
            ),
          ).not.toBe(original.clientInstanceId);
        } else {
          await gateway.closeLatest(1012, "cloud worker delete confirmation reconnect proof");
          if (mode === "reconnect") {
            await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
          }
          await expect
            .poll(async () => (await gateway.getRequests("config.get")).length)
            .toBeGreaterThan(configGetCount);
        }
        if (mode !== "offline") {
          await expect.poll(() => exactButton(row, "Delete: pending").isEnabled()).toBe(true);
        }
        await exactButton(confirmation, "Delete").click();
        if (mode === "reconnect") {
          await expect.poll(async () => (await gateway.getRequests("config.patch")).length).toBe(1);
          await expect.poll(() => row.count()).toBe(0);
        } else {
          if (mode === "credentials") {
            await expect
              .poll(async () => ({
                alerts: await page.getByRole("alert").count(),
                patches: (await gateway.getRequests("config.patch")).length,
              }))
              .not.toEqual({ alerts: 0, patches: 0 });
          }
          await expect
            .poll(() => page.getByRole("alert").textContent())
            .toBe("The profile was not deleted. Reload the config and try again.");
          expect(await gateway.getRequests("config.patch")).toHaveLength(0);
          await row.waitFor();
        }
      });
    },
  );

  it("keeps profile mutations admin-scoped", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await workerGateway(page, "read-only", {}, { operatorScopes: ["operator.read"] });

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
