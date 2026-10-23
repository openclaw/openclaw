import { expect, it, vi } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it.each([
  ["publication", false, () => import("../pages/chat/components/chat-github-publication.tsx")],
  ["PR content", false, () => import("../pages/chat/components/chat-pull-requests-content.tsx")],
  ["connections", true, () => import("../features/github-connections/github-connections.tsx")],
  ["CI details", false, () => import("../pages/chat/components/chat-ci-details.tsx")],
  ["session hovercard", false, () => import("../components/session-hovercard-solid.tsx")],
  ["identity", true, () => import("../features/github-connections/github-identity-view.tsx")],
  ["identity controller", true, () => import("../features/github-connections/github-identity.ts")],
])(
  "loads only the GitHub fallback copy needed at the cold %s boundary",
  async (_surface, settings, load) => {
    const { en, manager } = await loadI18n({
      githubConnections: { manage: "Verbindungen verwalten" },
      sessionHovercard: { checks: { passing: "CI-Prüfungen erfolgreich" } },
    });
    const t = manager.t.bind(manager);
    const { githubConnections: connections, githubPublication: publication } = en;
    const pullRequests = en.chat.pullRequests;
    const hovercard = en.sessionHovercard;
    const { states, checks } = hovercard;
    expect(hovercard.agentNotepad).toBeUndefined();
    expect(hovercard.chatKinds).toBeUndefined();
    expect(t("sessionHovercard.linkedChannel", { channel: "Matrix" })).toBe("Linked to Matrix");
    expect(t("sessionHovercard.moreParticipantsLabel", { count: "3" })).toBe("3 more participants");
    expect(hovercard.pullRequestLabel).toBeUndefined();
    expect(states.open).toBeUndefined();
    expect(pullRequests.publishPr).toBeUndefined();
    expect(t("chat.pullRequests.open")).toBe("Open");
    expect(pullRequests.createPr).toBeUndefined();
    expect(pullRequests.rateLimited).toBeUndefined();
    expect(pullRequests.checksPassed).toBeUndefined();
    expect(connections.manage).toBeUndefined();
    expect(publication.failedAttempt).toBeUndefined();
    expect(t("githubPublication.newAction")).toBe("Choose a new publication");
    expect(t("githubPublication.capacity", { newAction: "Next" })).toContain("Next");
    expect(
      ["title", "mine", "system", "forMe", "forSystem"].map((key) => t("githubConnections." + key)),
    ).toEqual(["GitHub connections", "My GitHub", "System GitHub", "For me", "For the system"]);
    await manager.setLocale("de");
    // Preserve dependency registrations across cold imports; skip already-defined elements.
    const define = customElements.define.bind(customElements);
    const registration = vi
      .spyOn(customElements, "define")
      .mockImplementation((name, constructor, options) => {
        if (!customElements.get(name)) {
          define(name, constructor, options);
        }
      });
    try {
      await load();
    } finally {
      registration.mockRestore();
    }
    expect(en.githubConnections).toBe(connections);
    expect(en.githubPublication).toBe(publication);
    expect(t("githubConnections.manage")).toBe("Verbindungen verwalten");
    if (settings) {
      expect(connections.manage).toBe("Manage connections");
      expect(t("agentTools.githubVerify")).toBe("Verify");
      expect(publication.failedAttempt).toBeUndefined();
      expect(pullRequests.publishPr).toBeUndefined();
      expect(hovercard.agentNotepad).toBeUndefined();
      const agentTools = en.agentTools;
      const copy = await import("./locales/en-github-connections.ts");
      copy.registerGitHubConnectionsEnglish();
      expect(en.githubConnections).toBe(connections);
      expect(en.agentTools).toBe(agentTools);
      expect(t("githubConnections.manage")).toBe("Verbindungen verwalten");
      return;
    }
    expect(connections.manage).toBeUndefined();
    expect(en.agentTools.githubVerify).toBeUndefined();
    expect(t("githubPublication.failedAttempt")).toBe("Publication attempt failed");
    expect(en.chat.pullRequests).toBe(pullRequests);
    expect(en.sessionHovercard).toBe(hovercard);
    expect(hovercard.states).toBe(states);
    expect(hovercard.checks).toBe(checks);
    expect(t("sessionHovercard.agentNotepad")).toBe("Task progress");
    expect(t("sessionHovercard.chatKinds.group")).toBe("Group chat");
    expect(t("sessionHovercard.viaAccount", { account: "work" })).toBe("Via work");
    expect(t("sessionHovercard.topicNumber", { id: "7" })).toBe("Topic 7");
    expect(t("sessionHovercard.sessionParticipants")).toBe("In this session");
    expect(t("sessionHovercard.attributionOther", { count: "1" })).toBe("& 1 other");
    expect(t("sessionHovercard.attributionOthers", { count: "2" })).toBe("& 2 others");
    expect(t("sessionHovercard.states.open")).toBe("Open");
    expect(t("sessionHovercard.checks.passing")).toBe("CI-Prüfungen erfolgreich");
    expect(t("chat.pullRequests.publishPr")).toBe("Publish PR");
    expect(t("chat.pullRequests.createPr")).toBe("Create PR");
    expect(t("chat.pullRequests.rateLimited")).toContain("GitHub API rate limit reached");
    expect(t("chat.pullRequests.checksPassing")).toBe("CI checks passing");
    expect(t("chat.pullRequests.checksPassed")).toBe("Passed");
    expect(t("githubPublication.sharedUnavailable.changed")).toBe(
      "The Gateway GitHub account changed. Reload and retry publication.",
    );
    const { registerGitHubEnglish } = await import("./locales/en-github.ts");
    registerGitHubEnglish();
    expect(hovercard.states).toBe(states);
    expect(hovercard.checks).toBe(checks);
    expect(t("sessionHovercard.checks.passing")).toBe("CI-Prüfungen erfolgreich");
    expect(en.chat.pullRequests).toBe(pullRequests);
    expect(t("chat.pullRequests.open")).toBe("Open");
    expect(en.githubConnections).toBe(connections);
    expect(en.githubPublication).toBe(publication);
    expect(t("githubConnections.manage")).toBe("Verbindungen verwalten");
  },
);
