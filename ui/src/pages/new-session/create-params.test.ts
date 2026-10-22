// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionCreateParams } from "../../lib/sessions/create.ts";
import { NewSessionCapabilities } from "./capabilities.ts";
import type { NewSessionVisibility } from "./create-params.ts";
import { buildSelectedSessionCreateParams } from "./draft-create-params.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";

afterEach(() => vi.restoreAllMocks());

it("requires draft policy and multiple creator identities", () => {
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
  expect(canStartSessionAsDraft(["shared", "draft"])).toBe(true);
  expect(canStartSessionAsDraft(["shared"])).toBe(false);
  expect(canStartSessionAsDraft()).toBe(false);
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
  };
  const toolOverrides = {
    mcpServers: { github: false },
    skills: { release: false },
    webSearch: false,
  };
  it.each([
    [
      "device folder excludes other sources",
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
      "empty workspace excludes checkout",
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
      "cloud repository excludes local checkout",
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
      "incognito suppresses early naming",
      {
        message: "private task",
        deferInitialTurn: true,
        visibility: "incognito",
      },
      { message: "", incognito: true },
    ],
    ["draft visibility", { visibility: "draft" }, { visibility: "draft" }],
    ["initial attachments", { message: "", attachments }, { message: "", attachments }],
    ["model overrides", overrides, overrides],
    ["capability overrides", { toolOverrides }, { toolOverrides }],
    [
      "catalog excludes model overrides",
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
      "worktree params",
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
      "custom group",
      {
        worktree: true,
        cwd: "/repos/client",
        workspace: "/workspace",
        category: " Client work ",
      },
      { category: "Client work", cwd: "/repos/client", worktree: true },
    ],
    [
      "project id excludes host path",
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
