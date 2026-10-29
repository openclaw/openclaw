/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it.each([false, true])(
  "merges creator copy in either registration order (creator first=%s)",
  async (creatorFirst) => {
    const { en, manager } = await loadI18n({
      templatesDraft: { reviewTitle: "Vorlage prüfen" },
      agentsHome: { pinnedAgents: "Angeheftete Agenten" },
    });
    const { registerEnglishCatalog } = await import("../lib/reactive/i18n.ts");
    const { registerAgentsHomeEnglish } = await import("./locales/en-agents-home.ts");
    const { registerTemplateCreatorEnglish } = await import("./locales/en-template-creator.ts");
    await manager.setLocale("de");
    const registrars = [registerAgentsHomeEnglish, registerTemplateCreatorEnglish];
    const ordered = creatorFirst ? registrars.toReversed() : registrars;
    registerEnglishCatalog(ordered[0]!);
    const namespace = en.templatesDraft;
    registerEnglishCatalog(ordered[1]!);
    registerAgentsHomeEnglish();
    registerTemplateCreatorEnglish();
    expect(manager.t("templatesDraft.title")).toBe("Create Template");
    expect(manager.t("templatesDraft.sendFailed")).toBe(
      "The main chat did not accept the Create Template message.",
    );
    expect(manager.t("templatesDraft.reviewTitle")).toBe("Vorlage prüfen");
    expect(manager.t("agentsHome.pinnedAgents")).toBe("Angeheftete Agenten");
    expect(manager.getLocale()).toBe("de");
    expect(en.templatesDraft).toBe(namespace);
  },
);

it("keeps sidebar and chat actions readable until the session management dialog loads", async () => {
  const { en, manager } = await loadI18n({ sessionsView: { goal: "Ziel" } });
  const sessionsView = en.sessionsView;
  await manager.setLocale("de");
  expect(manager.t("sessionsView.searchGroups")).toBe("sessionsView.searchGroups");

  await Promise.all([
    import("../components/app-sidebar.tsx"),
    import("../components/session-menu-access.ts"),
    import("../lib/chat/complete-history.ts"),
    import("../lib/sessions/session-archive-reason.ts"),
    import("../lib/sessions/session-menu-navigation.ts"),
    import("../pages/chat/chat-pane-native-session-actions.ts"),
    import("../pages/chat/chat-pane-placement.ts"),
  ]);

  expect(manager.t("sessionsView.searchGroups")).toBe("sessionsView.searchGroups");
  expect(manager.t("sessionsView.personalGroupNew")).toBe("New section");
  expect(manager.t("sessionsView.personalGroupEdit")).toBe("sessionsView.personalGroupEdit");
  expect(manager.t("sessionsView.archiveReasonManual")).toBe("Archived manually");
  expect(manager.t("sessionsView.stopCloudWorkerConfirm", { session: "Build" })).toBe(
    'Stop the cloud worker for "Build"?',
  );
  expect(manager.t("sessionsView.goal")).toBe("Ziel");
  expect(en.sessionsView).toBe(sessionsView);

  await import("../components/personal-session-group-dialog-view.tsx");
  expect(manager.t("sessionsView.searchGroups")).toBe("Search groups");
  expect(manager.t("sessionsView.personalGroupEdit")).toBe("Edit section");
  expect(manager.t("sessionsView.goal")).toBe("Ziel");
  expect(manager.getLocale()).toBe("de");
  expect(en.sessionsView).toBe(sessionsView);
});

it("keeps a cold roster metadata failure readable before its view catalog loads", async () => {
  const { en, manager } = await loadI18n();
  const agentsHome = en.agentsHome;
  const { createRosterFixture, rosterResult } =
    await import("../lib/agents/roster-activity-store.test-support.ts");
  const { createTestGatewayClient } = await import("../test-helpers/gateway-client.ts");
  const replies = new Map<string, () => unknown>([
    ["sessions.subscribe", () => ({ subscribed: true })],
    ["sessions.groups.list", () => ({ groups: [], sectionOrder: [] })],
    ["sessions.list", rosterResult],
  ]);
  const client = createTestGatewayClient(async (method) => {
    const reply = replies.get(method);
    if (!reply) {
      throw new Error(`Unexpected RPC: ${method}`);
    }
    return reply();
  });
  const { context, store, sessions } = createRosterFixture(client);
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
  const providerUsage = en.usage.providerUsage;
  expect(manager.t("aboutPage.artifactDetails")).toBe("Control UI build details");
  await manager.setLocale("de");
  for (const [key, copy, load] of [
    ["aboutPage.linkDocs", "Docs", () => import("../pages/about/view.tsx")],
    ["dashboardsPage.live", "Live", () => import("../pages/dashboards/view.tsx")],
    [
      "usage.providerUsage.balance",
      "Balance",
      () => import("../components/solid/provider-usage.tsx"),
    ],
  ] as const) {
    expect(manager.t(key)).toBe(key);
    await load();
    expect(manager.t(key)).toBe(copy);
    expect(manager.t("common.health")).toBe("Gesundheit");
    expect(en.aboutPage).toBe(about);
    expect(en.dashboardsPage).toBe(dashboards);
    expect(en.usage.providerUsage).toBe(providerUsage);
  }
});

it("loads optional chat copy with its view while keeping admission errors synchronous", async () => {
  const { en, manager } = await loadI18n({
    chat: { composer: { menu: { back: "Zurück" } } },
  });
  const permissions = en.chat.permissions;
  const workspaceFiles = en.chat.workspaceFiles;
  const { registerEnglishCatalog } = await import("../lib/reactive/i18n.ts");
  const { registerChatComposerEnglish } = await import("./locales/en-chat-composer.ts");
  const { registerChatSessionEnglish } = await import("./locales/en-chat-session.ts");
  registerEnglishCatalog(registerChatComposerEnglish);
  registerEnglishCatalog(registerChatSessionEnglish);
  await manager.setLocale("de");
  expect(manager.t("chat.composer.menu.offlineBlocked")).toBe(
    "Connect to the gateway to change session capabilities.",
  );
  expect(manager.t("chat.workspaceFiles.showFiles")).toBe("Show session files");
  expect(manager.t("chat.workspaceFiles.search")).toBe("chat.workspaceFiles.search");
  expect(manager.t("chat.permissions.tryAgain")).toBe("chat.permissions.tryAgain");
  expect(manager.t("chat.composer.menu.addMcpServer")).toBe("chat.composer.menu.addMcpServer");

  await import("../pages/chat/components/chat-session-workspace-breadcrumb.tsx");
  expect(manager.t("chat.workspaceFiles.search")).toBe("Search files");
  await import("../pages/chat/components/chat-permission-card.tsx");
  expect(manager.t("chat.permissions.tryAgain")).toBe("Try again");
  await import("../pages/chat/components/chat-composer-plus-menu-content.tsx");
  expect(manager.t("chat.composer.menu.addMcpServer")).toBe("Add MCP server");
  registerChatSessionEnglish();
  registerChatComposerEnglish();
  expect(manager.t("chat.workspaceFiles.search")).toBe("Search files");
  expect(manager.t("chat.activityPills.publication.confirm")).toBe("Confirm publication");
  expect(manager.t("chat.composer.menu.addMcpServer")).toBe("Add MCP server");
  expect(manager.t("chat.composer.menu.toolAccess.noTools")).toBe(
    "No tools available for this MCP server.",
  );
  expect(manager.t("chat.composer.menu.back")).toBe("Zurück");
  expect(manager.getLocale()).toBe("de");
  expect(en.chat.permissions).toBe(permissions);
  expect(en.chat.workspaceFiles).toBe(workspaceFiles);
});
