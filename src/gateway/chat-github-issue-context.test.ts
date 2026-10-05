import { isRecord as recordShapeMatches } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../auto-reply/templating.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import * as sessionFacts from "./session-sharing-preparation.js";

const mocks = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  getWorkspace: vi.fn(),
  parseTarget: vi.fn(),
  prepareIdentity: vi.fn(),
  readJson: vi.fn(),
}));

vi.mock("../state/session-repository-workspaces.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session-repository-workspaces.js")>()),
  getSessionRepositoryWorkspaceStore: () => ({ get: mocks.getWorkspace }),
}));
vi.mock("./project-github-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./project-github-identity.js")>()),
  prepareGatewayProjectGitHubIdentity: mocks.prepareIdentity,
}));
vi.mock("./github-public-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-public-api.js")>()),
  gitHubPublicApi: {
    GITHUB_API_BASE_URL: "https://api.microsoft.ghe.com",
    ControlUiGitHubError: class extends Error {
      constructor(
        readonly statusCode: number,
        message: string,
      ) {
        super(message);
      }
    },
    fetchGitHubApi: mocks.fetchApi,
    isRecord: recordShapeMatches,
    optionalNumber: (value: Record<string, unknown>, key: string) =>
      typeof value[key] === "number" ? value[key] : undefined,
    parseGitHubTarget: mocks.parseTarget,
    readGitHubJsonResponse: mocks.readJson,
    readOptionalGitHubString: (value: Record<string, unknown>, key: string) =>
      typeof value[key] === "string" && value[key] ? value[key] : undefined,
    requiredString: (value: Record<string, unknown>, key: string) => {
      const result = value[key];
      if (typeof result !== "string" || !result) {
        throw new Error(`missing ${key}`);
      }
      return result;
    },
  },
}));

import { attachSessionGitHubIssueContext } from "./chat-github-issue-context.js";

describe("Gateway GitHub issue context", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfigSnapshot({ gateway: { github: { host: "microsoft.ghe.com" } } });
    mocks.parseTarget.mockImplementation((value) => value);
    mocks.fetchApi.mockResolvedValue(new Response());
    mocks.readJson.mockReset();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("leaves disabled native issue reads without session or credential preparation", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const prepareFacts = vi.spyOn(sessionFacts, "prepareSessionMutationFacts");
    mocks.getWorkspace.mockReturnValue({
      agentId: "main",
      url: "https://microsoft.ghe.com/example/project.git",
    });
    mocks.prepareIdentity.mockResolvedValue(undefined);
    const templateContext: TemplateContext = {};
    await attachSessionGitHubIssueContext({
      agentId: "main",
      client: null,
      sessionKey: "agent:main:not-created",
      sessionId: "not-created",
      assertActive: () => {},
      config: {},
      context: { getRuntimeConfig: () => ({}) },
      message: "Read https://microsoft.ghe.com/example/project/issues/101",
      repositoryWorkspaceId: "workspace-1",
      templateContext,
    });
    expect(prepareFacts).not.toHaveBeenCalled();
    expect(mocks.fetchApi).not.toHaveBeenCalled();
    expect(templateContext).toEqual({});
  });

  it.each([
    { message: "Read https://microsoft.ghe.com/example/project/issues/101.", accepted: true },
    { message: "Read https://microsoft.ghe.com/example/project/issues/00101.", accepted: true },
    { message: "https://github.com/example/project/issues/101", accepted: false },
    { message: "https://microsoft.ghe.com/example/other/issues/101", accepted: false },
    { message: "https://microsoft.ghe.com/example/project/pull/101", accepted: false },
    {
      message: "https://microsoft.ghe.com/example/project/issues/101?token=private",
      accepted: false,
    },
  ])(
    "accepts only the selected repository issue through context injection: $message",
    async ({ message, accepted }) => {
      mocks.getWorkspace.mockReturnValue({
        agentId: "main",
        url: "https://microsoft.ghe.com/example/project.git",
      });
      mocks.prepareIdentity.mockResolvedValue({
        token: undefined,
        assertSelected: () => {},
        start: async (operation: () => unknown) => await operation(),
      });
      mocks.readJson.mockResolvedValue({
        title: "Issue",
        body: "Description",
        user: { login: "author" },
        comments: 0,
      });
      const templateContext: TemplateContext = {};
      await attachSessionGitHubIssueContext({
        agentId: "main",
        client: null,
        sessionKey: "agent:main:issue-context",
        sessionId: "issue-context-session",
        assertActive: () => {},
        config: {},
        context: { getRuntimeConfig: () => ({}) },
        message,
        repositoryWorkspaceId: "workspace-1",
        templateContext,
      });
      if (accepted) {
        expect(mocks.fetchApi).toHaveBeenCalled();
        expect(templateContext.ChannelStructuredContext?.[0]?.payload).toMatchObject({
          url: "https://microsoft.ghe.com/example/project/issues/101",
        });
      } else {
        expect(mocks.prepareIdentity).not.toHaveBeenCalled();
        expect(mocks.fetchApi).not.toHaveBeenCalled();
        expect(templateContext).toEqual({});
      }
    },
  );

  it("injects bounded untrusted issue data without forwarding the credential", async () => {
    const assertSelected = vi.fn();
    mocks.getWorkspace.mockReturnValue({
      agentId: "main",
      url: "https://microsoft.ghe.com/example/project.git",
    });
    mocks.prepareIdentity.mockResolvedValue({
      token: "must-not-enter-context",
      assertSelected,
      start: async (operation: () => unknown) => await operation(),
    });
    mocks.readJson
      .mockResolvedValueOnce({
        title: "Synthetic issue",
        body: "b".repeat(30_000),
        state: "open",
        user: { login: "owner" },
        comments: 9,
        created_at: "2026-09-24T00:00:00Z",
        updated_at: "2026-09-24T01:00:00Z",
      })
      .mockResolvedValueOnce(
        Array.from({ length: 9 }, (_, index) => ({
          user: { login: `author-${index}` },
          body: "c".repeat(3_000),
          created_at: "2026-09-24T02:00:00Z",
        })),
      );
    const templateContext: TemplateContext = {};
    await attachSessionGitHubIssueContext({
      agentId: "main",
      assertActive: vi.fn(),
      config: {},
      context: { getRuntimeConfig: () => ({}) },
      client: null,
      sessionKey: "agent:main:issue-context",
      sessionId: "issue-context-session",
      message: "Read https://microsoft.ghe.com/example/project/issues/101",
      repositoryWorkspaceId: "workspace-1",
      templateContext,
    });

    expect(assertSelected).toHaveBeenCalled();
    expect(mocks.fetchApi).toHaveBeenCalledWith(
      "https://api.microsoft.ghe.com/repos/example/project/issues/101",
      expect.any(Function),
      "must-not-enter-context",
      expect.any(Function),
      expect.objectContaining({ token: "must-not-enter-context" }),
    );
    const serialized = JSON.stringify(templateContext);
    expect(serialized).toContain("GitHub issue context (untrusted external content)");
    expect(serialized).toContain("Synthetic issue");
    expect(serialized).not.toContain("must-not-enter-context");
    const payload = templateContext.ChannelStructuredContext?.[0]?.payload as {
      body: string;
      comments: Array<{ body: string }>;
      comments_truncated: boolean;
    };
    expect(payload.body).toHaveLength(24 * 1024);
    expect(payload.comments).toHaveLength(8);
    expect(payload.comments[0]?.body).toHaveLength(2 * 1024);
    expect(payload.comments_truncated).toBe(true);
  });
});
