import type { Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sidebarSessionList } from "./sidebar-contract.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Personal navigation identity resolution" });

async function checkIdentityScope({ page }: { page: Page }) {
  const mine = "agent:main:planning";
  const other = "agent:main:research";
  const owners = [
    { type: "human" as const, id: "alex", label: "Alex" },
    { type: "human" as const, id: "sam", label: "Sam" },
  ];
  const sessions = [
    { key: mine, label: "Weekly planning", owner: { actor: owners[0]! } },
    { key: other, label: "Research notes", owner: { actor: owners[1]! } },
  ];
  const gateway = await installMockGateway(page, {
    heldMethods: ["users.self"],
    hasMultipleSessionSharingIdentities: true,
    featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
    agentModel: "gpt-5-mini",
    sessions,
    methodResponses: {
      "sessions.list": sidebarSessionList(sessions, {}, owners),
      "users.prefs.get": {
        status: "ok",
        entries: {
          "ui.railShortcuts": [],
          "new-session.migration.v1": true,
        },
      },
    },
  });
  await page.goto(suite.server.baseUrl + "new");
  await gateway.waitForRequest("users.self");
  const sidebar = page.locator("openclaw-app-sidebar");
  const rows = sidebar.locator(".sidebar-session-content .sidebar-recent-session");
  const ownerFilter = sidebar.locator("#sidebar-session-owner-title .picker-select__label");
  const expectScope = async (label: string, count: number) => {
    await expect.poll(async () => (await ownerFilter.textContent())?.trim()).toBe(label);
    await expect.poll(() => rows.count()).toBe(count);
  };
  await expectScope("All owners", 2);
  await gateway.rejectDeferred("users.self", {
    code: "FORBIDDEN",
    message: "No authenticated profile",
  });
  await expectScope("All owners", 2);
  expect(await gateway.getRequests("users.prefs.set")).toEqual([]);
  const instanceId = await evaluateControlUiContext(
    page,
    (context) => context.gateway.snapshot.client?.instanceId,
  );
  expect(instanceId).toBeTruthy();
  const user = { id: "alex", identity: { type: "profile", id: "alex" }, name: "Alex" };
  await gateway.emitGatewayEvent("presence", { presence: [{ instanceId, user }] });
  await expectScope("My sessions", 1);
  expect(await rows.first().getAttribute("data-session-key")).toBe(mine);
  expect(await gateway.getRequests("users.prefs.set")).toEqual([]);
}

suite.define(() => {
  it("shows All owners without a profile and defaults to My sessions after identification", () =>
    suite.withPage(
      { viewport: { width: 1280, height: 800 }, locale: "en-US" },
      checkIdentityScope,
    ));
});
