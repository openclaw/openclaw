/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
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
