/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it("keeps a cold roster metadata failure readable before its view catalog loads", async () => {
  const { en, manager } = await loadI18n();
  const agentsHome = en.agentsHome;
  const { createRosterFixture, rosterResult } =
    await import("../lib/agents/roster-activity-store.test-support.ts");
  const { createGatewayRequestMock, createTestGatewayClient } =
    await import("../test-helpers/gateway-client.ts");
  const request = createGatewayRequestMock(async (method) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.groups.list") {
      return { groups: [], sectionOrder: [] };
    }
    if (method === "sessions.list") {
      return rosterResult();
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const { context, store, sessions } = createRosterFixture(createTestGatewayClient(request));
  context.agents.ensureList = async () => null;
  expect(manager.t("agentsHome.pinnedAgents")).toBe("agentsHome.pinnedAgents");
  const stop = store.subscribe(() => {});
  try {
    await store.refresh();
    expect(store.snapshot.error).toBe("Could not load agents. Try again.");
    const { registerEnglishCatalog } = await import("../lib/reactive/i18n.ts");
    const { registerAgentsHomeEnglish } = await import("./locales/en-agents-home.ts");
    registerEnglishCatalog(registerAgentsHomeEnglish);
    expect(en.agentsHome).toBe(agentsHome);
    await store.refresh();
    expect(store.snapshot.error).toBe("Could not load agents. Try again.");
  } finally {
    stop();
    sessions.dispose();
  }
});

it("loads Details copy through its lazy view while preserving the active locale and namespace", async () => {
  const { en, manager } = await loadI18n({
    common: { health: "Gesundheit" },
    chat: { sessionDetails: { context: "Kontext" } },
  });
  const details = en.chat.sessionDetails;
  const { registerEnglishCatalog } = await import("../lib/reactive/i18n.ts");
  const { registerChatSessionEnglish } = await import("./locales/en-chat-session.ts");
  registerEnglishCatalog(registerChatSessionEnglish);
  await manager.setLocale("de");
  expect(manager.t("chat.sessionDetails.title")).toBe("Details");
  expect(manager.t("chat.sessionDetails.progressHidden")).toBe(
    "Task progress hidden in this browser.",
  );
  expect(manager.t("chat.sessionDetails.environment")).toBe("chat.sessionDetails.environment");

  await import("../pages/chat/components/chat-context-breakdown.tsx");

  expect(manager.t("chat.sessionDetails.environment")).toBe("Environment");
  expect(manager.t("chat.sessionDetails.context")).toBe("Kontext");
  expect(manager.t("common.health")).toBe("Gesundheit");
  expect(manager.getLocale()).toBe("de");
  expect(en.chat.sessionDetails).toBe(details);
});

it("loads optional English copy at each view boundary while keeping shared labels eager", async () => {
  const { en, manager } = await loadI18n();
  const about = en.aboutPage;
  const dashboards = en.dashboardsPage;
  expect(manager.t("aboutPage.artifactDetails")).toBe("Control UI build details");
  expect(manager.t("aboutPage.copiedCommit")).toBe("Commit hash copied");
  await manager.setLocale("de");
  for (const { key, load, catalog } of [
    {
      key: "aboutPage.tagline",
      load: () => import("../pages/about/view.tsx"),
      catalog: async () => (await import("./locales/en-about.ts")).registerAboutEnglish.catalog,
    },
    {
      key: "dashboardsPage.emptyDescription",
      load: () => import("../pages/dashboards/view.tsx"),
      catalog: async () =>
        (await import("./locales/en-dashboards.ts")).registerDashboardsEnglish.catalog,
    },
  ]) {
    expect(manager.t(key)).toBe(key);
    await load();
    for (const [catalogKey, value] of flattenTranslations(await catalog())) {
      expect(manager.t(catalogKey)).toBe(value);
    }
    expect(manager.t("common.health")).toBe("Gesundheit");
    expect(en.aboutPage).toBe(about);
    expect(en.dashboardsPage).toBe(dashboards);
  }
});
