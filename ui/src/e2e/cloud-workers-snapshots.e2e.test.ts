import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { SnapshotImage } from "../pages/cloud-workers/cloud-worker-environment-model.ts";
import {
  buildEnvironmentFixture,
  snapshotListFixture,
} from "../pages/cloud-workers/cloud-worker-snapshots.test-support.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, waitForConfirmModal } from "../test-helpers/control-ui-e2e.ts";
import { rasterizeProofAnnotations } from "../test-helpers/proof-annotations.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Control UI cloud environments mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
function snapshot() {
  const result = snapshotListFixture();
  result.images = [
    { ...result.images[0]!, held: false, retirement: undefined, projectRoot: "/projects/app" },
  ];
  return result;
}
const methods = [
  ...["list", "pin", "delete", "rollback", "recover"].map((method) => `crabbox.images.${method}`),
  ...["list", "prepare", "destroy"].map((method) => `environments.${method}`),
];
const button = (root: Page | Locator, name: string) =>
  root.getByRole("button", { name, exact: true });
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });
const sheet = (page: Page) => page.locator(".cloud-environments__sheet");
type Gateway = Awaited<ReturnType<typeof installMockGateway>>;
const coreMethods = ["config.get", "config.patch", "plugins.uiDescriptors", "environments.list"];
const savedConfig = (config: Record<string, unknown>, valid = true) => ({
  valid,
  hash: "saved",
  appliedConfigHash: "saved",
  sourceConfig: config,
  resolved: config,
  config,
});
function withSnapshots(
  responses: Record<string, unknown>,
  run: (page: Page, gateway: Gateway) => Promise<void>,
  featureMethods = methods,
) {
  return suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
    const gateway = await installMockGateway(page, {
      featureMethods,
      methodResponses: {
        "crabbox.images.list": snapshot(),
        "environments.list": { environments: [], profiles: [] },
        ...responses,
      },
    });
    await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
    await run(page, gateway);
  });
}
async function recoverCapture(
  page: Page,
  gateway: Gateway,
  surface: Locator,
  selector: string,
  next: ReturnType<typeof snapshot>,
  after = 0,
) {
  await surface.getByText("Paused: uncertain", { exact: true }).waitFor();
  await button(surface, "Recover").click();
  const dialog = await waitForConfirmModal(page);
  expect(await dialog.getAttribute("label")).toBe("Recover this paused snapshot?");
  const recover = button(dialog, "Recover");
  expect(await recover.isDisabled()).toBe(true);
  await dialog.getByRole("checkbox").check();
  await gateway.setMethodResponse("crabbox.images.list", next);
  await recover.click();
  expect((await gateway.waitForRequest("crabbox.images.recover", { after })).params).toEqual({
    selector,
    acknowledgeProviderCleanup: true,
  });
  await expect.poll(() => surface.getByText("Paused: uncertain", { exact: true }).count()).toBe(0);
}
suite.define(() => {
  it("restores pool controls when config capability returns during a held save", async () => {
    const config = { cloudWorkers: { preparedPool: { maxTotal: 4 } } };
    await withSnapshots(
      {
        "config.get": savedConfig(config),
        "crabbox.images.list": { ...snapshot(), images: [], profiles: [] },
      },
      async (page, gateway) => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.locator(".settings-disclosure > summary").click();
        const pool = page.getByLabel("Pool limit", { exact: true });
        const save = button(page, "Save pool");
        await expect.poll(() => save.isEnabled()).toBe(true);
        await pool.fill("6");
        await gateway.deferNext("config.patch");
        await save.click();
        await gateway.waitForRequest("config.patch");
        const advertised = await evaluateControlUiContext(
          page,
          (app) => app.gateway.snapshot.hello?.features?.methods ?? [],
        );
        const change = async (generation: number, advertisedMethods: string[]) => {
          await gateway.setMethodResponse("plugins.uiDescriptors", {
            ok: true,
            generation,
            methods: advertisedMethods,
            descriptors: [],
            controlUiTabs: [],
            controlUiWidgetKinds: [],
            controlUiLinkReaders: [],
            pluginSurfaceUrls: {},
          });
          await gateway.emitGatewayEvent("plugins.changed", { generation });
          await expect
            .poll(() =>
              evaluateControlUiContext(
                page,
                (app) => app.gateway.snapshot.pluginCapabilities?.generation,
              ),
            )
            .toBe(generation);
        };
        try {
          await change(
            1,
            advertised.filter((method) => method !== "config.patch"),
          );
          await expect.poll(() => save.isDisabled()).toBe(true);
          await change(2, advertised);
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator("openclaw-cloud-workers-page"),
              [save, pool],
              {
                elements: [save],
                animations: "disabled",
              },
            );
            const bounds = frame.elements[0]!.bounds;
            const annotation = {
              viewport: page.viewportSize()!,
              scale: await page.evaluate(() => devicePixelRatio),
              annotations: [
                {
                  kind: "outline" as const,
                  rect: bounds,
                  color: "#167a6d",
                  text: (await save.isEnabled()) ? "Save is available" : "Save stays disabled",
                  labelAt: { x: bounds.x - 360, y: Math.max(20, bounds.y - 100) },
                },
              ],
            };
            await writeFile(path.join(suite.artifactDir, "pool-return-clean.png"), frame.png);
            await writeFile(
              path.join(suite.artifactDir, "pool-return-annotations.json"),
              JSON.stringify(annotation, null, 2),
            );
            await writeFile(
              path.join(suite.artifactDir, "pool-return-annotated.png"),
              await rasterizeProofAnnotations(suite.browser, { ...annotation, image: frame.png }),
            );
          }
          await expect.poll(() => save.isEnabled()).toBe(true);
          expect(await pool.inputValue()).not.toBe("6");
          expect(await gateway.getRequests("config.patch")).toHaveLength(1);
        } finally {
          await gateway.resolveDeferred("config.patch", { ok: true, hash: "saved", config });
        }
      },
      [...coreMethods, ...methods],
    );
  });

  it("keeps a long snapshot profile and its actions inside the phone detail card", async () => {
    const result = snapshot();
    const first = { ...result.images[0]!, profileId: "regionalengineering".repeat(4) };
    result.images = [first, { ...first, profileId: "secondary", profileKey: "secondary-key" }];
    await withSnapshots({ "crabbox.images.list": result }, async (page) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const group = sheet(page).getByRole("group", { name: first.profileId, exact: true });
      const actions = button(group, "Environment actions");
      await actions.waitFor();
      const fits = await group.evaluate((row) => {
        const bounds = row.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(row.querySelector("strong")!);
        return (
          range.getBoundingClientRect().right <= bounds.right &&
          row.querySelector("button")!.getBoundingClientRect().right <= bounds.right
        );
      });
      expect(fits).toBe(true);
      await actions.click();
      await menuItem(page, "Pin").waitFor();
      await page.keyboard.press("Escape");
    });
  });

  it("refreshes snapshots and saved machines after lazy plugin activation without reconnecting", async () => {
    await withSnapshots(
      {
        "config.get": savedConfig({}, false),
        "plugins.uiDescriptors": {
          ok: true,
          generation: 1,
          descriptors: [],
          methods: [...coreMethods, ...methods],
          controlUiTabs: [],
          controlUiWidgetKinds: [],
          controlUiLinkReaders: [],
          pluginSurfaceUrls: {},
        },
      },
      async (page, gateway) => {
        await gateway.waitForRequest("config.get");
        await page
          .getByText(/^No cloud devices yet[.]/, {
            exact: false,
          })
          .waitFor();
        await page.locator(".settings-disclosure > summary").click();
        const emptyMachines = page.getByText("No cloud device profiles yet.", {
          exact: true,
        });
        await emptyMachines.waitFor();
        expect(await gateway.getRequests("crabbox.images.list")).toHaveLength(0);
        const cloud = {
          provider: "crabbox",
          install: "bundle",
          settings: { provider: "aws", class: "standard" },
        };
        const config = { cloudWorkers: { profiles: { cloud } } };
        await gateway.setMethodResponse("config.get", savedConfig(config));
        await gateway.emitGatewayEvent("plugins.changed", { generation: 1 });
        await page
          .locator(".cloud-environments__row")
          .getByText("github.com/acme/app", { exact: true })
          .waitFor();
        await button(page, "Edit: cloud").waitFor();
        expect(await gateway.getRequests("connect")).toHaveLength(1);
        expect((await gateway.getRequests("crabbox.images.list")).length).toBeGreaterThan(0);
      },
      coreMethods,
    );
  });
  it("rebuilds the selected repository and cancels its build after confirmation", async () => {
    await withSnapshots(
      {
        "environments.prepare": {
          environmentId: "build-app",
          preparationKey: "build-key",
          reused: false,
        },
        "environments.destroy": { ok: true },
      },
      async (page, gateway) => {
        await button(page, "Rebuild").waitFor();
        await gateway.setMethodResponse("environments.list", {
          environments: [buildEnvironmentFixture()],
          profiles: [],
        });
        await button(page, "Rebuild").click();
        expect((await gateway.waitForRequest("environments.prepare")).params).toEqual({
          profileId: "linux-build",
          projectPath: "/projects/app",
        });
        const cancel = button(page, "Cancel: build-app");
        await cancel.click();
        const dialog = await waitForConfirmModal(page);
        expect(await dialog.getAttribute("label")).toBe("Cancel this snapshot build?");
        expect(await gateway.getRequests("environments.destroy")).toHaveLength(0);
        await gateway.setMethodResponse("environments.list", { environments: [], profiles: [] });
        await button(dialog, "Cancel build").click();
        expect((await gateway.waitForRequest("environments.destroy")).params).toEqual({
          environmentId: "build-app",
        });
        await expect.poll(() => cancel.count()).toBe(0);
      },
    );
  });
  it("keeps failed builds in their repository sheet and dismisses only confirmed failures", async () => {
    await withSnapshots(
      {
        "environments.list": {
          environments: [buildEnvironmentFixture("failed", "Synthetic setup failure")],
          profiles: [],
        },
        "environments.destroy": { ok: true },
      },
      async (page, gateway) => {
        await sheet(page).getByText("Synthetic setup failure", { exact: true }).waitFor();
        expect(await page.locator(".cloud-environments__row").textContent()).toBe(
          "github.com/acme/appNeeds attention",
        );
        const dismiss = button(page, "Dismiss: build-app");
        await dismiss.click();
        const dialog = await waitForConfirmModal(page);
        await button(dialog, "Cancel").click();
        expect(await gateway.getRequests("environments.destroy")).toHaveLength(0);
        await dismiss.click();
        await button(await waitForConfirmModal(page), "Dismiss").click();
        await gateway.waitForRequest("environments.destroy");
        await expect
          .poll(() => page.getByText("Synthetic setup failure", { exact: true }).count())
          .toBe(0);
      },
    );
  });
  it("recovers repository and project-less uncertain captures only after cleanup acknowledgement", async () => {
    const result = snapshot();
    result.images[0]!.capture = { selector: "capture-app", phase: "uncertain", stale: false };
    const machineCapture: SnapshotImage = {
      profileKey: "profile-key-machine",
      profileId: "machine-build",
      state: "no-image",
      allocationCount: 0,
      held: false,
      capture: { selector: "capture-machine", phase: "uncertain", stale: false },
    };
    result.images.push(machineCapture);
    await withSnapshots(
      {
        "crabbox.images.list": result,
        "crabbox.images.recover": { ok: true },
      },
      async (page, gateway) => {
        const repositorySheet = sheet(page);
        await repositorySheet.getByText("Paused: uncertain", { exact: true }).waitFor();
        expect(await page.locator(".cloud-environments__row").count()).toBe(1);
        const repositoryRecovered = snapshot();
        repositoryRecovered.images.push(machineCapture);
        await recoverCapture(page, gateway, repositorySheet, "capture-app", repositoryRecovered);
        const advanced = page.locator(".settings-disclosure");
        await advanced.locator("summary").click();
        await recoverCapture(page, gateway, advanced, "capture-machine", snapshot(), 1);
        expect(await page.locator(".cloud-environments__row").count()).toBe(1);
      },
    );
  });
  it("pins, unpins, rolls back and deletes the second profile snapshot without changing the first", async () => {
    const result = snapshot();
    const firstImage = result.images[0]!;
    const secondImage = {
      ...firstImage,
      profileKey: "profile-key-arm",
      profileId: "arm-build",
      checkpointId: "image-arm",
      baseCommit: "abcdef0123456789",
      previous: { checkpointId: "image-arm-previous", createdAtMs: 1234 },
    };
    result.images.push(secondImage);
    await withSnapshots(
      {
        "crabbox.images.list": result,
        "crabbox.images.pin": {},
        "crabbox.images.rollback": {},
        "crabbox.images.delete": { status: "deleted" },
      },
      async (page, gateway) => {
        const secondSnapshot = page.locator(
          '.cloud-environments__snapshot[aria-label="arm-build"]',
        );
        const menu = async (label: string) => {
          await button(secondSnapshot, "Environment actions").click();
          await page.getByRole("menuitem", { name: label, exact: true }).click();
        };

        await sheet(page).getByText("01234567", { exact: true }).waitFor();
        await secondSnapshot.getByText("abcdef01", { exact: true }).waitFor();
        expect(await page.locator(".cloud-environments__row").count()).toBe(1);
        const changedImage = (changes: Partial<SnapshotImage>) => ({
          ...result,
          images: [firstImage, { ...secondImage, ...changes }],
        });
        const pinned = changedImage({ pinned: { atMs: 1000 } });
        await gateway.setMethodResponse("crabbox.images.list", pinned);
        await menu("Pin");
        expect((await gateway.waitForRequest("crabbox.images.pin")).params).toEqual({
          checkpointId: "image-arm",
          pinned: true,
        });
        await button(secondSnapshot, "Environment actions").click();
        await menuItem(page, "Unpin").waitFor();
        expect(await menuItem(page, "Delete").getAttribute("aria-disabled")).toBe("true");
        await gateway.setMethodResponse("crabbox.images.list", result);
        await menuItem(page, "Unpin").click();
        await expect
          .poll(async () => (await gateway.getRequests("crabbox.images.pin")).length)
          .toBe(2);
        expect((await gateway.getRequests("crabbox.images.pin"))[1]?.params).toEqual({
          checkpointId: "image-arm",
          pinned: false,
        });
        const restored = changedImage({
          checkpointId: "image-arm-previous",
          previous: { checkpointId: "image-arm", createdAtMs: 1234 },
        });
        await menu("Roll back");
        const rollback = await waitForConfirmModal(page);
        expect(await rollback.getAttribute("label")).toBe("Roll back this snapshot?");
        await gateway.setMethodResponse("crabbox.images.list", restored);
        await button(rollback, "Roll back").click();
        expect((await gateway.waitForRequest("crabbox.images.rollback")).params).toEqual({
          checkpointId: "image-arm-previous",
        });
        await menu("Delete");
        const deletion = await waitForConfirmModal(page);
        expect(await deletion.getAttribute("label")).toBe("Delete this snapshot?");
        await deletion.getByText("image-arm-previous", { exact: true }).waitFor();
        await gateway.setMethodResponse("crabbox.images.list", { ...result, images: [firstImage] });
        await button(deletion, "Delete").click();
        expect((await gateway.waitForRequest("crabbox.images.delete")).params).toEqual({
          checkpointId: "image-arm-previous",
        });
        await expect.poll(() => secondSnapshot.count()).toBe(0);
        await sheet(page).getByText("01234567", { exact: true }).waitFor();
        expect(await page.locator(".cloud-environments__row").count()).toBe(1);
      },
    );
  });
});
