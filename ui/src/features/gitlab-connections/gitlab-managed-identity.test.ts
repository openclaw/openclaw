import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { gitLabServerOrigin, GitLabConnectionsState } from "./gitlab-connections-state.ts";
import { GitLabManagedIdentityState } from "./gitlab-managed-identity.ts";

const status = {
  configured: true,
  issuer: "https://gitlab.example.test",
  selectedScope: "agent",
  selected: null,
  effective: null,
  effectiveSource: "unavailable",
};
function snapshot(request: ReturnType<typeof vi.fn>, admin = true) {
  return {
    phase: "connected",
    client: { request } as unknown as GatewayBrowserClient,
    hello: gatewayHelloForMethods([], admin ? ["operator.admin"] : ["operator.read"]),
    selfUser: { id: "administrator-a" },
  } as ApplicationGatewaySnapshot;
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

it("lets members verify a target but never manage its credentials", async () => {
  const request = vi.fn(async () => status);
  const owner = new GitLabManagedIdentityState();
  owner.sync(snapshot(request, false), { scope: "agent", agentId: "main" });
  await settle();
  expect(request).toHaveBeenCalledWith("tools.gitlab.status", {
    agentId: "main",
    selectedScope: "agent",
  });
  await owner.start();
  await owner.inherit();
  await owner.cancel();
  expect(request).toHaveBeenCalledTimes(1);
  expect(owner.view.canAdmin).toBe(false);
  owner.dispose();
});

it("drops a late authorization link after the administrator changes target and profile", async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const request = vi.fn((method: string) =>
    method === "tools.gitlab.authorize.start" ? pending : Promise.resolve(status),
  );
  const owner = new GitLabManagedIdentityState();
  const connected = snapshot(request);
  owner.sync(connected, { scope: "agent", agentId: "main" });
  await settle();
  const started = owner.start();
  expect(request).toHaveBeenLastCalledWith("tools.gitlab.authorize.start", {
    scope: "agent",
    agentId: "main",
  });
  owner.sync({ ...connected, selfUser: { id: "administrator-b" } } as ApplicationGatewaySnapshot, {
    scope: "system",
    agentId: "other",
  });
  resolve({
    requestId: "gitlab-setup-" + "a".repeat(32),
    authorizationUrl: "https://gitlab.example.test/oauth/authorize?client_id=example",
    expiresAtMs: Date.now() + 60000,
  });
  await started;
  await settle();
  expect(owner.view.pending).toBeNull();
  expect(owner.view.busy).toBe(false);
  expect(request).toHaveBeenLastCalledWith("tools.gitlab.status", {
    agentId: "other",
    selectedScope: "system",
  });
  owner.dispose();
});

it("rejects authorization destinations outside the configured issuer", async () => {
  const request = vi.fn(async (method: string) =>
    method === "tools.gitlab.authorize.start"
      ? {
          requestId: "gitlab-setup-" + "a".repeat(32),
          authorizationUrl: "https://other.example.test/oauth/authorize",
          expiresAtMs: Date.now() + 60000,
        }
      : status,
  );
  const owner = new GitLabManagedIdentityState();
  owner.sync(snapshot(request), { scope: "system", agentId: "main" });
  await settle();
  await owner.start();
  expect(owner.view.pending).toBeNull();
  expect(owner.view.error).toContain("Could not start");
  owner.dispose();
});

it("keeps managed authorization accepted when follow-up status refresh fails", async () => {
  let completed = false;
  const request = vi.fn(async (method: string) => {
    if (method === "tools.gitlab.authorize.complete") {
      completed = true;
      return { connected: true };
    }
    if (completed) {
      throw new Error("Synthetic status outage");
    }
    return { configured: true, connected: false, issuer: status.issuer };
  });
  const owner = new GitLabConnectionsState();
  owner.sync(snapshot(request));
  await settle();
  await owner.complete(
    `https://gateway.example.test/oauth/gitlab/callback?code=synthetic&state=gitlab-managed.gitlab-setup-${"a".repeat(32)}.${"b".repeat(43)}`,
  );
  expect(request).toHaveBeenCalledWith("tools.gitlab.authorize.complete", expect.any(Object));
  expect(request.mock.calls.some(([method]) => method === "users.gitlab.authorize.complete")).toBe(
    false,
  );
  expect(owner.view.error).toContain("authorization was accepted");
  expect(owner.view.error).not.toContain("Start again");
  expect(owner.view.busy).toBe(false);
  owner.dispose();
});

it("treats a lost managed completion reply as an unknown result to verify", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === "tools.gitlab.authorize.complete") {
      throw new Error("Synthetic lost response");
    }
    return { configured: true, connected: false, issuer: status.issuer };
  });
  const owner = new GitLabConnectionsState();
  owner.sync(snapshot(request));
  await settle();
  await owner.complete(
    `https://gateway.example.test/oauth/gitlab/callback?code=synthetic&state=gitlab-managed.gitlab-setup-${"a".repeat(32)}.${"b".repeat(43)}`,
  );
  expect(owner.view.error).toContain("Verify the selected connection before retrying");
  expect(owner.view.error).not.toContain("Start again");
  owner.dispose();
});

it("accepts only HTTPS server origins without credentials or repository paths", () => {
  expect(gitLabServerOrigin(" https://GITLAB.example.test:443/ ")).toBe(status.issuer);
  for (const raw of [
    "",
    "http://gitlab.example.test",
    "https://user:pass@gitlab.example.test",
    "https://gitlab.example.test/group/repo",
    "https://gitlab.example.test?code=example",
    "https://gitlab.example.test/#callback",
  ]) {
    expect(gitLabServerOrigin(raw)).toBeNull();
  }
});

it.each(["personal", "managed"])(
  "rejects a different selected server before starting %s OAuth",
  async (kind) => {
    const request = vi.fn(async () => status);
    const owner =
      kind === "personal" ? new GitLabConnectionsState() : new GitLabManagedIdentityState();
    if (owner instanceof GitLabManagedIdentityState) {
      owner.sync(snapshot(request), { scope: "system", agentId: "main" });
    } else {
      owner.sync(snapshot(request));
    }
    await settle();
    request.mockClear();
    await owner.start("https://other.example.test");
    expect(request).not.toHaveBeenCalled();
    expect(owner.view.pending).toBeNull();
    expect(owner.view.error).toContain("administrator OAuth setup");
    owner.dispose();
  },
);

it.each(["personal", "managed"])(
  "starts %s OAuth for the selected normalized server",
  async (kind) => {
    const pending = {
      requestId: "gitlab-setup-" + "a".repeat(32),
      authorizationUrl: `${status.issuer}/oauth/authorize?client_id=example`,
      expiresAtMs: Date.now() + 60000,
    };
    const request = vi.fn(async (method: string) =>
      method.endsWith("authorize.start") ? pending : status,
    );
    const owner =
      kind === "personal" ? new GitLabConnectionsState() : new GitLabManagedIdentityState();
    if (owner instanceof GitLabManagedIdentityState) {
      owner.sync(snapshot(request), { scope: "system", agentId: "main" });
    } else {
      owner.sync(snapshot(request));
    }
    await settle();
    await owner.start(" https://GITLAB.example.test:443/ ");
    expect(owner.view.pending?.authorizationUrl).toBe(pending.authorizationUrl);
    expect(owner.view.error).toBeNull();
    owner.dispose();
  },
);
