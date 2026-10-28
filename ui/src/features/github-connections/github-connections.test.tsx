/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ToolsGitHubStatusResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { disconnectedGitHub } from "../../pages/profile/profile-rpc.test-support.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { GitHubConnections } from "./github-connections.tsx";
import { createMutationRunner } from "./github-identity-harness.test-support.ts";

const system: ToolsGitHubStatusResult["effective"] = {
  ...disconnectedGitHub.system,
  source: "system-configured",
  credentialKind: "managed-oauth",
  credentialState: "available",
  account: { login: "system-account" },
  evidence: "github-api",
  refreshState: "available",
  repositoryGrants: "unknown",
};
const disconnected = disconnectedGitHub.personal;
const personalStatus = { personal: disconnected, system };
const unavailable = "Connection status unavailable";
const statusParams = (agentId: string) => ({ agentId, selectedScope: "system" as const });
const status = (agentId = "main", effective = system): ToolsGitHubStatusResult => ({
  ...statusParams(agentId),
  selected: { scope: "system", configured: true, identity: effective },
  effective,
});
const statusRequest = (effective = system) =>
  vi.fn(async (method: string) =>
    method === "users.github.status" ? personalStatus : status("main", effective),
  );
function expectText(element: Element | null, present: string[], absent: string[] = []) {
  present.forEach((text) => expect(element?.textContent).toContain(text));
  absent.forEach((text) => expect(element?.textContent).not.toContain(text));
}
function mount(
  scopes: readonly string[],
  profileId: string | null,
  request: ReturnType<typeof vi.fn>,
  config: Record<string, unknown> | null = null,
) {
  const { gateway, publish } = createApplicationGateway({
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    hello: gatewayHelloForMethods([], scopes),
    selfUser: profileId ? { id: profileId } : null,
  } as ApplicationGatewaySnapshot);
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
  const context = {
    basePath: "/ui",
    navigate: vi.fn(),
    gateway,
    agents,
    settingsAgentSelection: createAgentSelectionCapability(gateway, agents, undefined, undefined, {
      requireConfiguredAgent: true,
    }),
    runtimeConfig: {
      state: { configForm: config },
      subscribe: () => () => undefined,
      ensureLoaded: vi.fn(async () => undefined),
      runExternalMutation: vi.fn(),
    },
  } as unknown as ApplicationContext;
  let triggerConnect!: () => void;
  const { container: element } = mountSolid(
    () => {
      return (
        <GitHubConnections
          onConnectReady={(command) => {
            triggerConnect = command ?? (() => {});
          }}
        />
      );
    },
    {
      wrapper: createSolidApplicationContextProvider(context).wrapper,
    },
  );
  const query = element.querySelector.bind(element);
  const button = (label: string) =>
    [...element.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label)!;
  const text = (present: string[], absent: string[] = []) => expectText(element, present, absent);
  return {
    element,
    context,
    query,
    text,
    waitText: (...args: Parameters<typeof text>) => waitForFast(() => text(...args)),
    row: (scope: string) => query(`[data-github-connection="${scope}"]`),
    button,
    triggerConnect,
    openPat: () =>
      ["Change System GitHub", "Use a PAT instead"].forEach((label) => {
        button(label).click();
        flush();
      }),
    replaceProfile: (id: string) => {
      gateway.snapshot.selfUser = { ...gateway.snapshot.selfUser!, id };
      publish(gateway.snapshot);
    },
    emit(next: Partial<ApplicationGatewaySnapshot>) {
      publish({ ...gateway.snapshot, ...next });
      flush();
    },
  };
}

it("opens the existing personal setup when selected from Add provider", async () => {
  const ui = mount(["operator.read"], "profile-a", statusRequest());
  await waitForFast(() => expect(ui.button("Manage connections").disabled).toBe(false));
  expect(ui.query("[data-github-setup]")).toBeNull();
  ui.triggerConnect();
  flush();
  await waitForFast(() => expect(ui.query("[data-github-setup]")).not.toBeNull());
  expect(ui.query("[data-github-setup]")?.textContent).toContain("For me");
});

it.each([
  ["unchanged", ["operator.admin"]],
  ["admin revoked", ["operator.read"]],
  ["read revoked", []],
] as const)("reconciles GitHub reconnect authority: %s", async (access, scopes) => {
  const sharedIdentity = { ...system, account: { login: "admin-only-account" } };
  const request = statusRequest(sharedIdentity);
  const config = { tools: { github: { gitAuthor: { name: "Configured author" } } } };
  const harness = mount(["operator.admin"], "profile-a", request, config);
  const { text, waitText, query, button, openPat } = harness;
  await waitText(["@admin-only-account"]);
  openPat();
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
  const expectDraft = () => {
    expect(input()).toMatchObject({ value: "Draft author", disabled: true });
    expect(token()?.value).toBe("synthetic-pat-draft");
  };
  expectDraft();
  text(["@admin-only-account"]);
  const reconnect = {
    phase: "connected" as const,
    selfUser: undefined,
    hello: gatewayHelloForMethods([], scopes),
  };
  harness.emit(reconnect);
  if (access === "unchanged") {
    expectDraft();
  } else {
    expect(query("[data-github-setup]")).toBeNull();
    text([], ["@admin-only-account"]);
    if (access === "read revoked") {
      text([], ["@system-account"]);
    }
    const reads = request.mock.calls.length;
    harness.emit(reconnect);
    text([], ["@admin-only-account"]);
    expect(request.mock.calls).toHaveLength(reads);
  }
  harness.context.runtimeConfig.state.configForm = config;
  harness.emit({ selfUser: { id: "profile-a" } });
  if (access !== "unchanged") {
    text([], ["@admin-only-account"]);
    expect(query("[data-github-setup]")).toBeNull();
    harness.emit({ hello: gatewayHelloForMethods([], ["operator.admin"]) });
    await waitForFast(() => expect(button("Change System GitHub")?.disabled).toBe(false));
    openPat();
    expect(input()?.value).toBe("Configured author");
    expect(token()?.value).toBe("");
  }
  await waitForFast(() => expect(input()?.disabled).toBe(false));
  expect(input()?.value).toBe(access === "unchanged" ? "Draft author" : "Configured author");
  harness.emit({ selfUser: { id: "profile-b" } });
  expect(input()).toBeNull();
});

it.each([null, "profile-a"])("separates GitHub scopes for profile %s", async (profileId) => {
  const pending = createDeferredCore<ToolsGitHubStatusResult>();
  const agentStatus = (agentId: string): ToolsGitHubStatusResult => ({
    ...status(agentId),
    effective: { ...system, source: "agent-override", account: { login: `${agentId}-account` } },
  });
  const request = vi.fn(async (method: string, params: { agentId?: string }) =>
    method === "users.github.status"
      ? personalStatus
      : profileId && params.agentId === "main"
        ? pending.promise
        : agentStatus(params.agentId ?? "main"),
  );
  const { context, row, text, waitText } = mount(["operator.admin"], profileId, request);
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("tools.github.status", statusParams("main")),
  );
  const agent = () => row("agent");
  if (profileId) {
    context.settingsAgentSelection.set("research");
    await waitText(["GitHub for Research"]);
    await waitForFast(() => expectText(agent(), ["@research-account"]));
    pending.resolve(agentStatus("main"));
    await pending.promise;
    await new Promise<void>(queueMicrotask);
    expectText(agent(), [], ["@main-account"]);
    const personalReads = request.mock.calls.filter(([method]) => method === "users.github.status");
    expect(personalReads).toHaveLength(1);
    expect(request).toHaveBeenCalledWith("tools.github.status", statusParams("research"));
  } else {
    await waitText(["@system-account"]);
    expect(request.mock.calls).toEqual([["tools.github.status", statusParams("main")]]);
    text(["Personal sign-in required"], ["Connect My GitHub"]);
  }
  const agentId = profileId ? "research" : "main";
  expectText(row("system"), ["@system-account"], [`@${agentId}-account`]);
  expectText(agent(), [`@${agentId}-account`, "Agent override", "Verified"]);
  agent()?.querySelector("button")?.click();
  expect(context.navigate).toHaveBeenCalledWith("agents", {
    pathname: `/ui/settings/agents/${agentId}/tools`,
  });
});

it("shows one status failure during setup and retries without reconnecting the account", async () => {
  const error = "GitHub status temporarily unavailable";
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error(error))
    .mockResolvedValue({
      personal: { ...disconnected, state: "connected", account: { login: "personal-account" } },
      system,
    });
  const ui = mount(["operator.read"], "profile-a", request);
  await waitForFast(() => expect(ui.query('[role="alert"]')?.textContent).toContain(error));
  expect(request.mock.calls).toEqual([["users.github.status", {}]]);
  ui.text(
    ["Retry", unavailable],
    ["Change System GitHub", "Not verified", "Connect My GitHub", "Not connected"],
  );
  expectText(ui.row("system"), [unavailable]);
  ui.button("Manage connections").click();
  await waitForFast(() => expect(ui.query("[data-github-setup]")).not.toBeNull());
  expect(ui.element.querySelectorAll('[role="alert"]')).toHaveLength(1);
  ui.button("Retry").click();
  await ui.waitText(["@personal-account"]);
  expect(request.mock.calls).toEqual([
    ["users.github.status", {}],
    ["users.github.status", {}],
  ]);
  expect(ui.query('[role="alert"]')).toBeNull();
  ui.text(["Change My GitHub"]);
});

it.each(["available", "unavailable"] as const)("loads native %s", async (credentialState) => {
  const label = credentialState === "available" ? "Verified" : "No credentials";
  const pending = createDeferredCore<typeof personalStatus>();
  const request = vi.fn(() => pending.promise);
  const { text, waitText, context, row } = mount(["operator.read"], "profile-a", request);
  await waitText(["Checking connection…"]);
  text([], ["Not verified", "Connect My GitHub"]);
  pending.resolve({
    personal: disconnected,
    system: {
      ...system,
      source: "system-detected",
      credentialKind: "native",
      credentialState,
      account: credentialState === "available" ? system.account : null,
    },
  });
  await waitText(["Not connected"]);
  text(["Connect My GitHub"], ["Checking connection…"]);
  await waitForFast(() => expectText(row("system"), [label]));
  expectText(row("system"), [], ["OS account running the Gateway"]);
  if (credentialState !== "unavailable") {
    expectText(row("system"), [], ["No credentials"]);
  }
  text(
    ["Connect My GitHub", "Admin managed"],
    [unavailable, "Change System GitHub", "Use a PAT instead"],
  );
  expect(request.mock.calls).toEqual([["users.github.status", {}]]);
  expect(context.runtimeConfig.ensureLoaded).not.toHaveBeenCalled();
});

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

it("disables connection controls while a PAT save is pending", async () => {
  const stored = createDeferredCore<{ ok: boolean }>();
  const request = vi.fn(async (method: string) =>
    method === "secrets.store.set"
      ? stored.promise
      : method === "users.github.status"
        ? personalStatus
        : status(),
  );
  const ui = mount(["operator.admin"], "profile-a", request);
  vi.mocked(ui.context.runtimeConfig.runExternalMutation).mockImplementation(
    createMutationRunner(ui.context.gateway.snapshot.client!),
  );
  await ui.waitText(["@system-account"]);
  ui.openPat();
  const token = ui.query<HTMLInputElement>(".settings-secret input")!;
  token.value = "synthetic-pending-pat";
  token.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  ui.button("Save Identity").click();
  flush();
  try {
    await waitForFast(() => expect(ui.button("Saving…").disabled).toBe(true));
    expect(ui.button("Verify").disabled).toBe(true);
    expect(ui.button("Change System GitHub").disabled).toBe(true);
  } finally {
    stored.resolve({ ok: true });
  }
  await waitForFast(() => expect(ui.button("Verify").disabled).toBe(false));
});
