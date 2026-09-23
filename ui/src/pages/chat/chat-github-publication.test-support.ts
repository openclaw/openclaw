import { expect, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  GitHubPublicationController,
  type GitHubPublicationOptions,
  type GitHubPublicationPresentationBinding,
} from "../../lib/sessions/github-publication-controller.ts";

type GitHubPublicationScope = Parameters<GitHubPublicationPresentationBinding["sync"]>[0] & {
  client: Pick<GatewayBrowserClient, "request">;
  key: string;
  target: ConstructorParameters<typeof GitHubPublicationController>[0]["target"];
};

export const shared = { source: "system-configured" as const, accountId: 1, login: "system-bot" };
export const account = { accountId: 2, login: "alice-tools" };
export const generation = "bdca439a-e787-4f9f-b5f3-a878c662cc76";
export const requestId = "bdca439a-e787-4f9f-b5f3-a878c662cc77";
export const options: GitHubPublicationOptions = {
  shared,
  personal: {
    state: "connected",
    generation,
    account,
    accessExpiresAtMs: null,
    refreshState: "available",
    pending: null,
  },
  pendingPersonal: null,
  latestShared: null,
};
export const confirmation = {
  account,
  generation,
  requestDigest: "a".repeat(64),
  pushRepository: "alice/demo",
  repository: "team/demo",
  branch: "feature/one",
  baseBranch: "main",
  sourceHeadCommit: "1".repeat(40),
  sourceIndexTree: "2".repeat(40),
  workspaceTree: "3".repeat(40),
};
export const interrupted = {
  result: {
    requestId,
    publisher: { source: "personal" as const, ...account },
    status: "needs_confirmation" as const,
    message: "Review the original publication.",
  },
  confirmation,
};

export function setup(initialOptions = options) {
  const request = vi.fn().mockImplementation(async (method: string) => {
    if (method === "sessions.github.options") {
      return initialOptions;
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const scope: GitHubPublicationScope = {
    client: { request },
    key: "gateway:alice:session:1",
    target: { sessionKey: "agent:main:one", agentId: "main" },
    canWrite: true,
    personalReady: true,
    isPresented: () => true,
    isCurrent: () => true,
  };
  const changed = vi.fn();
  let current = scope;
  const create = (owner: GitHubPublicationScope) =>
    new GitHubPublicationController({
      client: owner.client,
      target: owner.target,
      isCurrent: () => current.key === owner.key && current.isCurrent(),
      reserve: () => {},
      release: () => {},
      unbound: () => {},
    });
  let operation = create(scope);
  let binding = operation.bind(changed);
  binding.sync(scope);
  const controller = {
    view: () => binding.view(),
    reset: () => operation.reset(),
    sync(next: GitHubPublicationScope) {
      if (next.key !== current.key) {
        binding.detach();
        operation.reset();
        current = next;
        operation = create(next);
        binding = operation.bind(changed);
      } else {
        current = next;
      }
      binding.sync(next);
    },
  };
  return { controller, request, scope, changed };
}
export async function settled(controller: ReturnType<typeof setup>["controller"]) {
  await vi.waitFor(() => expect(controller.view()?.activity).toBeNull());
  return controller.view()!;
}
