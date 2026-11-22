// oxfmt-ignore
import { commandResult, githubPublicationTestMocks, installGitHubPublicationTestHarness, SESSION_ID, SESSION_KEY } from "./github-publication.test-support.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createGitHubPublishTool } from "../agents/tools/github-publish-tool.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  ensureProjectRegistrySchema,
  insertProjectRegistryInDatabase,
} from "../projects/project-registry.kernel.js";
import {
  createRequesterPolicyFixture,
  publicationGuestEmail,
} from "./github-publication-requester.test-support.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";

const input = {
  action: "create_issue",
  title: "Broken link",
  body: "The handbook link is missing.",
};
const url = "https://github.com/Example/Handbook/issues/7";
const mocks = githubPublicationTestMocks();

async function fixture(bindProject = true) {
  const f = await createRequesterPolicyFixture({ sessionId: SESSION_ID, sessionKey: SESSION_KEY });
  ensureProjectRegistrySchema({ database: f.database });
  const project = insertProjectRegistryInDatabase(f.database.db, {
    source: "registered",
    displayName: "Handbook",
    repoRoot: "/registered/handbook",
    originUrl: "https://github.com/Example/Handbook.git",
  });
  await upsertSessionEntryCore(f.guestSource.session, {
    projectId: bindProject ? project.id : undefined,
    worktree: undefined,
  });
  expect(loadSessionEntryReadOnly(f.guestSource.session)?.worktree).toBeUndefined();
  const visibility = vi.fn<typeof fetch>(async () => Response.json({ visibility: "public" }));
  vi.stubGlobal("fetch", visibility);
  mocks.runCommand
    .mockReset()
    .mockResolvedValue(commandResult(JSON.stringify({ number: 7, url, authorId: 42 })));
  const registry = createRequestGatewayMethodRegistry();
  const context = createGatewayRequestContext(
    makeContextParams({ getAttachedGatewayMethodRegistry: () => registry }),
  );
  const invoke = async (args: Record<string, unknown>, client = f.guestSource.client) => {
    const operator = await captureGatewayOperatorRunAuthority({
      client,
      context: f.guestSource.context,
    });
    try {
      return await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: SESSION_KEY,
          operatorAuthority: operator?.authority,
          gatewayContextResolver: () => context,
        },
        () => createGitHubPublishTool({ publicationAvailable: false }).execute("file-issue", args),
      );
    } finally {
      operator?.release();
    }
  };
  return { f, invoke, visibility };
}

describe("project issue creation through the guest tool and registered Gateway method", () => {
  installGitHubPublicationTestHarness({ creatorEmail: publicationGuestEmail, sandbox: "required" });
  afterEach(() => vi.unstubAllGlobals());
  it("files as the selected publisher without a worktree, then refuses if the project goes private", async () => {
    const { invoke, visibility } = await fixture();
    const result = await invoke(input);
    expect(result.details).toEqual({ status: "created", url });
    expect(mocks.runCommand).toHaveBeenCalledTimes(1);
    expect(mocks.runCommand).toHaveBeenCalledWith(
      expect.arrayContaining([
        "gh",
        "api",
        "--hostname",
        "github.com",
        "POST",
        "repos/example/handbook/issues",
        "--input",
        "-",
      ]),
      expect.objectContaining({
        env: expect.objectContaining({ GH_CONFIG_DIR: "/private/github-profile" }),
        input: JSON.stringify({ title: input.title, body: input.body }),
      }),
    );
    visibility.mockImplementation(async () => Response.json({ visibility: "private" }));
    await expect(invoke(input)).rejects.toThrow(/no registered GitHub repository available/);
    expect(mocks.runCommand).toHaveBeenCalledTimes(1);
  });
  it("rejects read-only callers and foreign targets before any write", async () => {
    const { f, invoke } = await fixture();
    const guest = f.guestSource.client;
    await expect(
      invoke(input, {
        ...guest,
        connect: { ...guest.connect, scopes: ["operator.sessions.read"] },
      }),
    ).rejects.toThrow();
    await expect(invoke({ ...input, repository: "other/repo" })).rejects.toThrow();
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });
  it("does not guess a repository in a conversation without a project", async () => {
    const { f, invoke } = await fixture(false);
    expect(loadSessionEntryReadOnly(f.guestSource.session)?.projectId).toBeUndefined();
    await expect(invoke(input)).rejects.toThrow(/registered GitHub project/);
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });
  it("does not retry or claim success after a lost GitHub response", async () => {
    const { invoke } = await fixture();
    mocks.runCommand.mockRejectedValue(new Error("connection closed"));
    await expect(invoke(input)).rejects.toThrow(/unconfirmed.*check.*issues before submitting/i);
    expect(mocks.runCommand).toHaveBeenCalledTimes(1);
  });
});
