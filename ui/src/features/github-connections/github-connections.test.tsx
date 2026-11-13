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
const unavailable = "Couldn’t load account status. Try again.";
type Scope = "system" | "agent";
type StatusParams = { agentId?: string; selectedScope?: Scope };
const statusParams = (agentId: string, selectedScope: Scope = "system") => ({
  agentId,
  selectedScope,
});
/** The Gateway answers for the scope asked; agents without an override report the shared account. */
const status = (
  agentId = "main",
  effective = system,
  selectedScope: Scope = "system",
): ToolsGitHubStatusResult => ({
  ...statusParams(agentId, selectedScope),
  selected: {
    scope: selectedScope,
    configured: selectedScope === "system" || effective.source === "agent-override",
    identity:
      selectedScope === "system" || effective.source === "agent-override" ? effective : null,
  },
  effective,
});
const statusFor = (params: StatusParams | undefined, effective = system) =>
  status(params?.agentId ?? "main", effective, params?.selectedScope ?? "system");
const statusRequest = (effective = system) =>
  vi.fn(async (method: string, params?: StatusParams) =>
    method === "users.github.status" ? personalStatus : statusFor(params, effective),
  );
function expectText(element: Element | null, present: string[], absent: string[] = []) {
  // Row buttons show a short verb; their full name is what tells them apart.
  const names = [...(element?.querySelectorAll("button[aria-label]") ?? [])].map((button) =>
    button.getAttribute("aria-label"),
  );
  const content = [element?.textContent, ...names].join(" ");
  present.forEach((text) => expect(content).toContain(text));
  absent.forEach((text) => expect(content).not.toContain(text));
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
  const { container: element } = mountSolid(GitHubConnections, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  const query = element.querySelector.bind(element);
  const button = (label: string) =>
    [...element.querySelectorAll("button")].find(
      (entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === label,
    )!;
  const text = (present: string[], absent: string[] = []) => expectText(element, present, absent);
  return {
    element,
    context,
    query,
    text,
    waitText: (...args: Parameters<typeof text>) => waitForFast(() => text(...args)),
    row: (scope: string) => query(`[data-github-connection="${scope}"]`),
    button,
    openPat: () =>
      ["Change shared agent account", "Use a PAT instead"].forEach((label) => {
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
  const input = () => query<HTMLInputElement>('input[aria-label="Commit author name (optional)"]');
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
    await waitForFast(() => expect(button("Change shared agent account")?.disabled).toBe(false));
    openPat();
    expect(input()?.value).toBe("Configured author");
    expect(token()?.value).toBe("");
  }
  await waitForFast(() => expect(input()?.disabled).toBe(false));
  expect(input()?.value).toBe(access === "unchanged" ? "Draft author" : "Configured author");
  harness.emit({ selfUser: { id: "profile-b" } });
  expect(input()).toBeNull();
});

it("shows the shared and agent accounts to an admin without a personal profile", async () => {
  const request = statusRequest();
  const { waitText, row, query, text } = mount(["operator.admin"], null, request);
  await waitText(["@system-account"]);
  await waitForFast(() => expectText(query('[data-agent-id="research"]'), ["@system-account"]));
  text(["Personal sign-in required"], ["Connect My GitHub"]);
  // The shared account's row names everything it serves, not only agents.
  expectText(row("system"), [
    "Shared agent account",
    "Agents without their own account, including their dashboards and Publish PR",
  ]);
  expect(request.mock.calls.map(([, params]) => params)).toEqual(
    expect.arrayContaining([
      statusParams("main"),
      statusParams("main", "agent"),
      statusParams("research", "agent"),
    ]),
  );
  expect(request).not.toHaveBeenCalledWith("users.github.status", {});
});

it("lists every agent's account and opens setup under only the chosen agent", async () => {
  const ownAccount = {
    ...system,
    source: "agent-override" as const,
    credentialKind: "managed-pat" as const,
    account: { login: "research-bot" },
  };
  const config = { agents: { entries: { research: { tools: { github: { mode: "managed" } } } } } };
  const request = vi.fn(async (method: string, params?: StatusParams) =>
    method === "users.github.status"
      ? personalStatus
      : statusFor(params, params?.agentId === "research" ? ownAccount : system),
  );
  const ui = mount(["operator.admin"], "profile-a", request, config);
  const agentRow = (id: string) => ui.query(`[data-agent-id="${id}"]`);
  await waitForFast(() => expectText(agentRow("research"), ["@research-bot"]));
  await waitForFast(() => expectText(agentRow("main"), ["@system-account"]));
  expectText(ui.row("system"), ["Shared agent account", "@system-account", "Change for 1 agent"]);
  // The same login can serve both connections, so the source is always spelled out.
  expectText(
    agentRow("main"),
    ["Clawd", "Uses the shared agent account", "Give Clawd its own GitHub account"],
    ["Use the shared agent account for Clawd"],
  );
  expectText(
    agentRow("research"),
    [
      "Research",
      "Own account · Personal access token",
      "Change the GitHub account for Research",
      "Use the shared agent account for Research",
    ],
    ["Give Research its own GitHub account"],
  );
  await waitForFast(() =>
    expect(ui.button("Give Clawd its own GitHub account").disabled).toBe(false),
  );
  ui.button("Give Clawd its own GitHub account").click();
  await waitForFast(() =>
    expect(agentRow("main")?.querySelector("[data-github-setup]")).not.toBeNull(),
  );
  expectText(agentRow("main"), ["Own account for Clawd", "Only Clawd changes."]);
  expect(agentRow("research")?.querySelector("[data-github-setup]")).toBeNull();
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
    ["Change shared agent account", "Not verified", "Connect My GitHub", "Disconnected"],
  );
  expectText(ui.row("system"), [unavailable]);
  ui.button("Manage accounts").click();
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
  const label = credentialState === "available" ? "Verified" : "No account";
  const pending = createDeferredCore<typeof personalStatus>();
  const request = vi.fn(() => pending.promise);
  const { text, waitText, context, row } = mount(["operator.read"], "profile-a", request);
  await waitText(["Loading account status…"]);
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
  await waitText(["Disconnected"]);
  text(["Connect My GitHub"], ["Loading account status…"]);
  await waitForFast(() => expectText(row("system"), [label]));
  expectText(row("system"), [], ["OS account running the Gateway"]);
  if (credentialState !== "unavailable") {
    expectText(row("system"), [], ["No account"]);
  }
  text(
    ["Connect My GitHub", "Managed by admins"],
    [unavailable, "Change shared agent account", "Use a PAT instead"],
  );
  expect(request.mock.calls).toEqual([["users.github.status", {}]]);
  expect(context.runtimeConfig.ensureLoaded).not.toHaveBeenCalled();
});

it("closes setup and resets its purpose when the same Gateway snapshot changes profile", async () => {
  const { query, button, replaceProfile } = mount(["operator.admin"], "profile-a", statusRequest());
  const setupRow = () => query("[data-github-setup]")?.closest("[data-github-connection]");
  const purpose = () => setupRow()?.getAttribute("data-github-connection");
  await waitForFast(() => expect(button("Change shared agent account").disabled).toBe(false));
  button("Change shared agent account").click();
  await waitForFast(() => expect(purpose()).toBe("system"));
  button("Use a PAT instead").click();
  await waitForFast(() => expect(query(".settings-secret input")).not.toBeNull());
  replaceProfile("profile-b");
  await waitForFast(() => expect(query("[data-github-setup]")).toBeNull());
  await waitForFast(() => expect(button("Connect My GitHub").disabled).toBe(false));
  button("Connect My GitHub").click();
  await waitForFast(() => expect(purpose()).toBe("personal"));
  expect(query(".settings-secret input")).toBeNull();
});

it("disables connection controls while a PAT save is pending", async () => {
  const stored = createDeferredCore<{ ok: boolean }>();
  const request = vi.fn(async (method: string, params?: StatusParams) =>
    method === "secrets.store.set"
      ? stored.promise
      : method === "users.github.status"
        ? personalStatus
        : statusFor(params),
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
  ui.button("Save account").click();
  flush();
  try {
    await waitForFast(() => expect(ui.button("Saving…").disabled).toBe(true));
    expect(ui.button("Verify").disabled).toBe(true);
    expect(ui.button("Change shared agent account").disabled).toBe(true);
  } finally {
    stored.resolve({ ok: true });
  }
  await waitForFast(() => expect(ui.button("Verify").disabled).toBe(false));
});

it("opens setup under the connection it changes, with that connection's own actions", async () => {
  const request = vi.fn(async (method: string, params?: StatusParams) =>
    method === "users.github.status"
      ? {
          personal: { ...disconnected, state: "connected", account: { login: "personal-account" } },
          system,
        }
      : statusFor(params),
  );
  const ui = mount(["operator.admin"], "profile-a", request);
  await ui.waitText(["@personal-account", "@system-account"]);
  ui.text([], ["Disconnect My GitHub", "Use GitHub CLI", "Manage accounts"]);
  await waitForFast(() => expect(ui.button("Change My GitHub").disabled).toBe(false));

  ui.button("Change My GitHub").click();
  await waitForFast(() =>
    expect(ui.row("personal")?.querySelector("[data-github-setup]")).not.toBeNull(),
  );
  expectText(ui.row("personal"), ["Disconnect My GitHub"], ["Use GitHub CLI"]);

  ui.button("Change shared agent account").click();
  await waitForFast(() =>
    expect(ui.row("system")?.querySelector("[data-github-setup]")).not.toBeNull(),
  );
  expect(ui.row("personal")?.querySelector("[data-github-setup]")).toBeNull();
  expectText(ui.row("system"), ["Use GitHub CLI"], ["Disconnect My GitHub"]);

  ui.button("Close").click();
  await waitForFast(() => expect(ui.query("[data-github-setup]")).toBeNull());
});
