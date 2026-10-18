/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ToolsGitHubStatusResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { GitHubConnections } from "./github-connections.tsx";

const system: ToolsGitHubStatusResult["effective"] = {
  source: "system-configured",
  credentialKind: "managed-oauth",
  credentialState: "available",
  account: { login: "system-account" },
  gitAuthor: { name: null, email: null },
  evidence: "github-api",
  accessExpiresAtMs: null,
  refreshState: "available",
  oauthScopes: [],
  repositoryGrants: "unknown",
};
const disconnected = {
  state: "disconnected",
  generation: null,
  account: null,
  accessExpiresAtMs: null,
  refreshState: "not_applicable",
  pending: null,
} as const;
function mount(
  scopes: string[],
  profileId: string | null,
  request: ReturnType<typeof vi.fn>,
  config: Record<string, unknown> | null = null,
) {
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  let snapshot = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    hello: gatewayHelloForMethods([], scopes),
    selfUser: profileId ? { id: profileId } : null,
  } as ApplicationGatewaySnapshot;
  const agents = {
    state: {
      agentsList: {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender" as const,
        agents: [
          { id: "main", name: "Clawd" },
          { id: "research", name: "Research" },
        ],
      },
    },
    subscribe: () => () => undefined,
  };
  const settingsAgentSelection = createAgentSelectionCapability(
    { connection: { gatewayUrl: "ws://gateway.test" }, snapshot, subscribe: () => () => {} },
    agents,
    undefined,
    undefined,
    { requireConfiguredAgent: true },
  );
  const context = {
    basePath: "/ui",
    navigate: vi.fn(),
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    agents,
    settingsAgentSelection,
    runtimeConfig: {
      state: { configForm: config },
      subscribe: () => () => undefined,
      ensureLoaded: vi.fn(async () => undefined),
      runExternalMutation: vi.fn(),
    },
  } as unknown as ApplicationContext;
  const { container: element } = mountSolid(GitHubConnections, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  return {
    element,
    context,
    replaceProfile: (id: string) => {
      snapshot.selfUser = { ...snapshot.selfUser!, id };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    emit(next: Partial<ApplicationGatewaySnapshot>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

it.each([
  { access: "unchanged", scopes: ["operator.admin"] },
  { access: "admin revoked", scopes: ["operator.read"] },
  { access: "read revoked", scopes: [] },
])(
  "reconciles retained GitHub work before reconnect identity resolves ($access)",
  async ({ access, scopes }) => {
    const sharedIdentity = { ...system, account: { login: "admin-only-account" } };
    const request = vi.fn(async (method: string) =>
      method === "users.github.status"
        ? { personal: disconnected, system }
        : {
            agentId: "main",
            selectedScope: "system",
            selected: { scope: "system", configured: true, identity: sharedIdentity },
            effective: sharedIdentity,
          },
    );
    const config = { tools: { github: { gitAuthor: { name: "Configured author" } } } };
    const harness = mount(["operator.admin"], "profile-a", request, config);
    await waitForFast(() => expect(harness.element.textContent).toContain("@admin-only-account"));
    const button = (label: string) =>
      [...harness.element.querySelectorAll<HTMLButtonElement>("button")].find(
        (entry) => entry.textContent?.trim() === label,
      )!;
    button("Change System GitHub").click();
    flush();
    button("Use a PAT instead").click();
    flush();
    const input = () =>
      harness.element.querySelector<HTMLInputElement>('input[aria-label="Author Name"]');
    const token = () => harness.element.querySelector<HTMLInputElement>(".settings-secret input");
    expect(input()).not.toBeNull();
    input()!.value = "Draft author";
    input()!.dispatchEvent(new Event("input", { bubbles: true }));
    token()!.value = "synthetic-pat-draft";
    token()!.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    harness.context.runtimeConfig.state.configForm = null;
    harness.emit({ phase: "reconnecting" });
    flush();
    expect(input()?.value).toBe("Draft author");
    expect(token()?.value).toBe("synthetic-pat-draft");
    expect(harness.element.textContent).toContain("@admin-only-account");
    expect(input()?.disabled).toBe(true);
    const reconnect = {
      phase: "connected" as const,
      selfUser: undefined,
      hello: gatewayHelloForMethods([], scopes),
    };
    harness.emit(reconnect);
    flush();
    if (access === "unchanged") {
      expect(input()?.value).toBe("Draft author");
      expect(token()?.value).toBe("synthetic-pat-draft");
      expect(input()?.disabled).toBe(true);
    } else {
      expect(harness.element.querySelector("[data-github-setup]")).toBeNull();
      expect(harness.element.textContent).not.toContain("@admin-only-account");
      if (access === "read revoked") {
        expect(harness.element.textContent).not.toContain("@system-account");
      }
      const reads = request.mock.calls.length;
      harness.emit(reconnect);
      flush();
      expect(harness.element.textContent).not.toContain("@admin-only-account");
      expect(request.mock.calls).toHaveLength(reads);
    }
    harness.context.runtimeConfig.state.configForm = config;
    harness.emit({ selfUser: { id: "profile-a" } });
    flush();
    if (access !== "unchanged") {
      expect(harness.element.textContent).not.toContain("@admin-only-account");
      expect(harness.element.querySelector("[data-github-setup]")).toBeNull();
      harness.emit({ hello: gatewayHelloForMethods([], ["operator.admin"]) });
      await waitForFast(() => expect(button("Change System GitHub")?.disabled).toBe(false));
      button("Change System GitHub").click();
      flush();
      button("Use a PAT instead").click();
      flush();
      expect(input()?.value).toBe("Configured author");
      expect(token()?.value).toBe("");
    }
    await waitForFast(() => expect(input()?.disabled).toBe(false));
    expect(input()?.value).toBe(access === "unchanged" ? "Draft author" : "Configured author");
    harness.emit({ selfUser: { id: "profile-b" } });
    flush();
    expect(input()).toBeNull();
  },
);

it("follows Settings selection for effective agent GitHub without changing personal or system scope", async () => {
  const pending = createDeferredCore<ToolsGitHubStatusResult>();
  const status = (agentId: string): ToolsGitHubStatusResult => ({
    agentId,
    selectedScope: "system",
    selected: { scope: "system", configured: true, identity: system },
    effective: { ...system, source: "agent-override", account: { login: `${agentId}-account` } },
  });
  const request = vi.fn(async (method: string, params: { agentId?: string }) =>
    method === "users.github.status"
      ? { personal: disconnected, system }
      : params.agentId === "main"
        ? pending.promise
        : status("research"),
  );
  const { element, context } = mount(["operator.admin"], "profile-a", request);
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("tools.github.status", {
      agentId: "main",
      selectedScope: "system",
    }),
  );
  context.settingsAgentSelection.set("research");
  await waitForFast(() => expect(element.textContent).toContain("GitHub for Research"));
  const agent = () => element.querySelector('[data-github-connection="agent"]');
  await waitForFast(() => expect(agent()?.textContent).toContain("@research-account"));
  pending.resolve(status("main"));
  await pending.promise;
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
  expect(agent()?.textContent).not.toContain("@main-account");
  expect(element.querySelector('[data-github-connection="system"]')?.textContent).toContain(
    "@system-account",
  );
  expect(request.mock.calls.filter(([method]) => method === "users.github.status")).toHaveLength(1);
  expect(request).toHaveBeenCalledWith("tools.github.status", {
    agentId: "research",
    selectedScope: "system",
  });
  agent()?.querySelector("button")?.click();
  expect(context.navigate).toHaveBeenCalledWith("agents", {
    pathname: "/ui/settings/agents/research/tools",
  });
});

it("uses explicit unbound admin context for System without probing personal status", async () => {
  const request = vi.fn(async () => ({
    agentId: "main",
    selectedScope: "system",
    selected: { scope: "system", configured: true, identity: system },
    effective: { ...system, source: "agent-override", account: { login: "agent-account" } },
  }));
  const { element, context } = mount(["operator.admin"], null, request);
  await waitForFast(() => expect(element.textContent).toContain("@system-account"));
  expect(request.mock.calls).toEqual([
    ["tools.github.status", { agentId: "main", selectedScope: "system" }],
  ]);
  expect(element.textContent).toContain("Personal sign-in required");
  expect(element.textContent).not.toContain("Connect My GitHub");
  const shared = element.querySelector('[data-github-connection="system"]');
  const agent = element.querySelector('[data-github-connection="agent"]');
  expect(shared?.textContent).toContain("@system-account");
  expect(shared?.textContent).not.toContain("@agent-account");
  expect(agent?.textContent).toContain("@agent-account");
  expect(agent?.textContent).toContain("Agent override");
  expect(agent?.textContent).toContain("Verified");
  agent?.querySelector("button")?.click();
  expect(context.navigate).toHaveBeenCalledWith("agents", {
    pathname: "/ui/settings/agents/main/tools",
  });
});

it("shows an identified status failure once while opening personal setup", async () => {
  const request = vi.fn(async () => {
    throw new Error("GitHub status temporarily unavailable");
  });
  const { element } = mount(["operator.read"], "profile-a", request);
  await waitForFast(() =>
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "GitHub status temporarily unavailable",
    ),
  );
  expect(request.mock.calls).toEqual([["users.github.status", {}]]);
  expect(element.textContent).not.toContain("Change System GitHub");
  expect(element.textContent).toContain("Retry");
  expect(element.textContent).toContain("Connection status unavailable");
  expect(element.textContent).not.toContain("Not verified");
  expect(element.textContent).not.toContain("Connect My GitHub");
  expect(element.textContent).not.toContain("Not connected");
  expect(element.querySelector('[data-github-connection="system"]')?.textContent).toContain(
    "Connection status unavailable",
  );
  Array.from(element.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === "Manage connections")
    ?.click();
  await waitForFast(() => expect(element.querySelector("[data-github-setup]")).not.toBeNull());
  expect(element.querySelectorAll('[role="alert"]')).toHaveLength(1);
});

it("shows loading rather than disconnected until personal connection status arrives", async () => {
  const status = createDeferredCore<{ personal: typeof disconnected; system: typeof system }>();
  const request = vi.fn(() => status.promise);
  const { element } = mount(["operator.read"], "profile-a", request);
  await waitForFast(() => expect(element.textContent).toContain("Checking connection…"));
  expect(element.textContent).not.toContain("Not verified");
  expect(element.textContent).not.toContain("Connect My GitHub");
  status.resolve({ personal: disconnected, system });
  await waitForFast(() => expect(element.textContent).toContain("Not connected"));
  expect(element.textContent).toContain("Connect My GitHub");
  expect(element.textContent).not.toContain("Checking connection…");
});

it("retries failed status without reconnecting the GitHub account", async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error("Status lookup failed"))
    .mockResolvedValue({
      personal: { ...disconnected, state: "connected", account: { login: "personal-account" } },
      system,
    });
  const { element } = mount(["operator.read"], "profile-a", request);
  await waitForFast(() => expect(element.textContent).toContain("Connection status unavailable"));
  Array.from(element.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === "Retry")
    ?.click();
  await waitForFast(() => expect(element.textContent).toContain("@personal-account"));
  expect(request.mock.calls).toEqual([
    ["users.github.status", {}],
    ["users.github.status", {}],
  ]);
  expect(element.querySelector('[role="alert"]')).toBeNull();
  expect(element.textContent).toContain("Change My GitHub");
});

it.each([
  ["native", "available", "Verified"],
  ["native", "unavailable", "No credentials"],
] as const)(
  "shows %s %s without extra native-account explanation",
  async (credentialKind, credentialState, label) => {
    const request = vi.fn(async () => ({
      personal: disconnected,
      system: {
        ...system,
        source: credentialKind === "native" ? "system-detected" : "system-configured",
        credentialKind,
        credentialState,
        account: credentialState === "available" ? system.account : null,
      },
    }));
    const { element, context } = mount(["operator.read"], "profile-a", request);
    const row = () => element.querySelector('[data-github-connection="system"]');
    await waitForFast(() => expect(row()?.textContent).toContain(label));
    expect(row()?.textContent).not.toContain("OS account running the Gateway");
    if (credentialState !== "unavailable") {
      expect(row()?.textContent).not.toContain("No credentials");
    }
    expect(element.textContent).not.toContain("Connection status unavailable");
    expect(element.textContent).toContain("Connect My GitHub");
    expect(request.mock.calls).toEqual([["users.github.status", {}]]);
    expect(context.runtimeConfig.ensureLoaded).not.toHaveBeenCalled();
    expect(element.textContent).toContain("Admin managed");
    expect(element.textContent).not.toContain("Change System GitHub");
    expect(element.textContent).not.toContain("Use a PAT instead");
  },
);

it("closes setup and resets its purpose when the same Gateway snapshot changes profile", async () => {
  const request = vi.fn(async (method: string) =>
    method === "users.github.status"
      ? { personal: disconnected, system }
      : {
          agentId: "main",
          selectedScope: "system",
          selected: { scope: "system", configured: true, identity: system },
          effective: system,
        },
  );
  const { element, replaceProfile } = mount(["operator.admin"], "profile-a", request);
  const button = (label: string) =>
    Array.from(element.querySelectorAll("button")).find(
      (entry) => entry.textContent?.trim() === label,
    )!;
  await waitForFast(() => expect(button("Change System GitHub").disabled).toBe(false));
  button("Change System GitHub").click();
  await waitForFast(() =>
    expect(element.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value).toBe(
      "system",
    ),
  );
  button("Use a PAT instead").click();
  await waitForFast(() => expect(element.querySelector(".settings-secret input")).not.toBeNull());
  replaceProfile("profile-b");
  await waitForFast(() => expect(element.querySelector("[data-github-setup]")).toBeNull());
  await waitForFast(() => expect(button("Manage connections").disabled).toBe(false));
  button("Manage connections").click();
  await waitForFast(() =>
    expect(element.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value).toBe(
      "personal",
    ),
  );
  expect(element.querySelector(".settings-secret input")).toBeNull();
});
