// oxfmt-ignore
import {
  commandResult,
  githubPublicationTestMocks,
  SESSION_ID,
  SESSION_KEY,
} from "./github-publication.test-support.js";
import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import type { SessionGitHubPublicationPublished } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { SandboxContext } from "../agents/sandbox/types.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createGitHubPublishTool } from "../agents/tools/github-publish-tool.js";
import type { InProcessGatewayCaller } from "../agents/tools/in-process-gateway.js";
import {
  createGitHubPublicationRequesterFixture,
  createRequesterPublicationFixture,
} from "./github-publication-requester.test-support.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
export const publicationCheckpoint = checkpoint;
vi.mock("./worker-environments/session-repository-checkpoints.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("./worker-environments/session-repository-checkpoints.js")
    >();
  return {
    ...actual,
    withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
  };
});

export async function createPublicationActionFixture(backend: "local" | "repository" = "local") {
  const f = await createRequesterPublicationFixture(checkpoint, backend, {
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
  });
  const published = await f.coordinator.requestForSessionV2(
    f.request(randomUUID(), f.guest, "Publish session work"),
  );
  expect(published.status).toBe("published");
  if (published.status !== "published") {
    throw new Error("Publication fixture did not publish");
  }
  const publication: SessionGitHubPublicationPublished = published;
  const writerSource =
    backend === "repository"
      ? await createGitHubPublicationRequesterFixture({
          profileId: f.maintainerProfile,
          scopes: ["operator.write"],
          sessionKey: SESSION_KEY,
          agentId: "main",
        })
      : f.maintainerSource;
  const creation = mocks.runCommand.mock.calls.findLast(
    ([argv]) => argv.includes("POST") && argv.some((arg: string) => arg.endsWith("/pulls")),
  )!;
  const state = {
    body: JSON.parse(creation[1]!.input as string).body as string,
    node_id: "PR_fixture",
    title: JSON.parse(creation[1]!.input as string).title as string,
    html_url: publication.url,
    state: "open",
    draft: true,
    merged: false,
    head: { ref: publication.branch, sha: publication.headCommit },
    base: { repo: { full_name: publication.repository } },
    mergeable: true,
    mergeable_state: "clean",
    merge_commit_sha: "d".repeat(40),
  };
  const writes: { action: string; input: Record<string, unknown> }[] = [];
  let beforeRead: (() => Promise<void>) | undefined;
  let rejectMerge: ReturnType<typeof commandResult> | Error | undefined;
  let rejectClose = false;
  let rejectEdit = false;
  let loseResponse = false;
  let reviewResponse: ReturnType<typeof commandResult> | undefined;
  const previous = mocks.runCommand.getMockImplementation()!;
  mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
    if (argv[0] !== "gh" || !argv.includes("--method")) {
      return await previous(argv, options);
    }
    if (argv.includes("GET") && argv.some((arg) => /\/pulls\/\d+$/u.test(arg))) {
      await beforeRead?.();
      return commandResult(JSON.stringify(state));
    }
    let response = commandResult("{}");
    if (argv.includes("POST") && argv.some((arg) => /\/issues\/\d+\/comments$/u.test(arg))) {
      writes.push({ action: "request_review", input: JSON.parse(options!.input!) });
      response =
        reviewResponse ??
        commandResult(
          JSON.stringify({
            id: 123,
            html_url: `${publication.url}#issuecomment-123`,
            body: "@clawsweeper re-review",
            user: { id: 42 },
          }),
        );
    } else if (argv.includes("graphql")) {
      writes.push({ action: "ready", input: JSON.parse(options!.input!) });
      state.draft = false;
    } else if (argv.some((arg) => arg.endsWith("/merge"))) {
      writes.push({ action: "merge", input: JSON.parse(options!.input!) });
      if (rejectMerge) {
        if (rejectMerge instanceof Error) {
          throw rejectMerge;
        }
        return rejectMerge;
      }
      state.merged = true;
      state.state = "closed";
      state.merge_commit_sha = "e".repeat(40);
    } else if (argv.includes("PATCH") && argv.some((arg) => /\/pulls\/\d+$/u.test(arg))) {
      const input: Record<string, unknown> = JSON.parse(options!.input!);
      if (input.state === undefined) {
        writes.push({ action: "edit", input });
        if (rejectEdit) {
          return commandResult('{"message":"Resource not accessible"}', 1);
        }
        if (typeof input.title === "string") {
          state.title = input.title;
        }
        if (typeof input.body === "string") {
          state.body = input.body;
        }
      } else {
        writes.push({ action: "close", input });
        if (rejectClose) {
          return commandResult('{"message":"Resource not accessible"}', 1);
        }
        state.state = "closed";
      }
    } else {
      return await previous(argv, options);
    }
    if (loseResponse) {
      throw new Error("Connection closed after GitHub accepted the write");
    }
    return response;
  });
  const invoke = async (
    actor: "guest" | "admin" | "writer",
    args: Record<string, unknown>,
    source = SESSION_KEY,
    invocation: {
      raw?: boolean;
      client?: typeof f.guestSource.client;
      sandbox?: SandboxContext;
    } = {},
  ) => {
    const principal =
      actor === "guest" ? f.guestSource : actor === "writer" ? writerSource : f.maintainerSource;
    const callGateway: InProcessGatewayCaller = async <T>(
      method: string,
      params: Record<string, unknown>,
    ) => {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: randomUUID(), method, params },
        client: invocation.client ?? principal.client,
        context: {
          ...principal.context,
          githubPublicationService: f.coordinator,
        } as GatewayRequestContext,
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledOnce();
      const [ok, result, error] = respond.mock.calls[0]!;
      if (!ok) {
        throw new Error(error.message);
      }
      return result as T;
    };
    return await withGatewayToolCallerIdentity({ agentId: "main", sessionKey: source }, async () =>
      invocation.raw
        ? {
            content: [],
            details: await callGateway("sessions.github.action", { sessionKey: source, ...args }),
          }
        : createGitHubPublishTool({
            callGateway,
            actionsAvailable: actor !== "guest",
            sandbox: invocation.sandbox,
          }).execute("publication-action", args),
    );
  };
  const expected = { requestId: publication.requestId, expectedHeadCommit: publication.headCommit };
  return {
    ...f,
    publication,
    state,
    writes,
    invoke,
    expected,
    onRead(callback: () => Promise<void>) {
      beforeRead = callback;
    },
    rejectMerge(
      result: ReturnType<typeof commandResult> | Error = commandResult(
        '{"message":"Required checks have not passed"}',
        1,
      ),
    ) {
      rejectMerge = result;
    },
    rejectEdit() {
      rejectEdit = true;
    },
    rejectClose() {
      rejectClose = true;
    },
    reviewResponse(result: ReturnType<typeof commandResult>) {
      reviewResponse = result;
    },
    loseResponse() {
      loseResponse = true;
    },
  };
}
