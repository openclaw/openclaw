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
const status = (agentId = "main", effective = system): ToolsGitHubStatusResult => ({
  agentId,
  selectedScope: "system",
  selected: { scope: "system", configured: true, identity: effective },
  effective,
});
const statusRequest = (effective = system) =>
  vi.fn(async (method: string) =>
    method === "users.github.status"
      ? { personal: disconnected, system }
      : status("main", effective),
  );
const statusParams = (agentId: string) => ({ agentId, selectedScope: "system" });
function expectText(element: Element | null, present: string[], absent: string[] = []) {
  for (const text of present) {
    expect(element?.textContent).toContain(text);
  }
  for (const text of absent) {
    expect(element?.textContent).not.toContain(text);
  }
}
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
  const query = <T extends Element = HTMLElement>(selector: string) =>
    element.querySelector<T>(selector);
  return {
    element,
    context,
    query,
    row: (scope: string) => query(`[data-github-connection="${scope}"]`),
    button: (label: string) =>
      [...element.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label)!,
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
    const request = statusRequest(sharedIdentity);
    const config = { tools: { github: { gitAuthor: { name: "Configured author" } } } };
    const harness = mount(["operator.admin"], "profile-a", request, config);
    const { element, query, button } = harness;
    await waitForFast(() => expectText(element, ["@admin-only-account"]));
    button("Change System GitHub").click();
    flush();
    button("Use a PAT instead").click();
    flush();
    const input = () => query<HTMLInputElement>('input[aria-label="Author Name"]');
    const token = () => query<HTMLInputElement>(".settings-secret input");
    expect(input()).not.toBeNull();
    input()!.value = "Draft author";
    input()!.dispatchEvent(new Event("input", { bubbles: true }));
    token()!.value = "synthetic-pat-draft";
    token()!.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    harness.context.runtimeConfig.state.configForm = null;
    harness.emit({ phase: "reconnecting" });
    flush();
    const expectDraft = () => {
      expect(input()).toMatchObject({ value: "Draft author", disabled: true });
      expect(token()?.value).toBe("synthetic-pat-draft");
    };
    expectDraft();
    expectText(element, ["@admin-only-account"]);
    const reconnect = {
      phase: "connected" as const,
      selfUser: undefined,
      hello: gatewayHelloForMethods([], scopes),
    };
    harness.emit(reconnect);
    flush();
    if (access === "unchanged") {
      expectDraft();
    } else {
      expect(query("[data-github-setup]")).toBeNull();
      expectText(element, [], ["@admin-only-account"]);
      if (access === "read revoked") {
        expectText(element, [], ["@system-account"]);
      }
      const reads = request.mock.calls.length;
      harness.emit(reconnect);
      flush();
      expectText(element, [], ["@admin-only-account"]);
      expect(request.mock.calls).toHaveLength(reads);
    }
    harness.context.runtimeConfig.state.configForm = config;
    harness.emit({ selfUser: { id: "profile-a" } });
    flush();
    if (access !== "unchanged") {
      expectText(element, [], ["@admin-only-account"]);
      expect(query("[data-github-setup]")).toBeNull();
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
  const agentStatus = (agentId: string): ToolsGitHubStatusResult => ({
    ...status(agentId),
    effective: { ...system, source: "agent-override", account: { login: `${agentId}-account` } },
  });
  const request = vi.fn(async (method: string, params: { agentId?: string }) =>
    method === "users.github.status"
      ? { personal: disconnected, system }
      : params.agentId === "main"
        ? pending.promise
        : agentStatus("research"),
  );
  const { element, context, row } = mount(["operator.admin"], "profile-a", request);
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("tools.github.status", statusParams("main")),
  );
  context.settingsAgentSelection.set("research");
  await waitForFast(() => expect(element.textContent).toContain("GitHub for Research"));
  const agent = () => row("agent");
  await waitForFast(() => expect(agent()?.textContent).toContain("@research-account"));
  pending.resolve(agentStatus("main"));
  await pending.promise;
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
  expect(agent()?.textContent).not.toContain("@main-account");
  expectText(row("system"), ["@system-account"]);
  expect(request.mock.calls.filter(([method]) => method === "users.github.status")).toHaveLength(1);
  expect(request).toHaveBeenCalledWith("tools.github.status", statusParams("research"));
  agent()?.querySelector("button")?.click();
  expect(context.navigate).toHaveBeenCalledWith("agents", {
    pathname: "/ui/settings/agents/research/tools",
  });
});

it("uses explicit unbound admin context for System without probing personal status", async () => {
  const request = vi.fn(async () => ({
    ...status(),
    effective: { ...system, source: "agent-override", account: { login: "agent-account" } },
  }));
  const { element, context, row } = mount(["operator.admin"], null, request);
  await waitForFast(() => expect(element.textContent).toContain("@system-account"));
  expect(request.mock.calls).toEqual([["tools.github.status", statusParams("main")]]);
  expectText(element, ["Personal sign-in required"], ["Connect My GitHub"]);
  const agent = row("agent");
  expectText(row("system"), ["@system-account"], ["@agent-account"]);
  expectText(agent, ["@agent-account", "Agent override", "Verified"]);
  agent?.querySelector("button")?.click();
  expect(context.navigate).toHaveBeenCalledWith("agents", {
    pathname: "/ui/settings/agents/main/tools",
  });
});

it("shows an identified status failure once while opening personal setup", async () => {
  const request = vi.fn(async () => {
    throw new Error("GitHub status temporarily unavailable");
  });
  const { element, query, row, button } = mount(["operator.read"], "profile-a", request);
  await waitForFast(() =>
    expect(query('[role="alert"]')?.textContent).toContain("GitHub status temporarily unavailable"),
  );
  expect(request.mock.calls).toEqual([["users.github.status", {}]]);
  expectText(
    element,
    ["Retry", "Connection status unavailable"],
    ["Change System GitHub", "Not verified", "Connect My GitHub", "Not connected"],
  );
  expectText(row("system"), ["Connection status unavailable"]);
  button("Manage connections").click();
  await waitForFast(() => expect(query("[data-github-setup]")).not.toBeNull());
  expect(element.querySelectorAll('[role="alert"]')).toHaveLength(1);
});

it("shows loading rather than disconnected until personal connection status arrives", async () => {
  const pending = createDeferredCore<{ personal: typeof disconnected; system: typeof system }>();
  const request = vi.fn(() => pending.promise);
  const { element } = mount(["operator.read"], "profile-a", request);
  await waitForFast(() => expect(element.textContent).toContain("Checking connection…"));
  expectText(element, [], ["Not verified", "Connect My GitHub"]);
  pending.resolve({ personal: disconnected, system });
  await waitForFast(() => expect(element.textContent).toContain("Not connected"));
  expectText(element, ["Connect My GitHub"], ["Checking connection…"]);
});

it("retries failed status without reconnecting the GitHub account", async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error("Status lookup failed"))
    .mockResolvedValue({
      personal: { ...disconnected, state: "connected", account: { login: "personal-account" } },
      system,
    });
  const { element, button } = mount(["operator.read"], "profile-a", request);
  await waitForFast(() => expect(element.textContent).toContain("Connection status unavailable"));
  button("Retry").click();
  await waitForFast(() => expect(element.textContent).toContain("@personal-account"));
  expect(request.mock.calls).toEqual([
    ["users.github.status", {}],
    ["users.github.status", {}],
  ]);
  expect(element.querySelector('[role="alert"]')).toBeNull();
  expect(element.textContent).toContain("Change My GitHub");
});

it.each([
  ["available", "Verified"],
  ["unavailable", "No credentials"],
] as const)(
  "shows native %s without extra native-account explanation",
  async (credentialState, label) => {
    const request = vi.fn(async () => ({
      personal: disconnected,
      system: {
        ...system,
        source: "system-detected",
        credentialKind: "native",
        credentialState,
        account: credentialState === "available" ? system.account : null,
      },
    }));
    const { element, context, row } = mount(["operator.read"], "profile-a", request);
    await waitForFast(() => expectText(row("system"), [label]));
    expectText(row("system"), [], ["OS account running the Gateway"]);
    if (credentialState !== "unavailable") {
      expectText(row("system"), [], ["No credentials"]);
    }
    expectText(
      element,
      ["Connect My GitHub", "Admin managed"],
      ["Connection status unavailable", "Change System GitHub", "Use a PAT instead"],
    );
    expect(request.mock.calls).toEqual([["users.github.status", {}]]);
    expect(context.runtimeConfig.ensureLoaded).not.toHaveBeenCalled();
  },
);

it("closes setup and resets its purpose when the same Gateway snapshot changes profile", async () => {
  const { query, button, replaceProfile } = mount(["operator.admin"], "profile-a", statusRequest());
  const purpose = () => query<HTMLInputElement>('input[type="radio"]:checked')?.value;
  await waitForFast(() => expect(button("Change System GitHub").disabled).toBe(false));
  button("Change System GitHub").click();
  await waitForFast(() => expect(purpose()).toBe("system"));
  button("Use a PAT instead").click();
  await waitForFast(() => expect(query(".settings-secret input")).not.toBeNull());
  replaceProfile("profile-b");
  await waitForFast(() => expect(query("[data-github-setup]")).toBeNull());
  await waitForFast(() => expect(button("Manage connections").disabled).toBe(false));
  button("Manage connections").click();
  await waitForFast(() => expect(purpose()).toBe("personal"));
  expect(query(".settings-secret input")).toBeNull();
});
