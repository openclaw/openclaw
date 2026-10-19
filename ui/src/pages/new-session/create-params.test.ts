// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { NewSessionCapabilities } from "./capabilities.ts";
import { buildDraftSessionCreateParams } from "./create-params.ts";

describe("create-as-draft availability", () => {
  const capabilities = new NewSessionCapabilities(
    () => {},
    () => {},
  );
  const canStartSessionAsDraft = (allowedSessionVisibilities?: string[]) =>
    capabilities.canStartAsDraft({
      gateway: {
        snapshot: {
          hello: {
            policy: {
              allowedSessionVisibilities,
              hasMultipleSessionSharingIdentities: true,
            },
          },
        },
      },
    } as ApplicationContext);
  it("requires both draft policy and multiple creator identities", () => {
    expect(canStartSessionAsDraft(["shared", "draft"])).toBe(true);
    expect(canStartSessionAsDraft(["shared"])).toBe(false);
    expect(canStartSessionAsDraft()).toBe(false);
  });
});

type Draft = Parameters<typeof buildDraftSessionCreateParams>[0];
function expectParams(input: Partial<Draft>, output: object) {
  expect(
    buildDraftSessionCreateParams({ agentId: "main", message: "task", worktree: false, ...input }),
  ).toEqual({ agentId: "main", message: "task", ...output });
}

describe("buildDraftSessionCreateParams", () => {
  const repository = { url: "https://github.com/openclaw/openclaw.git", ref: "release" };
  const checkout = {
    projectId: "old-clone",
    projectGitUrl: repository.url,
    cwd: "/old/checkout",
    workspace: "/workspace",
    baseRef: "old-branch",
    worktreeName: "old-name",
  };
  const attachments = [
    { type: "image", mimeType: "image/png", fileName: "pixel.png", content: "aGVsbG8=" },
  ];
  const overrides = {
    model: "anthropic/claude-sonnet-4-6",
    contextWindow: "200k",
    thinkingLevel: "high",
    fastMode: true,
  };
  const toolOverrides = {
    mcpServers: { github: false },
    skills: { release: false },
    webSearch: false,
  };
  it.each([
    [
      "creates a device folder without leaking another workspace source",
      {
        ...checkout,
        repository,
        message: "Work here",
        deferInitialTurn: true,
        deviceFolder: { deviceId: "runner", path: " /srv/existing project " },
        worktree: true,
        worktreeSource: "empty",
      },
      {
        message: "",
        titleSource: "Work here",
        deviceFolder: { deviceId: "runner", path: "/srv/existing project" },
      },
    ],
    [
      "creates an empty workspace without carrying a previous checkout source",
      {
        ...checkout,
        repository,
        message: "Start a new project",
        deferInitialTurn: true,
        worktree: true,
        worktreeSource: "empty",
      },
      { message: "", titleSource: "Start a new project", worktree: true, worktreeSource: "empty" },
    ],
    [
      "retains a cloud repository without sending local checkout options",
      {
        ...checkout,
        repository,
        message: `${"x".repeat(999)}🦞 longer prompt`,
        deferInitialTurn: true,
        worktree: true,
      },
      { message: "", titleSource: "x".repeat(999), repository },
    ],
    [
      "keeps incognito prompts out of early naming",
      {
        message: "private task",
        deferInitialTurn: true,
        visibility: "incognito",
      },
      { message: "", incognito: true },
    ],
    ["adds draft visibility only when selected", { visibility: "draft" }, { visibility: "draft" }],
    [
      "includes initial-message attachments",
      { message: "", attachments },
      { message: "", attachments },
    ],
    ["includes model, context-window, thinking, and fast overrides", overrides, overrides],
    [
      "includes capability overrides in the atomic create request",
      { toolOverrides },
      { toolOverrides },
    ],
    [
      "does not combine a catalog target with a draft model override",
      {
        model: "openai/gpt-5.5",
        contextWindow: "200k",
        thinkingLevel: "medium",
        fastMode: true,
        catalogId: "claude",
      },
      { catalogId: "claude" },
    ],
    [
      "maps worktree selections onto additive create params",
      {
        worktree: true,
        baseRef: "origin/main",
        worktreeName: "bug-fix",
        cwd: "/workspace",
        workspace: "/workspace",
      },
      { worktree: true, worktreeBaseRef: "origin/main", worktreeName: "bug-fix" },
    ],
    [
      "assigns a session created from a custom group",
      {
        worktree: true,
        cwd: "/repos/client",
        workspace: "/workspace",
        category: " Client work ",
      },
      { category: "Client work", cwd: "/repos/client", worktree: true },
    ],
    [
      "submits a selected project by id without leaking its host path",
      {
        projectId: "openclaw",
        worktree: true,
        cwd: "/recorded/openclaw",
        workspace: "/workspace",
      },
      { projectId: "openclaw", worktree: true },
    ],
  ] satisfies [string, Partial<Draft>, object][])("%s", (_, input, output) =>
    expectParams(input, output),
  );
});
