/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { GitLabConnections } from "./gitlab-connections.tsx";
import { captureGitLabOAuthCallback, takeGitLabOAuthCallback } from "./gitlab-oauth-callback.ts";

const issuer = "https://gitlab.example.test";
const account = {
  accountId: 47,
  login: "alice",
};
const connected = {
  configured: true,
  issuer,
  connected: true,
  account,
  scopes: ["api", "write_repository"],
  reconnectRequired: false,
};
const disconnected = {
  configured: true,
  issuer,
  connected: false,
  account: null,
  scopes: [],
  reconnectRequired: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function connectionClient(request: (method: string, params: unknown) => Promise<unknown>) {
  return {
    request: (method: string, params: unknown) =>
      method.startsWith("tools.gitlab.")
        ? Promise.resolve({ configured: false })
        : request(method, params),
  } as unknown as GatewayBrowserClient;
}
function connectionContext(gateway: ApplicationContext["gateway"]): ApplicationContext {
  return {
    gateway,
    settingsAgentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
    agents: { subscribe: () => () => {} },
    runtimeConfig: { subscribe: () => () => {} },
  } as unknown as ApplicationContext;
}

function mount(request: (method: string, params: unknown) => Promise<unknown>) {
  const client = connectionClient(request);
  const initial = {
    client,
    phase: "connected",
    hello: gatewayHelloForMethods([], ["operator.read"]),
    selfUser: { id: "person-a" },
  } as ApplicationGatewaySnapshot;
  const { gateway, publish } = createApplicationGateway(initial);
  const context = connectionContext(gateway);
  const rendered = mountSolid(GitLabConnections, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  const button = (label: string) =>
    [...rendered.container.querySelectorAll("button")].find(
      (entry) => entry.textContent?.trim() === label,
    );
  return {
    ...rendered,
    button,
    emit(next: Partial<ApplicationGatewaySnapshot>) {
      publish({ ...gateway.snapshot, ...next });
      flush();
    },
    replaceProfile(id: string) {
      publish({ ...gateway.snapshot, selfUser: { id } });
      flush();
    },
  };
}

it("hides an unconfigured GitLab connection", async () => {
  const request = vi.fn(async () => ({ configured: false }));
  const ui = mount(request);
  await waitForSolid(() => expect(request).toHaveBeenCalledWith("users.gitlab.status", {}));
  expect(ui.container.querySelector("[data-gitlab-connections]")).toBeNull();
  ui.unmount();
});

it("opens the existing browser authorization when selected from Add provider", async () => {
  const request = vi.fn(async (method: string) =>
    method === "users.gitlab.status"
      ? disconnected
      : {
          requestId: "request-1",
          authorizationUrl: `${issuer}/oauth/authorize?state=synthetic`,
          expiresAtMs: Date.now() + 60_000,
        },
  );
  const client = connectionClient(request);
  const { gateway } = createApplicationGateway({
    client,
    phase: "connected",
    hello: gatewayHelloForMethods([], ["operator.read"]),
    selfUser: { id: "person-a" },
  } as ApplicationGatewaySnapshot);
  let connect!: () => void;
  const available = vi.fn();
  const ui = mountSolid(
    () => {
      return (
        <GitLabConnections
          onConnectReady={(command) => {
            connect = command ?? (() => {});
          }}
          onAvailable={available}
        />
      );
    },
    { wrapper: createSolidApplicationContextProvider(connectionContext(gateway)).wrapper },
  );
  await waitForSolid(() => expect(available).toHaveBeenCalledWith(true));
  connect();
  flush();
  await waitForSolid(() => expect(ui.container.textContent).toContain("Continue with GitLab"));
  expect(request).not.toHaveBeenCalledWith("users.gitlab.authorize.start", {});
  [...ui.container.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "Continue with GitLab")!
    .click();
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("users.gitlab.authorize.start", {}),
  );
  await waitForSolid(() =>
    expect(ui.container.querySelector("a[href*='/oauth/authorize']")).not.toBeNull(),
  );
  ui.unmount();
});

it("shows the verified personal publisher and disconnects without a fallback", async () => {
  const request = vi.fn(async (method: string) =>
    method === "users.gitlab.status" ? connected : { disconnected: true },
  );
  const ui = mount(request);
  await waitForSolid(() =>
    expect(ui.container.textContent).toContain(
      "Your GitLab publications, issues, and comments use @alice",
    ),
  );
  expect(ui.container.textContent).not.toContain("alice@example.test");
  expect(ui.container.textContent).toContain(issuer);
  ui.button("Manage connections")?.click();
  flush();
  ui.button("Disconnect")?.click();
  await waitForSolid(() =>
    expect(ui.container.textContent).toContain("No GitLab account connected"),
  );
  expect(request).toHaveBeenCalledWith("users.gitlab.disconnect", {});
  expect(ui.container.textContent).not.toContain("system account");
  ui.unmount();
});

it("uses the Gateway-generated sign-in URL without a pasted-code form", async () => {
  const authorizationUrl = `${issuer}/oauth/authorize?client_id=test&state=opaque`;
  const request = vi.fn(async (method: string) =>
    method === "users.gitlab.status"
      ? disconnected
      : {
          requestId: "a624ff9e-4018-4f6a-aab7-88c619d5d03b",
          authorizationUrl,
          expiresAtMs: Date.now() + 60_000,
        },
  );
  const ui = mount(request);
  await waitForSolid(() => expect(ui.button("Connect My GitLab")).toBeDefined());
  expect(ui.container.textContent).toContain("GitLab server");
  expect(ui.container.textContent).toContain(issuer);
  ui.button("Connect My GitLab")?.click();
  flush();
  ui.button("Continue with GitLab")?.click();
  await waitForSolid(() =>
    expect(ui.container.querySelector("a[href*='/oauth/authorize']")).not.toBeNull(),
  );
  expect(ui.container.querySelector<HTMLAnchorElement>("a[href*='/oauth/authorize']")!.href).toBe(
    authorizationUrl,
  );
  expect(ui.container.querySelector("input[aria-label='Final GitLab redirect URL']")).toBeNull();
  expect(ui.container.textContent).toContain("automatically");
  ui.unmount();
});

it("completes the returned callback in a fresh authenticated Profile mount", async () => {
  const requestId = "a624ff9e-4018-4f6a-aab7-88c619d5d03b";
  const callbackUrl = "https://app.example.test/oauth/gitlab/callback?code=synthetic&state=opaque";
  captureGitLabOAuthCallback(
    { pathname: "/oauth/gitlab/callback", search: "?code=synthetic&state=opaque", hash: "" },
    "",
    "https://app.example.test",
  );
  const request = vi.fn(async (method: string) =>
    method === "users.gitlab.status" ? { ...disconnected, pendingRequestId: requestId } : connected,
  );
  const ui = mount(request);
  await waitForSolid(() =>
    expect(ui.container.textContent).toContain(
      "Your GitLab publications, issues, and comments use @alice",
    ),
  );
  expect(request).toHaveBeenCalledWith("users.gitlab.authorize.complete", {
    requestId,
    callbackUrl,
  });
  expect(request).not.toHaveBeenCalledWith("users.gitlab.authorize.start", {});
  expect(takeGitLabOAuthCallback()).toBeNull();
  ui.unmount();
});

it("shows a recoverable error when the returned request is unavailable for the current person", async () => {
  captureGitLabOAuthCallback(
    { pathname: "/oauth/gitlab/callback", search: "?code=synthetic&state=foreign", hash: "" },
    "",
    "https://app.example.test",
  );
  const request = vi.fn(async (_method: string) => disconnected);
  const ui = mount(request);
  await waitForSolid(() => expect(ui.container.textContent).toContain("expired or changed"));
  expect(request.mock.calls.every(([method]) => method === "users.gitlab.status")).toBe(true);
  ui.unmount();
});

it("drops late status and authorization after the profile changes", async () => {
  const lateStatus = deferred<typeof connected>();
  const lateStart = deferred<{
    requestId: string;
    authorizationUrl: string;
    expiresAtMs: number;
  }>();
  let statusCount = 0;
  const request = vi.fn((method: string) => {
    if (method === "users.gitlab.status") {
      statusCount += 1;
      return statusCount === 1 ? Promise.resolve(disconnected) : lateStatus.promise;
    }
    return lateStart.promise;
  });
  const ui = mount(request);
  await waitForSolid(() => expect(ui.button("Connect My GitLab")).toBeDefined());
  ui.button("Connect My GitLab")?.click();
  flush();
  ui.button("Continue with GitLab")?.click();
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("users.gitlab.authorize.start", {}),
  );
  ui.replaceProfile("person-b");
  lateStart.resolve({
    requestId: "a624ff9e-4018-4f6a-aab7-88c619d5d03b",
    authorizationUrl: `${issuer}/oauth/authorize?state=old`,
    expiresAtMs: Date.now() + 60_000,
  });
  lateStatus.resolve(connected);
  await waitForSolid(() =>
    expect(ui.container.textContent).toContain(
      "Your GitLab publications, issues, and comments use @alice",
    ),
  );
  expect(ui.container.querySelector("a[href*='/oauth/authorize']")).toBeNull();
  ui.unmount();
});

it("consumes the callback and ignores late completion when the client changes", async () => {
  const complete = deferred<typeof connected>();
  const requestId = "a624ff9e-4018-4f6a-aab7-88c619d5d03b";
  captureGitLabOAuthCallback(
    { pathname: "/oauth/gitlab/callback", search: "?code=synthetic&state=opaque", hash: "" },
    "",
    "https://app.example.test",
  );
  const request = vi.fn((method: string) =>
    method === "users.gitlab.status"
      ? Promise.resolve({ ...disconnected, pendingRequestId: requestId })
      : complete.promise,
  );
  const ui = mount(request);
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("users.gitlab.authorize.complete", expect.anything()),
  );
  expect(takeGitLabOAuthCallback()).toBeNull();
  ui.emit({
    client: {
      request: vi.fn(async () => ({ configured: false })),
    } as unknown as GatewayBrowserClient,
  });
  complete.resolve(connected);
  await waitForSolid(() =>
    expect(ui.container.querySelector("[data-gitlab-connections]")).toBeNull(),
  );
  expect(ui.container.textContent).not.toContain("@alice");
  ui.unmount();
});

it("rejects an authorization link outside the configured GitLab issuer", async () => {
  const request = vi.fn(async (method: string) =>
    method === "users.gitlab.status"
      ? disconnected
      : {
          requestId: "a624ff9e-4018-4f6a-aab7-88c619d5d03b",
          authorizationUrl: "https://other.example.test/oauth/authorize?state=opaque",
          expiresAtMs: Date.now() + 60_000,
        },
  );
  const ui = mount(request);
  await waitForSolid(() => expect(ui.button("Connect My GitLab")).toBeDefined());
  ui.button("Connect My GitLab")?.click();
  flush();
  ui.button("Continue with GitLab")?.click();
  await waitForSolid(() =>
    expect(ui.container.textContent).toContain("Could not start GitLab sign-in"),
  );
  expect(ui.container.querySelector("a[href*='/oauth/authorize']")).toBeNull();
  ui.unmount();
});

it("manages setup without mutating credentials and verifies through the status owner", async () => {
  const request = vi.fn(async () => connected);
  const ui = mount(request);
  await waitForSolid(() => expect(ui.button("Manage connections")).toBeDefined());
  expect(ui.button("Continue with GitLab")).toBeUndefined();
  request.mockClear();
  ui.button("Manage connections")!.click();
  flush();
  expect(ui.button("Continue with GitLab")).toBeDefined();
  expect(request).not.toHaveBeenCalled();
  ui.button("Close")!.click();
  flush();
  expect(ui.button("Continue with GitLab")).toBeUndefined();
  ui.button("Verify")!.click();
  await waitForSolid(() => expect(request).toHaveBeenCalledWith("users.gitlab.status", {}));
  ui.unmount();
});

it("offers verification retry without demanding reconnection during a provider outage", async () => {
  const request = vi.fn(async (_method: string) => ({
    ...connected,
    connected: false,
    reconnectRequired: false,
    verificationUnavailable: true,
  }));
  const ui = mount(request);
  await waitForSolid(() => expect(ui.container.textContent).toContain("Verification unavailable"));
  expect(ui.container.textContent).toContain("Try Verify again");
  expect(ui.container.textContent).not.toContain("Reconnect required");
  expect(ui.container.textContent).not.toContain("No GitLab account connected");
  ui.button("Verify")!.click();
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
  expect(request.mock.calls.every(([method]) => method === "users.gitlab.status")).toBe(true);
  ui.unmount();
});

it("uses the native account rows and purpose controls for managed GitLab", async () => {
  const request = vi.fn(async (method: string, params?: { selectedScope?: string }) => {
    if (method === "users.gitlab.status") {
      return disconnected;
    }
    if (method === "tools.gitlab.status") {
      return {
        configured: true,
        issuer,
        selectedScope: params!.selectedScope,
        selected: null,
        effective: null,
        effectiveSource: "unavailable",
      };
    }
    throw new Error("Unexpected synthetic request");
  });
  const initial = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    hello: gatewayHelloForMethods([], ["operator.admin"]),
    selfUser: { id: "administrator-a" },
  } as ApplicationGatewaySnapshot;
  const { gateway } = createApplicationGateway(initial);
  const context = connectionContext(gateway);
  const ui = mountSolid(GitLabConnections, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  const button = (label: string) =>
    [...ui.container.querySelectorAll("button")].find(
      (entry) => entry.textContent?.trim() === label,
    );
  await waitForSolid(() => expect(button("Change System GitLab")).toBeDefined());
  expect(ui.container.textContent).toContain("My GitLab");
  expect(ui.container.textContent).toContain("GitLab for this agent");
  expect(button("Manage connections")).toBeDefined();
  expect(button("Verify")).toBeDefined();
  button("Change System GitLab")!.click();
  flush();
  expect(ui.container.textContent).toContain("For the system");
  expect(ui.container.textContent).toContain("Connect System GitLab");
  button("Connect My GitLab")!.click();
  flush();
  expect(ui.container.textContent).not.toContain("Connect System GitLab");
  expect(ui.container.textContent).toContain("GitLab authorization");
  expect(request.mock.calls.some(([method]) => method === "tools.gitlab.authorize.start")).toBe(
    false,
  );
  ui.unmount();
});
