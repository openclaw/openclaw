/* @vitest-environment jsdom */

import { afterEach, expect, it } from "vitest";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createConfigRouteContext, mountConfigPage } from "./config-page.test-support.ts";

afterEach(() => {
  cleanupSolid();
});

it("stacks Gateway authentication as its own section above the Gateway rows", async () => {
  const context = createConfigRouteContext();
  Object.assign(context.runtimeConfig.state, {
    configSchema: {
      type: "object",
      properties: {
        gateway: { type: "object", properties: { port: { type: "number" } } },
      },
    },
    configForm: { gateway: { port: 18789, auth: { mode: "token" } } },
    configUiHints: { "gateway.port": { advanced: false } },
  });
  const view = mountConfigPage(context, { pageId: "infrastructure" });
  const authHeading = () =>
    [...view.page.querySelectorAll("h2")].find(
      (heading) => heading.textContent === "Authentication",
    );
  await waitForSolid(() => {
    expect(authHeading()).toBeDefined();
    expect(view.page.querySelector("#config-section-gateway")).not.toBeNull();
  });

  const authSection = authHeading()!.closest(".settings-section")!;
  const gatewaySection = view.page.querySelector("#config-section-gateway")!;
  // Nested in the schema form's row card, the section loses its own padding and border.
  expect(authSection.closest(".settings-group")).toBeNull();
  expect(gatewaySection.contains(authSection)).toBe(false);
  expect(
    authSection.compareDocumentPosition(gatewaySection) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
