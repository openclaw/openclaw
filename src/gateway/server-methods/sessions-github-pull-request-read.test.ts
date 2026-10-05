import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../../config/io.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { sessionsGitHubHandlers } from "./sessions-github.js";

const mocks = vi.hoisted(() => ({
  assertCaller: vi.fn(),
  caller: vi.fn(),
  getWorkspace: vi.fn(),
  loadSession: vi.fn(),
  prepareIdentity: vi.fn(),
  readPullRequest: vi.fn(),
}));

vi.mock("../../agents/tools/gateway-caller-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/tools/gateway-caller-context.js")>()),
  captureGatewayToolCallerAssertion: () => mocks.assertCaller,
  getGatewayToolCallerIdentity: mocks.caller,
}));
vi.mock("../../state/session-repository-workspaces.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session-repository-workspaces.js")>()),
  getSessionRepositoryWorkspaceStore: () => ({
    prepare: async () => ({ current: mocks.getWorkspace }),
  }),
}));
vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  loadGatewaySessionEntryReadOnly: mocks.loadSession,
}));
vi.mock("../project-github-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project-github-identity.js")>()),
  prepareGatewayProjectGitHubIdentity: mocks.prepareIdentity,
}));
vi.mock("../github-pull-request-read.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github-pull-request-read.js")>()),
  readBoundGitHubPullRequest: mocks.readPullRequest,
}));

async function invoke(params: Record<string, unknown>) {
  const respond = vi.fn();
  await expectDefined(
    sessionsGitHubHandlers["sessions.github.pullRequest.read"],
    "pull request read handler",
  )({
    params,
    respond: respond as never,
    context: { getRuntimeConfig } as never,
    client: null,
    req: { type: "req", id: "pr-read", method: "sessions.github.pullRequest.read" },
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("sessions.github.pullRequest.read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfigSnapshot({
      gateway: { github: { host: "microsoft.ghe.com" }, projects: { nativeGitHubSearch: true } },
    });
    mocks.caller.mockReturnValue({
      agentId: "main",
      sessionKey: "agent:main:repository-session",
      operationalRunInstance: { runId: "run-1" },
    });
    mocks.loadSession.mockReturnValue({
      canonicalKey: "agent:main:repository-session",
      agentId: "main",
      entry: { sessionId: "session-1", repositoryWorkspaceId: "workspace-1" },
    });
    mocks.getWorkspace.mockReturnValue({
      workspaceId: "workspace-1",
      agentId: "main",
      sessionKey: "agent:main:repository-session",
      url: "https://microsoft.ghe.com/bic/lobster.git",
    });
    const identity = {
      token: "gateway-only-token",
      assertSelected: vi.fn(),
      start: async (operation: () => unknown) => await operation(),
    };
    mocks.prepareIdentity.mockResolvedValue(identity);
    mocks.readPullRequest.mockResolvedValue({
      repository: "bic/lobster",
      number: 15913,
      content_trust: "untrusted_external_content",
    });
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("binds the selected enterprise repository, session, run, and verified principal", async () => {
    const respond = await invoke({
      sessionKey: "agent:main:repository-session",
      pullRequest: 15913,
    });

    expect(mocks.prepareIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", context: expect.any(Object) }),
    );
    expect(mocks.readPullRequest).toHaveBeenCalledWith({
      target: { owner: "bic", repo: "lobster", number: 15913 },
      identity: expect.objectContaining({ token: "gateway-only-token" }),
    });
    expect(mocks.assertCaller).toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ repository: "bic/lobster", number: 15913 }),
    );
    expect(JSON.stringify(respond.mock.calls)).not.toContain("gateway-only-token");
  });

  it.each([
    ["principal", { agentId: "research" }],
    ["session", { sessionKey: "agent:main:another-session" }],
    ["repository argument", { repository: "other/repository" }],
    ["host argument", { host: "github.com" }],
    ["credential argument", { token: "model-supplied-token" }],
  ])("rejects a model-selected %s", async (_label, extra) => {
    const respond = await invoke({
      sessionKey: "agent:main:repository-session",
      pullRequest: 15913,
      ...extra,
    });

    expect(mocks.readPullRequest).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: expect.any(String) }),
    );
  });

  it("rejects a repository bound to another GitHub host", async () => {
    mocks.getWorkspace.mockReturnValue({
      workspaceId: "workspace-1",
      agentId: "main",
      sessionKey: "agent:main:repository-session",
      url: "https://github.com/bic/lobster.git",
    });
    const respond = await invoke({
      sessionKey: "agent:main:repository-session",
      pullRequest: 15913,
    });

    expect(mocks.prepareIdentity).not.toHaveBeenCalled();
    expect(mocks.readPullRequest).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });

  it.each(["expired", "revoked"])("fails closed for an %s selected credential", async () => {
    mocks.prepareIdentity.mockRejectedValueOnce(new Error("selected credential unavailable"));
    const respond = await invoke({
      sessionKey: "agent:main:repository-session",
      pullRequest: 15913,
    });

    expect(mocks.readPullRequest).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });
});
