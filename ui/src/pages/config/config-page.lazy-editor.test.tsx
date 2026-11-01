/* @vitest-environment jsdom */

import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createConfigRouteContext, mountConfigPage } from "./config-page.test-support.ts";

const formModule = vi.hoisted(() => ({
  requested: vi.fn(),
  ready: Promise.withResolvers<void>(),
}));

vi.mock("../../components/config-form.render.tsx", async (importOriginal) => {
  formModule.requested();
  await formModule.ready.promise;
  return importOriginal<typeof import("../../components/config-form.render.tsx")>();
});

// mock-isolation: exercise a rejected lazy module import before any real exports are available.
vi.mock("./security.tsx", async () => {
  throw new Error("Synthetic Security module read failed");
});

afterEach(() => {
  formModule.ready.resolve();
  cleanupSolid();
});

it("keeps Appearance usable without loading the schema editor and loads it on section intent", async () => {
  const context = createConfigRouteContext();
  Object.assign(context.runtimeConfig.state, {
    configSchema: {
      type: "object",
      properties: {
        gateway: { type: "object", properties: { port: { type: "number" } } },
      },
    },
    configForm: { gateway: { port: 18789 } },
    configUiHints: { "gateway.port": { advanced: false } },
  });
  const view = mountConfigPage(context, { pageId: "appearance" });
  await waitForSolid(() => {
    expect(view.page.querySelector('[data-theme-id="claw"]')).not.toBeNull();
    expect(formModule.requested).not.toHaveBeenCalled();
  });

  view.update({ pageId: "infrastructure" });
  await waitForSolid(() => {
    expect(formModule.requested).toHaveBeenCalledOnce();
    expect(view.page.querySelector(".config-loading")).not.toBeNull();
  });

  view.update({ pageId: "appearance" });
  await waitForSolid(() =>
    expect(view.page.querySelector('[data-theme-id="claw"]')).not.toBeNull(),
  );

  formModule.ready.resolve();
  await vi.dynamicImportSettled();
  view.update({ pageId: "infrastructure" });
  await waitForSolid(() =>
    expect(view.page.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe("18789"),
  );
  expect(formModule.requested).toHaveBeenCalledOnce();
});

it("leaves a failed Settings module when navigating to another page", async () => {
  const view = mountConfigPage(createConfigRouteContext(), { pageId: "security" });
  await waitForSolid(() =>
    expect(view.page.querySelector(".config-content-callout")?.textContent).toContain(
      "Synthetic Security module read failed",
    ),
  );

  view.update({ pageId: "appearance" });
  await waitForSolid(() => {
    expect(view.page.querySelector('[data-theme-id="claw"]')).not.toBeNull();
    expect(view.page.querySelector(".config-content-callout")).toBeNull();
  });
});

it("progressively opens Advanced after visiting Infrastructure", async () => {
  const nextTask = Promise.withResolvers<void>();
  vi.stubGlobal("scheduler", { yield: () => nextTask.promise });
  onTestFinished(() => {
    nextTask.resolve();
    vi.unstubAllGlobals();
  });
  const context = createConfigRouteContext();
  const sections = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [
      `part${index}`,
      { type: "object", properties: { field: { type: "string" } } },
    ]),
  );
  Object.assign(context.runtimeConfig.state, {
    configSchema: {
      type: "object",
      properties: {
        gateway: { type: "object", properties: { port: { type: "number" } } },
        ...sections,
      },
    },
    configForm: { gateway: { port: 18789 } },
    configUiHints: { "gateway.port": { advanced: false } },
  });
  const view = mountConfigPage(context, { pageId: "infrastructure" });
  formModule.ready.resolve();
  await vi.dynamicImportSettled();
  await waitForSolid(() =>
    expect(view.page.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe("18789"),
  );

  view.update({ pageId: "advanced" });
  await waitForSolid(() => {
    expect(view.page.querySelectorAll('[id^="config-section-part"]')).toHaveLength(1);
    expect(view.page.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  nextTask.resolve();
  await waitForSolid(() => {
    expect(view.page.querySelectorAll('[id^="config-section-part"]')).toHaveLength(8);
    expect(view.page.querySelector('[aria-busy="true"]')).toBeNull();
  });
});
