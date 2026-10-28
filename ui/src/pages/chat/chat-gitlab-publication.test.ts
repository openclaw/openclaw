/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { GitHubPublicationOwner } from "../../lib/sessions/github-publication-owner.ts";
import { account, generation, requestId } from "./chat-github-publication.test-support.ts";
import {
  clearChatPullRequests,
  paintChatPullRequests,
  publication,
} from "./components/chat-pull-requests.test-support.ts";
import { showWorkRow } from "./components/chat-pull-requests.ts";

describe("native GitLab publication", () => {
  it("discovers the managed target and publishes with an explicit personal account", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.gitlab.options") {
        return {
          issuer: "https://gitlab.example.test",
          target: { repository: "group/project", branch: "feature/one", baseBranch: "master" },
          shared: null,
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
      }
      if (method === "sessions.gitlab.publish") {
        return { requestId, status: "requested", publisher: { source: "personal", ...account } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const owner = new GitHubPublicationOwner(
      {
        client: { request: request as unknown as GatewayBrowserClient["request"] },
        target: { sessionKey: "agent:main:one", agentId: "main" },
        isCurrent: () => true,
        reserve: () => {},
        release: () => {},
        unbound: () => {},
      },
      "gitlab",
    );
    const binding = owner.bind();
    binding.sync({
      canPublishShared: false,
      canPublishPersonal: true,
      personalReady: true,
      isPresented: () => true,
      isCurrent: () => true,
    });
    await vi.waitFor(() => expect(binding.view()?.activity).toBeNull());
    const ready = binding.view()!;
    expect(ready.provider).toBe("gitlab");
    expect(ready.target).toEqual({
      repository: "group/project",
      branch: "feature/one",
      baseBranch: "master",
    });
    expect(ready.selection).toBeNull();
    expect(
      showWorkRow({ pullRequests: [], status: "ready", onDismiss: () => {}, publication: ready }),
    ).toBe(true);
    await ready.onPublish?.();
    expect(request).toHaveBeenCalledWith("sessions.gitlab.publish", {
      sessionKey: "agent:main:one",
      agentId: "main",
      selection: { source: "personal", account, generation },
      idempotencyKey: expect.any(String),
    });
    expect(binding.view()?.result?.status).toBe("requested");
  });

  it.each(["not-accepted", "accepted", "issuer-changed"])(
    "preserves the request key after credential failure: %s",
    async (scenario) => {
      const accepted = scenario === "accepted";
      let reads = 0;
      let publishes = 0;
      const replacementGeneration = "reconnected-generation";
      const request = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
        if (method === "sessions.gitlab.options") {
          reads++;
          return {
            issuer:
              scenario === "issuer-changed" && reads > 1
                ? "https://other-gitlab.example.test"
                : "https://gitlab.example.test",
            shared: null,
            personal: {
              state: "connected",
              account,
              generation: reads === 1 ? generation : replacementGeneration,
              accessExpiresAtMs: null,
              refreshState: "available",
              pending: null,
            },
            pendingPersonal:
              accepted && reads > 1
                ? {
                    result: {
                      requestId,
                      status: "needs_confirmation",
                      publisher: { source: "personal", ...account },
                    },
                    confirmation: null,
                  }
                : null,
            latestShared: null,
          };
        }
        if (method === "sessions.gitlab.publish") {
          publishes++;
          if (publishes === 1) {
            throw Object.assign(new Error("Reconnect your account"), { code: "FORBIDDEN" });
          }
          return { requestId, status: "requested", publisher: { source: "personal", ...account } };
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const owner = new GitHubPublicationOwner(
        {
          client: { request: request as unknown as GatewayBrowserClient["request"] },
          target: { sessionKey: "agent:main:one" },
          isCurrent: () => true,
          reserve: () => {},
          release: () => {},
          unbound: () => {},
        },
        "gitlab",
      );
      const binding = owner.bind();
      binding.sync({
        canPublishShared: false,
        canPublishPersonal: true,
        personalReady: true,
        isPresented: () => true,
        isCurrent: () => true,
      });
      await vi.waitFor(() => expect(binding.view()?.activity).toBeNull());
      await binding.view()?.onPublish?.();
      const firstParams = request.mock.calls.find(
        ([method]) => method === "sessions.gitlab.publish",
      )?.[1];
      expect(binding.view()?.locked).toBe(true);
      await binding.view()?.onRefresh();
      expect(request).toHaveBeenLastCalledWith("sessions.gitlab.options", {
        sessionKey: "agent:main:one",
        idempotencyKey: expect.any(String),
      });
      if (scenario === "issuer-changed") {
        expect(binding.view()?.selection).toEqual({ source: "personal", account, generation });
        expect(binding.view()?.locked).toBe(true);
        expect(publishes).toBe(1);
      } else if (accepted) {
        expect(binding.view()?.result?.requestId).toBe(requestId);
        expect(binding.view()?.result?.status).toBe("needs_confirmation");
        expect(publishes).toBe(1);
      } else {
        await binding.view()?.onPublish?.();
        expect(request).toHaveBeenLastCalledWith("sessions.gitlab.publish", {
          ...firstParams,
          selection: { source: "personal", account, generation: replacementGeneration },
        });
        expect(binding.view()?.result?.status).toBe("requested");
      }
    },
  );

  it("offers a GitLab work row without a GitHub pull-request branch", () => {
    expect(
      showWorkRow({
        pullRequests: [],
        status: "ready",
        onDismiss: () => {},
        publication: publication({
          provider: "gitlab",
          target: { repository: "group/project", branch: "feature/one" },
          canPublishShared: false,
        }),
      }),
    ).toBe(true);
  });

  it("presents a merge-request action on the managed target", () => {
    const container = document.createElement("div");
    document.body.append(container);
    paintChatPullRequests(
      {
        publication: publication({
          provider: "gitlab",
          target: { repository: "group/project", branch: "feature/one", baseBranch: "master" },
          canPublishShared: false,
          selection: { source: "personal", account, generation },
        }),
      },
      container,
    );
    expect(container.textContent).toContain("group/project");
    expect(container.textContent).toContain("feature/one");
    expect(container.textContent).toContain("Publish merge request");
    expect(container.textContent).not.toContain("My GitHub");
    clearChatPullRequests(container);
    container.remove();
  });

  it("retires only the matching pre-admission GitLab selection rejection", async () => {
    let firstKey = "";
    const request = vi.fn(async (method: string, params?: { idempotencyKey?: string }) => {
      if (method === "sessions.gitlab.options") {
        return {
          shared: null,
          personal: {
            state: "connected",
            account,
            generation,
            accessExpiresAtMs: null,
            refreshState: "available",
            pending: null,
          },
          pendingPersonal: null,
          latestShared: null,
        };
      }
      if (method === "sessions.gitlab.publish") {
        firstKey = params?.idempotencyKey ?? "";
        throw Object.assign(new Error("Selection rejected"), {
          code: "UNAVAILABLE",
          details: { code: "GITLAB_PUBLICATION_SELECTION_REJECTED", idempotencyKey: firstKey },
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const owner = new GitHubPublicationOwner(
      {
        client: { request: request as unknown as GatewayBrowserClient["request"] },
        target: { sessionKey: "agent:main:one" },
        isCurrent: () => true,
        reserve: () => {},
        release: () => {},
        unbound: () => {},
      },
      "gitlab",
    );
    const binding = owner.bind();
    binding.sync({
      canPublishShared: false,
      canPublishPersonal: true,
      personalReady: true,
      isPresented: () => true,
      isCurrent: () => true,
    });
    await vi.waitFor(() => expect(binding.view()?.activity).toBeNull());
    await binding.view()?.onPublish?.();
    expect(firstKey).not.toBe("");
    expect(binding.view()?.locked).toBe(false);
    expect(binding.view()?.selection).toBeNull();
  });
});

it("publishes through an explicitly chosen managed GitLab actor and never falls back after a user credential failure", async () => {
  const shared = {
    source: "system-configured" as const,
    accountId: 77,
    login: "configured-publisher",
  };
  const options = {
    issuer: "https://gitlab.example.test",
    target: { repository: "group/project", branch: "feature/one", baseBranch: "master" },
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
  let failPersonal = false;
  const request = vi.fn(async (method: string, params?: { selection?: { source: string } }) => {
    if (method === "sessions.gitlab.options") {
      return options;
    }
    if (method === "sessions.gitlab.publish") {
      if (params?.selection?.source === "personal" && failPersonal) {
        throw new Error("Synthetic user credential unavailable");
      }
      return {
        requestId,
        status: "published",
        url: "https://gitlab.example.test/group/project/-/merge_requests/42",
        repository: "group/project",
        branch: "feature/one",
        headCommit: "a".repeat(40),
        publisher: shared,
      };
    }
    throw new Error("Unexpected synthetic method");
  });
  const create = () => {
    const owner = new GitHubPublicationOwner(
      {
        client: { request: request as unknown as GatewayBrowserClient["request"] },
        target: { sessionKey: "agent:main:one", agentId: "main" },
        isCurrent: () => true,
        reserve: () => {},
        release: () => {},
        unbound: () => {},
      },
      "gitlab",
    );
    const binding = owner.bind();
    binding.sync({
      canPublishShared: true,
      canPublishPersonal: true,
      personalReady: true,
      isPresented: () => true,
      isCurrent: () => true,
    });
    return { owner, binding };
  };
  const managed = create();
  await vi.waitFor(() => expect(managed.binding.view()?.activity).toBeNull());
  managed.binding.view()!.onSelect?.("shared");
  await managed.binding.view()!.onPublish?.();
  expect(request).toHaveBeenCalledWith(
    "sessions.gitlab.publish",
    expect.objectContaining({ selection: { source: "shared", expected: shared } }),
  );
  expect(managed.binding.view()?.result?.publisher).toEqual(shared);
  managed.owner.reset();
  request.mockClear();
  failPersonal = true;
  const personal = create();
  await vi.waitFor(() => expect(personal.binding.view()?.activity).toBeNull());
  personal.binding.view()!.onSelect?.("personal");
  await personal.binding.view()!.onPublish?.();
  const writes = request.mock.calls.filter(([method]) => method === "sessions.gitlab.publish");
  expect(writes).toHaveLength(1);
  expect(writes[0]![1]).toMatchObject({ selection: { source: "personal", account, generation } });
  expect(personal.binding.view()?.selection?.source).toBe("personal");
  personal.owner.reset();
});
