// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionCreateParams } from "../../lib/sessions/create.ts";
import { NewSessionCapabilities } from "./capabilities.ts";
import type { NewSessionVisibility } from "./create-params.ts";
import { buildSelectedSessionCreateParams } from "./draft-create-params.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";

afterEach(() => vi.restoreAllMocks());

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

type Draft = Omit<SessionCreateParams, "visibility"> & {
  visibility?: NewSessionVisibility;
  deferInitialTurn?: boolean;
  workspace?: string;
  baseRef?: string;
};
function expectParams(input: Partial<Draft>, output: object) {
  const { state, browser } = createRepositoryFixture();
  vi.spyOn(state, "agentId", "get").mockReturnValue(input.agentId ?? "main");
  vi.spyOn(state, "remotePlacement", "get").mockReturnValue(input.deferInitialTurn ?? false);
  vi.spyOn(state, "remoteRepository", "get").mockReturnValue(input.repository);
  vi.spyOn(state, "deviceFolder", "get").mockReturnValue(input.deviceFolder);
  vi.spyOn(state, "worktree", "get").mockReturnValue(input.worktree ?? false);
  vi.spyOn(state, "freshWorkspace", "get").mockReturnValue(input.worktreeSource === "empty");
  vi.spyOn(state, "baseRef", "get").mockReturnValue(input.baseRef ?? "");
  vi.spyOn(state, "worktreeName", "get").mockReturnValue(input.worktreeName ?? "");
  vi.spyOn(state, "folder", "get").mockReturnValue(input.cwd ?? "");
  vi.spyOn(state, "workspacePath").mockReturnValue(input.workspace ?? "");
  vi.spyOn(browser, "projectId", "get").mockReturnValue(input.projectId ?? "");
  vi.spyOn(browser, "remoteProject", "get").mockReturnValue(
    input.projectGitUrl ? { identity: "fixture", cloneUrl: input.projectGitUrl } : null,
  );
  vi.spyOn(state.modelControl, "modelForSubmission").mockReturnValue(input.model ?? "");
  Object.assign(state.modelControl, {
    agentRuntime: input.agentRuntime,
    contextWindow: input.contextWindow ?? "",
    thinkingLevel: input.thinkingLevel ?? "",
    fastMode: input.fastMode,
    cyberAccessProgram: input.cyberAccessProgram,
  });
  try {
    expect(
      buildSelectedSessionCreateParams(state, {
        ...input,
        message: input.message ?? "task",
        visibility: input.visibility ?? "normal",
      }),
    ).toEqual({ agentId: "main", message: "task", ...output });
  } finally {
    state.modelControl.reset();
  }
}

describe("buildSelectedSessionCreateParams", () => {
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
    cyberAccessProgram: "daybreak_blue" as const,
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
    ["includes model, context-window, thinking, fast, and access overrides", overrides, overrides],
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
        cyberAccessProgram: "daybreak_blue",
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
