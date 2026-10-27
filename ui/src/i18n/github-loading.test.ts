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
    const namespaces = () => [
      en.githubConnections,
      en.githubPublication,
      en.chat.pullRequests,
      en.sessionHovercard,
      en.sessionHovercard.states,
      en.sessionHovercard.checks,
      en.agentTools,
    ];
    const originalNamespaces = namespaces();
    const expectNamespaces = () => {
      namespaces().forEach((namespace, index) => expect(namespace).toBe(originalNamespaces[index]));
    };
    expect(hovercard.agentNotepad).toBeUndefined();
    expect(t("sessionHovercard.linkedChannel", { channel: "Matrix" })).toBe("Linked to Matrix");
    expect(hovercard.states.open).toBeUndefined();
    expect(pullRequests.publishPr).toBeUndefined();
    expect(t("chat.pullRequests.open")).toBe("Open");
    expect(connections.manage).toBeUndefined();
    expect(publication.failedAttempt).toBeUndefined();
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
    await load().finally(() => registration.mockRestore());
    expectNamespaces();
    expect(t("githubConnections.manage")).toBe("Verbindungen verwalten");
    if (settings) {
      expect(connections.manage).toBe("Manage connections");
      expect(t("agentTools.githubVerify")).toBe("Verify");
      expect(publication.failedAttempt).toBeUndefined();
      expect(pullRequests.publishPr).toBeUndefined();
      expect(hovercard.agentNotepad).toBeUndefined();
      (await import("./locales/en-github-connections.ts")).registerGitHubConnectionsEnglish();
      expectNamespaces();
      expect(t("githubConnections.manage")).toBe("Verbindungen verwalten");
      return;
    }
    expect(connections.manage).toBeUndefined();
    expect(en.agentTools.githubVerify).toBeUndefined();
    expect(t("githubPublication.failedAttempt")).toBe("Publication attempt failed");
    expect(t("sessionHovercard.agentNotepad")).toBe("Task progress");
    expect(t("sessionHovercard.states.open")).toBe("Open");
    expect(t("sessionHovercard.checks.passing")).toBe("CI-Prüfungen erfolgreich");
    expect(t("chat.pullRequests.publishPr")).toBe("Publish PR");
    expect(t("chat.pullRequests.rateLimited")).toContain("GitHub API rate limit reached");
    expect(t("chat.pullRequests.checksPassed")).toBe("Passed");
    if (_surface === "PR content") {
      expect(t("chat.pullRequests.automationLabel")).toBe("chat.pullRequests.automationLabel");
    }
    expect(t("githubPublication.sharedUnavailable.changed")).toBe(
      "The Gateway GitHub account changed. Reload and retry publication.",
    );
    (await import("./locales/en-github.ts")).registerGitHubEnglish();
    expectNamespaces();
    expect(t("sessionHovercard.checks.passing")).toBe("CI-Prüfungen erfolgreich");
    expect(t("githubConnections.manage")).toBe("Verbindungen verwalten");
  },
);
