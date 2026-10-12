import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();
let registryFrame: HTMLIFrameElement;

beforeEach(() => {
  // Cold module imports also need a fresh native custom-element registry.
  registryFrame = document.createElement("iframe");
  document.body.append(registryFrame);
  vi.stubGlobal("customElements", registryFrame.contentWindow!.customElements);
});

afterEach(() => {
  vi.unstubAllGlobals();
  registryFrame.remove();
});

it.each([
  {
    surface: "publication",
    load: () => import("../pages/chat/components/chat-github-publication.ts"),
  },
  {
    surface: "pull requests",
    load: () => import("../pages/chat/components/chat-pull-requests.ts"),
  },
  {
    surface: "connections",
    load: () => import("../features/github-connections/github-connections.ts"),
  },
  {
    surface: "CI details",
    load: () => import("../pages/chat/components/chat-ci-details.ts"),
  },
  {
    surface: "session hovercard",
    load: () => import("../components/session-hovercard-solid.tsx"),
  },
  {
    surface: "identity",
    load: () => import("../features/github-connections/github-identity-view.ts"),
  },
])("loads GitHub fallback copy at the cold $surface boundary", async ({ load }) => {
  const { en, manager } = await loadI18n({
    githubConnections: { manage: "Verbindungen verwalten" },
    sessionHovercard: { checks: { passing: "CI-Prüfungen erfolgreich" } },
  });
  const connections = en.githubConnections;
  const publication = en.githubPublication;
  const pullRequests = en.chat.pullRequests;
  const hovercard = en.sessionHovercard;
  const states = hovercard.states;
  const checks = hovercard.checks;
  expect(hovercard.agentNotepad).toBeUndefined();
  expect(hovercard.chatKinds).toBeUndefined();
  expect(manager.t("sessionHovercard.linkedChannel", { channel: "Matrix" })).toBe(
    "Linked to Matrix",
  );
  expect(manager.t("sessionHovercard.moreParticipantsLabel", { count: "3" })).toBe(
    "3 more participants",
  );
  expect(hovercard.pullRequestLabel).toBeUndefined();
  expect(states.open).toBeUndefined();
  expect(pullRequests.publishPr).toBeUndefined();
  expect(manager.t("chat.pullRequests.open")).toBe("Open");
  expect(pullRequests.createPr).toBeUndefined();
  expect(pullRequests.rateLimited).toBeUndefined();
  expect(pullRequests.checksPassed).toBeUndefined();
  expect(connections.manage).toBeUndefined();
  expect(publication.failedAttempt).toBeUndefined();
  expect(manager.t("githubPublication.newAction")).toBe("Choose a new publication");
  expect(manager.t("githubPublication.capacity", { newAction: "Next" })).toContain("Next");
  expect(
    ["title", "mine", "system", "forMe", "forSystem"].map((key) =>
      manager.t("githubConnections." + key),
    ),
  ).toEqual(["GitHub connections", "My GitHub", "System GitHub", "For me", "For the system"]);
  await manager.setLocale("de");
  await load();
  expect(en.githubConnections).toBe(connections);
  expect(en.githubPublication).toBe(publication);
  expect(manager.t("githubConnections.manage")).toBe("Verbindungen verwalten");
  expect(manager.t("githubPublication.failedAttempt")).toBe("Publication attempt failed");
  expect(en.chat.pullRequests).toBe(pullRequests);
  expect(en.sessionHovercard).toBe(hovercard);
  expect(hovercard.states).toBe(states);
  expect(hovercard.checks).toBe(checks);
  expect(manager.t("sessionHovercard.agentNotepad")).toBe("Agent Notepad");
  expect(manager.t("sessionHovercard.chatKinds.group")).toBe("Group chat");
  expect(manager.t("sessionHovercard.viaAccount", { account: "work" })).toBe("Via work");
  expect(manager.t("sessionHovercard.topicNumber", { id: "7" })).toBe("Topic 7");
  expect(manager.t("sessionHovercard.sessionParticipants")).toBe("In this session");
  expect(manager.t("sessionHovercard.attributionOther", { count: "1" })).toBe("& 1 other");
  expect(manager.t("sessionHovercard.attributionOthers", { count: "2" })).toBe("& 2 others");
  expect(manager.t("sessionHovercard.states.open")).toBe("Open");
  expect(manager.t("sessionHovercard.checks.passing")).toBe("CI-Prüfungen erfolgreich");
  expect(manager.t("chat.pullRequests.publishPr")).toBe("Publish PR");
  expect(manager.t("chat.pullRequests.createPr")).toBe("Create PR");
  expect(manager.t("chat.pullRequests.rateLimited")).toContain("GitHub API rate limit reached");
  expect(manager.t("chat.pullRequests.checksPassing")).toBe("CI checks passing");
  expect(manager.t("chat.pullRequests.checksPassed")).toBe("Passed");
  expect(manager.t("githubPublication.sharedUnavailable.changed")).toBe(
    "The Gateway GitHub account changed. Reload and retry publication.",
  );
  const { registerGitHubEnglish } = await import("./locales/en-github.ts");
  registerGitHubEnglish();
  expect(hovercard.states).toBe(states);
  expect(hovercard.checks).toBe(checks);
  expect(manager.t("sessionHovercard.checks.passing")).toBe("CI-Prüfungen erfolgreich");
  expect(en.chat.pullRequests).toBe(pullRequests);
  expect(manager.t("chat.pullRequests.open")).toBe("Open");
  expect(en.githubConnections).toBe(connections);
  expect(en.githubPublication).toBe(publication);
  expect(manager.t("githubConnections.manage")).toBe("Verbindungen verwalten");
});
