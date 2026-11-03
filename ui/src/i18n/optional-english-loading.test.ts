/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it("loads inspector-only context copy with the panel while keeping the breakdown readable", async () => {
  const { en, manager } = await loadI18n({
    common: { health: "Gesundheit" },
    chat: { sessionDetails: { context: "Kontext" } },
  });
  const details = en.chat.sessionDetails;
  await manager.setLocale("de");

  await import("../pages/chat/components/chat-context-breakdown.tsx");

  expect(manager.t("chat.sessionDetails.context")).toBe("Kontext");
  expect(manager.t("chat.sessionDetails.contextMessages")).toBe("Messages & other");
  expect(manager.t("chat.sessionDetails.contextFiles")).toBe("Workspace files");
  expect(manager.t("chat.sessionDetails.contextTools")).toBe("Tool schemas");
  expect(manager.t("chat.sessionDetails.contextSkills")).toBe("Skills catalog");
  expect(manager.t("chat.sessionDetails.contextSystem")).toBe("System instructions");
  expect(manager.t("chat.sessionDetails.contextUnverified")).toBe("Unverified");
  expect(manager.t("chat.sessionDetails.contextExactCount", { used: "10", limit: "100" })).toBe(
    "10 of 100 tokens",
  );
  expect(manager.t("chat.sessionDetails.contextOpen")).toBe("View context");
  expect(manager.t("chat.sessionDetails.contextLoading")).toBe("Loading context breakdown…");
  expect(manager.t("chat.sessionDetails.contextError")).toBe(
    "Couldn't load the context breakdown. Try refreshing.",
  );
  expect(manager.t("chat.sessionDetails.contextOffline")).toBe(
    "Connect to the Gateway to load the context breakdown.",
  );
  const inspectorCopy = {
    contextAgentWorkspace: "Agent workspace",
    contextProject: "Project",
    contextPersonal: "Personal instructions",
    contextOtherFiles: "Other files",
    contextSystemTools: "System tools",
    contextMcpTools: "MCP tools",
    contextClientTools: "Client tools",
    contextAvailableOnDemand: "Tools loaded on use",
    contextDeferredEstimate: "Schema sizes, not current usage.",
    contextFree: "Free space",
    contextUnavailable: "No matching context report. Send a message to capture one.",
    contextReserve: "{tokens} tokens reserved outside this budget",
    contextFreeShort: "{tokens} free",
    contextReserveShort: "+{tokens} reserved",
    contextInputShort: "in",
    contextOutputShort: "out",
    contextSearch: "Search {category}",
    contextSearchCount: "Search {count} · {category}",
    contextSearchSkills: "Search {count} skills",
    contextSearchFiles: "Search {count} files",
    contextSearchTools: "Search {count} tools",
    contextShowAll: "Show all {count}",
  };
  for (const key of Object.keys(inspectorCopy)) {
    expect(manager.t(`chat.sessionDetails.${key}`)).toBe(`chat.sessionDetails.${key}`);
  }

  await import("../pages/chat/components/chat-context-panel.tsx");

  for (const [key, copy] of Object.entries(inspectorCopy)) {
    expect(manager.t(`chat.sessionDetails.${key}`)).toBe(copy);
  }
  expect(manager.t("chat.sessionDetails.context")).toBe("Kontext");
  expect(manager.t("common.health")).toBe("Gesundheit");
  expect(manager.getLocale()).toBe("de");
  expect(en.chat.sessionDetails).toBe(details);
});
let restoreElementRegistration: (() => void) | undefined;
beforeEach(() => {
  // Cold imports rerun module registrars; jsdom keeps its element registry.
  // These catalog tests import consumers without mounting their elements.
  const define = customElements.define.bind(customElements);
  const registration = vi
    .spyOn(customElements, "define")
    .mockImplementation((name, constructor, options) => {
      if (!customElements.get(name)) {
        define(name, constructor, options);
      }
    });
  restoreElementRegistration = () => registration.mockRestore();
});
afterEach(() => restoreElementRegistration?.());

it.each([false, true])(
  "preserves context inspector copy in either registration order (optional first=%s)",
  async (optionalFirst) => {
    const { en, manager } = await loadI18n({
      chat: { sessionDetails: { context: "Kontext", contextSearch: "Suchen {category}" } },
    });
    const { registerEnglishCatalog } = await import("../lib/reactive/i18n.ts");
    const { registerChatDetailsEnglish } = await import("./locales/en-chat-details.ts");
    const { registerChatSessionEnglish } = await import("./locales/en-chat-session.ts");
    const { registerChatSessionOptionalEnglish } =
      await import("./locales/en-chat-session-optional.ts");
    await manager.setLocale("de");
    const registrars = [registerChatDetailsEnglish, registerChatSessionOptionalEnglish];
    const ordered = optionalFirst ? registrars.toReversed() : registrars;
    registerEnglishCatalog(ordered[0]!);
    const details = en.chat.sessionDetails;
    registerEnglishCatalog(ordered[1]!);
    registerChatDetailsEnglish();
    registerChatSessionEnglish();

    expect(manager.t("chat.sessionDetails.contextProject")).toBe("Project");
    expect(manager.t("chat.sessionDetails.contextFreeShort", { tokens: "1k" })).toBe("1k free");
    expect(manager.t("chat.sessionDetails.contextSearch", { category: "Skills" })).toBe(
      "Suchen Skills",
    );
    expect(manager.t("chat.sessionDetails.context")).toBe("Kontext");
    expect(manager.t("chat.sessionDetails.contextMessages")).toBe("Messages & other");
    expect(manager.t("chat.sessionDetails.contextLoading")).toBe("Loading context breakdown…");
    expect(manager.t("chat.sessionDetails.title")).toBe("Details");
    expect(manager.getLocale()).toBe("de");
    expect(en.chat.sessionDetails).toBe(details);
  },
);

it.each([
  [
    "chat.sessionSharing.copyPublicLink",
    "Copy public link",
    () => import("../pages/chat/components/chat-session-sharing-content.tsx"),
  ],
  [
    "chat.sessionSharing.publishDraft",
    "Publish draft",
    () => import("../pages/chat/components/chat-session-sharing-menu.tsx"),
  ],
  [
    "chat.sessionSharing.noPeople",
    "No paired people found.",
    () => import("../pages/chat/components/chat-session-sharing-mobile.tsx"),
  ],
  [
    "chat.sessionSharing.publicConfirmEnable",
    "Make public",
    () => import("../pages/chat/chat-pane-sharing-operations.ts"),
  ],
  [
    "chat.subagentsPanel.empty",
    "No subagents in this conversation.",
    () => import("../pages/chat/components/chat-subagents-panel.tsx"),
  ],
  [
    "chat.subagentsPanel.desktopFor",
    "for",
    () => import("../pages/chat/components/chat-subagents-panel-desktop.tsx"),
  ],
  [
    "chat.subagentsPanel.nativeTitle",
    "Live native agents",
    () => import("../pages/chat/components/chat-subagents-native.tsx"),
  ],
  [
    "chat.subagentsPanel.workingFor",
    "Working for",
    () => import("../pages/chat/components/chat-subagents-mobile.tsx"),
  ],
  [
    "chat.sessionHeader.continueInTerminal.title",
    "Continue in terminal",
    () => import("../pages/chat/components/continue-in-terminal-dialog.tsx"),
  ],
] as const)("loads cold owner copy only with its consumer: %s", async (key, copy, load) => {
  const { en, manager } = await loadI18n({ common: { health: "Gesundheit" } });
  const { registerEnglishCatalog } = await import("../lib/reactive/i18n.ts");
  const { registerChatSessionEnglish } = await import("./locales/en-chat-session.ts");
  registerEnglishCatalog(registerChatSessionEnglish);
  const sharing = en.chat.sessionSharing;
  const subagents = en.chat.subagentsPanel;
  const terminal = en.chat.sessionHeader.continueInTerminal;
  await manager.setLocale("de");
  expect(manager.t(key)).toBe(key);

  await load();

  expect(manager.t(key)).toBe(copy);
  if (key.startsWith("chat.sessionSharing.")) {
    expect(manager.t("chat.sessionDetails.contextProject")).toBe(
      "chat.sessionDetails.contextProject",
    );
    expect(manager.t("chat.sessionDiff.modeUnified")).toBe("chat.sessionDiff.modeUnified");
  } else {
    expect(manager.t("chat.sessionSharing.copyPublicLink")).toBe(
      "chat.sessionSharing.copyPublicLink",
    );
  }
  expect(manager.t("chat.sessionSharing.publicIndicator")).toBe("Public");
  expect(manager.t("chat.subagentsPanel.stop", { name: "Build" })).toBe("Stop Build");
  expect(manager.t("chat.sessionHeader.continueInTerminal.action")).toBe("Continue in terminal…");
  expect(manager.t("common.health")).toBe("Gesundheit");
  expect(manager.getLocale()).toBe("de");
  expect(en.chat.sessionSharing).toBe(sharing);
  expect(en.chat.subagentsPanel).toBe(subagents);
  expect(en.chat.sessionHeader.continueInTerminal).toBe(terminal);
});

it.each([false, true])(
  "preserves sharing, subagent, and terminal catalogs when leaves load first=%s",
  async (leavesFirst) => {
    const { en, manager } = await loadI18n({
      chat: {
        sessionSharing: { visibility: "Sichtbarkeit" },
        subagentsPanel: { empty: "Keine Subagents.", nativeStatus: { running: "Läuft" } },
        sessionHeader: { continueInTerminal: { authNote: "Ohne Zugangsdaten." } },
      },
    });
    const { registerEnglishCatalog } = await import("../lib/reactive/i18n.ts");
    const { registerChatSessionEnglish } = await import("./locales/en-chat-session.ts");
    const { registerChatSessionOptionalEnglish } =
      await import("./locales/en-chat-session-optional.ts");
    const { registerChatSessionSharingEnglish } =
      await import("./locales/en-chat-session-sharing.ts");
    await manager.setLocale("de");
    const registrars = [
      registerChatSessionEnglish,
      registerChatSessionOptionalEnglish,
      registerChatSessionSharingEnglish,
    ];
    const ordered = leavesFirst ? registrars.toReversed() : registrars;
    registerEnglishCatalog(ordered[0]!);
    const sharing = en.chat.sessionSharing;
    const panel = en.chat.subagentsPanel;
    const header = en.chat.sessionHeader;
    const terminal = header.continueInTerminal;
    for (const register of ordered.slice(1)) {
      registerEnglishCatalog(register);
    }
    registerChatSessionEnglish();

    expect(manager.t("chat.sessionSharing.copyPublicLink")).toBe("Copy public link");
    expect(manager.t("chat.sessionSharing.publicIndicator")).toBe("Public");
    expect(manager.t("chat.sessionSharing.visibility")).toBe("Sichtbarkeit");
    expect(manager.t("chat.sessionHeader.continueInTerminal.title")).toBe("Continue in terminal");
    expect(manager.t("chat.sessionHeader.continueInTerminal.action")).toBe("Continue in terminal…");
    expect(manager.t("chat.sessionHeader.continueInTerminal.authNote")).toBe("Ohne Zugangsdaten.");
    expect(manager.t("chat.subagentsPanel.nativeTitle")).toBe("Live native agents");
    expect(manager.t("chat.subagentsPanel.empty")).toBe("Keine Subagents.");
    expect(manager.t("chat.subagentsPanel.nativeStatus.running")).toBe("Läuft");
    expect(manager.t("chat.subagentsPanel.stop", { name: "Build" })).toBe("Stop Build");
    expect(manager.getLocale()).toBe("de");
    expect(en.chat.subagentsPanel).toBe(panel);
    expect(en.chat.sessionSharing).toBe(sharing);
    expect(en.chat.sessionHeader).toBe(header);
    expect(en.chat.sessionHeader.continueInTerminal).toBe(terminal);
    const status = panel.nativeStatus;
    const filters = panel.desktopFilter;
    registerChatSessionOptionalEnglish();
    expect(en.chat.subagentsPanel.nativeStatus).toBe(status);
    expect(en.chat.subagentsPanel.desktopFilter).toBe(filters);
  },
);

it.each([false, true])(
  "merges conflict notice copy without replacing transcript copy (optional first=%s)",
  async (optionalFirst) => {
    const { en, manager } = await loadI18n({
      chat: { workspaceConflict: { summary: "Lokale Versionen beibehalten." } },
    });
    const { registerEnglishCatalog } = await import("../lib/reactive/i18n.ts");
    const { registerChatSessionEnglish } = await import("./locales/en-chat-session.ts");
    const { registerChatSessionOptionalEnglish } =
      await import("./locales/en-chat-session-optional.ts");
    await manager.setLocale("de");
    const registrars = [registerChatSessionEnglish, registerChatSessionOptionalEnglish];
    const ordered = optionalFirst ? registrars.toReversed() : registrars;
    registerEnglishCatalog(ordered[0]!);
    const namespace = en.chat.workspaceConflict;
    registerEnglishCatalog(ordered[1]!);
    registerChatSessionEnglish();

    expect(manager.t("chat.workspaceConflict.summary")).toBe("Lokale Versionen beibehalten.");
    expect(manager.t("chat.workspaceConflict.showCommands")).toBe("Show commands");
    expect(manager.t("chat.workspaceConflict.eventTitleOne")).toBe(
      "Cloud result applied with 1 conflict",
    );
    expect(manager.t("chat.workspaceConflict.stagedResult")).toBe("Staged cloud result");
    expect(manager.t("chat.workspaceConflict.morePaths", { count: "2" })).toBe("+2 more paths");
    expect(manager.getLocale()).toBe("de");
    expect(en.chat.workspaceConflict).toBe(namespace);
  },
);

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
    import("../pages/chat/components/chat-model-account-control.ts"),
    import("../pages/chat/chat-pane-native-session-actions.ts"),
    import("../pages/chat/chat-pane-placement.ts"),
  ]);

  expect(manager.t("sessionsView.searchGroups")).toBe("sessionsView.searchGroups");
  expect(manager.t("sessionsView.all")).toBe("All");
  expect(manager.t("sessionsView.snoozed")).toBe("Snoozed");
  expect(manager.t("sessionsView.personalGroupNew")).toBe("New section");
  expect(manager.t("sessionsView.personalGroupEdit")).toBe("sessionsView.personalGroupEdit");
  expect(manager.t("sessionsView.archiveReasonManual")).toBe("Archived manually");
  expect(manager.t("sessionsView.stopCloudWorkerConfirm", { session: "Build" })).toBe(
    'Stop the cloud worker for "Build"?',
  );
  expect(manager.t("sessionsView.goal")).toBe("Ziel");
  expect(en.sessionsView).toBe(sessionsView);
  expect(manager.t("profilePage.modelAccounts.loadMore")).toBe("Load more saved accounts");
  expect(manager.t("profilePage.modelAccounts.inventoryFailed")).toBe(
    "Could not load saved accounts. Refresh to retry.",
  );
  expect(manager.t("profilePage.modelAccounts.connectAction")).toBe(
    "profilePage.modelAccounts.connectAction",
  );

  await import("../components/session-menu-view.tsx");
  expect(manager.t("sessionsView.searchGroups")).toBe("Search groups");
  expect(manager.t("sessionsView.snoozeThreeHours")).toBe("In 3 hours");
  expect(manager.t("sessionsView.communication.receive")).toBe("Receive messages");
  expect(manager.t("sessionsView.colors.blue")).toBe("Blue");
  expect(manager.t("sessionsView.personalGroupEdit")).toBe("sessionsView.personalGroupEdit");

  await import("../components/personal-session-group-dialog-view.tsx");
  expect(manager.t("sessionsView.personalGroupEdit")).toBe("Edit section");
  expect(manager.t("sessionsView.searchGroups")).toBe("Search groups");
  expect(manager.t("sessionsView.goal")).toBe("Ziel");
  expect(manager.getLocale()).toBe("de");
  expect(en.sessionsView).toBe(sessionsView);

  await import("../pages/profile/model-accounts.tsx");
  expect(manager.t("profilePage.modelAccounts.connectAction")).toBe("Sign in");
});

it("loads people-picker copy with session menu details before any sharing menu", async () => {
  const { manager } = await loadI18n({ sessionsView: { searchPeople: "Personen suchen" } });
  await manager.setLocale("de");
  expect(manager.t("sessionsView.noPeopleMatch")).toBe("sessionsView.noPeopleMatch");

  await import("../components/session-menu-details-solid.tsx");

  expect(manager.t("sessionsView.searchPeople")).toBe("Personen suchen");
  expect(manager.t("sessionsView.noPeopleMatch")).toBe("No matching people or agents");
  expect(manager.t("chat.sessionSharing.copyPublicLink")).toBe(
    "chat.sessionSharing.copyPublicLink",
  );
});

it("loads workspace actions with the session menu before session management", async () => {
  const { manager } = await loadI18n();

  await import("../components/session-menu-solid.tsx");

  expect(manager.t("sessionsView.openPullRequest")).toBe("Open PR");
  expect(manager.t("sessionsView.stopCloudWorker")).toBe("Stop cloud worker…");
  expect(manager.t("sessionsView.groupDefaultsTitle")).toBe("sessionsView.groupDefaultsTitle");
});

it("loads the new-section title with its dialog before any session menu", async () => {
  const { manager } = await loadI18n();

  await import("../components/personal-session-group-dialog-view.tsx");

  expect(manager.t("sessionsView.personalGroupNew")).toBe("New section");
  expect(manager.t("sessionsView.personalGroupEdit")).toBe("Edit section");
  expect(manager.t("sessionsView.searchGroups")).toBe("sessionsView.searchGroups");
});

it.each([false, true])(
  "keeps menu and management copy after both load (menu first=%s)",
  async (menuFirst) => {
    const { en, manager } = await loadI18n({ sessionsView: { snooze: "Schlummern" } });
    const { registerEnglishCatalog } = await import("../lib/reactive/i18n.ts");
    const { registerSessionMenuEnglish } = await import("./locales/en-session-menu.ts");
    const { registerSessionOrganizationEnglish } =
      await import("./locales/en-session-organization.ts");
    const namespace = en.sessionsView;
    await manager.setLocale("de");
    const registrars = [registerSessionOrganizationEnglish, registerSessionMenuEnglish];
    for (const register of menuFirst ? registrars.toReversed() : registrars) {
      registerEnglishCatalog(register);
    }

    expect(manager.t("sessionsView.snooze")).toBe("Schlummern");
    expect(manager.t("sessionsView.searchGroups")).toBe("Search groups");
    expect(manager.t("sessionsView.communication.send")).toBe("Send messages");
    expect(manager.t("sessionsView.personalGroupEdit")).toBe("Edit section");
    expect(manager.t("sessionsView.groupDefaultsTitle", { group: "Build" })).toBe(
      'New session defaults for "Build"',
    );
    expect(manager.getLocale()).toBe("de");
    expect(en.sessionsView).toBe(namespace);
  },
);

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
