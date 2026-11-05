/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../api/gateway.ts";
import type { WizardNextResult } from "../api/types.ts";
import { createAgentSelectionCapability } from "../app/agent-selection.ts";
import type { ApplicationContext } from "../app/context.ts";
import { i18n } from "../i18n/index.ts";
import type { ConfigPatchOptions } from "../lib/config/config-gateway-operations.ts";
import { configSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import { createConfigCapabilityHarness } from "../lib/config/config-test-harness.ts";
import { resolveReadMcpServerRuntime, type McpToolsRead } from "../lib/config/mcp-server-status.ts";
import type { RuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import * as uuid from "../lib/uuid.ts";
import { createApplicationGatewaySnapshot } from "../test-helpers/application-context-fixtures.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid as waitForFast } from "../test-helpers/solid-settle.ts";
import { showConfirmDialog } from "./confirm-dialog.ts";
import { McpServersCard } from "./mcp-servers-card.tsx";

vi.mock("./confirm-dialog.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./confirm-dialog.ts")>()),
  showConfirmDialog: vi.fn(),
}));
type ConfigPatchBuilder = Parameters<RuntimeConfigCapability["patchFromSnapshot"]>[0];
function createRuntimeConfig(config: Record<string, unknown>) {
  const ensureLoaded = vi.fn<() => Promise<void>>(async () => undefined);
  const patch = vi.fn<(options: ConfigPatchOptions) => Promise<boolean>>(async () => true);
  const state = {
    configSnapshot: { sourceConfig: config, hash: "base" },
    lastError: null as string | null,
  };
  const runtimeConfig = {
    state,
    ensureLoaded,
    async patchFromSnapshot(build: ConfigPatchBuilder) {
      const built = build(config);
      if ("error" in built) {
        state.lastError = built.error;
        return false;
      }
      return patch(built.options);
    },
    subscribe: () => () => undefined,
  } as unknown as ApplicationContext["runtimeConfig"];
  return { runtimeConfig, ensureLoaded, patch };
}
async function mountCard(
  options: {
    servers?: Record<string, unknown>;
    client?: GatewayBrowserClient;
    admin?: boolean;
    methods?: string[];
    runtimeConfig?: RuntimeConfigCapability;
    initialLoad?: Promise<void>;
  } = {},
) {
  const harness = createRuntimeConfig(configWith(options.servers ?? {}));
  if (options.initialLoad) {
    harness.ensureLoaded.mockReturnValueOnce(options.initialLoad);
  }
  const connection = createApplicationGateway(
    createApplicationGatewaySnapshot({
      client: options.client ?? null,
      phase: "connected",
      assistantAgentId: "main",
      sessionKey: "main",
      hello: gatewayHelloForMethods(
        options.methods ?? [],
        options.admin === false ? ["operator.read"] : ["operator.read", "operator.admin"],
      ),
    }),
  );
  const { gateway } = connection;
  const context = {
    gateway,
    agentSelection: createAgentSelectionCapability(gateway, {
      state: { agentsList: null },
      subscribe: () => () => undefined,
    }),
    runtimeConfig: options.runtimeConfig ?? harness.runtimeConfig,
    basePath: "",
  } as unknown as ApplicationContext;
  const { container } = mountSolid(
    () =>
      createComponent(McpServersCard, {
        docsUrl: "https://docs.openclaw.ai/tools/mcp",
      }),
    { wrapper: createSolidApplicationContextProvider(context).wrapper },
  );
  flush();
  const card = expectDefined(
    container.querySelector<HTMLElement>("openclaw-mcp-servers-card"),
    "MCP servers card",
  );
  return { card, context, harness, connection };
}
function actionButton(container: Element, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    (candidate.getAttribute("aria-label") ?? candidate.textContent ?? "").includes(label),
  );
  return expectDefined(button, `${label} button`);
}
function openRow(card: HTMLElement, name: string) {
  expectDefined(
    card.querySelector<HTMLButtonElement>(`[data-mcp-name="${name}"] .mcp-server-row__summary`),
    `${name} row`,
  ).click();
  flush();
}
function enabledSwitch(card: HTMLElement, name: string): HTMLInputElement {
  return expectDefined(
    card.querySelector<HTMLInputElement>(`input[role="switch"][aria-label="${name}"]`),
    `${name} switch`,
  );
}
async function submitAddForm(
  card: HTMLElement,
  name: string,
  target: string,
  transport: "streamable-http" | "sse" | "stdio" = "streamable-http",
) {
  expect(card.querySelector(".mcp-server-form")).toBeNull();
  actionButton(card, "Add server").click();
  flush();
  const form = expectDefined(card.querySelector<HTMLFormElement>(".mcp-server-form"), "MCP form");
  const field = (fieldName: string) =>
    expectDefined(
      form.querySelector<HTMLInputElement>(`[name="mcp-${fieldName}"]`),
      `${fieldName} field`,
    );
  field("name").value = name;
  expectDefined(
    form.querySelector<HTMLInputElement>(`input[type="radio"][value="${transport}"]`),
    "transport option",
  ).click();
  flush();
  field("target").value = target;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}
const configWith = (servers: Record<string, unknown>) => ({ mcp: { servers } });
const localServer = { command: "node" };
const docsServer = { url: "https://mcp.example.com/mcp" };
const httpTransport = "streamable-http";
const httpSseUrl = "https://mcp.test/sse";
const eventsUrl = "https://mcp.test/events?token=test";
const loginCommand = "openclaw mcp login docs";
function message(card: HTMLElement, role: "alert" | "status" = "status") {
  return card.querySelector(`[role="${role}"]`)?.textContent;
}
function waitMessage(card: HTMLElement, text: string, role: "alert" | "status" = "status") {
  return waitForFast(() => expect(message(card, role)).toBe(text));
}
function expectNamedAction(card: HTMLElement, name: string, label: string) {
  const button = card.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`);
  expect(button?.textContent?.trim()).toBe(label);
}
const loginSessionId = "00000000-0000-4000-8000-000000000001";
const loginUrl = "https://provider.example/authorize";
const oauthServer = { url: "https://mcp.example.com/mcp", auth: "oauth" };
const browserStep = {
  done: false,
  status: "running",
  step: { id: "browser", type: "text", externalUrl: loginUrl },
} satisfies WizardNextResult;
async function mountLoginCard(
  options: { admin?: boolean; methods?: string[]; server?: Record<string, unknown> } = {},
) {
  vi.spyOn(uuid, "generateUUID").mockReturnValue(loginSessionId);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const client = new GatewayBrowserClient({ url: "ws://gateway-a.example.test" });
  const request = vi.spyOn(client, "request").mockRejectedValue(new Error("Unexpected request"));
  const mounted = await mountCard({
    client,
    admin: options.admin,
    methods: options.methods ?? ["mcp.authLogin"],
    servers: { docs: options.server ?? oauthServer },
  });
  return { ...mounted, request, open };
}
beforeEach(async () => {
  await i18n.setLocale("en");
  vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(true);
});
afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
});
it.each(["initial", "load", "patch refusal"])(
  "recovers from %s without racing mutations or old reads",
  async (stage) => {
    const initialLoad = deferred();
    const { card, harness } = await mountCard({
      servers: {
        local: localServer,
        other: { ...localServer, enabled: false },
      },
      initialLoad: initialLoad.promise,
    });
    const failure = new Error("Mutation failed");
    if (stage === "initial") {
      initialLoad.reject(failure);
    } else {
      if (stage === "load") {
        harness.ensureLoaded.mockRejectedValueOnce(failure);
      } else {
        harness.runtimeConfig.state.lastError = failure.message;
        harness.patch.mockResolvedValueOnce(false);
      }
      enabledSwitch(card, "local").click();
    }
    await waitMessage(card, failure.message, "alert");
    const local = enabledSwitch(card, "local");
    expect(local.disabled).toBe(false);
    expect(local.checked).toBe(true);
    harness.patch.mockClear();
    const completion = deferred<boolean>();
    harness.patch.mockReturnValueOnce(completion.promise);
    expect(enabledSwitch(card, "other").checked).toBe(false);
    openRow(card, "local");
    local.click();
    actionButton(card, "Remove local").click();
    await waitForFast(() => expect(harness.patch).toHaveBeenCalledOnce());
    expect(harness.patch.mock.calls[0]?.[0].raw).toEqual(configWith({ local: { enabled: false } }));
    expect(card.querySelector('[role="alert"]')).toBeNull();
    expect(local.getAttribute("aria-disabled")).toBe("true");
    expect(actionButton(card, "Add server").disabled).toBe(true);
    expect(enabledSwitch(card, "other").getAttribute("aria-disabled")).toBe("true");
    completion.resolve(true);
    await waitForFast(() => {
      expect(local.getAttribute("aria-disabled")).toBeNull();
      expect(message(card)).toBe("Disabled MCP server local.");
    });
    if (stage !== "initial") {
      initialLoad.reject(new Error("Earlier read failed"));
      await initialLoad.promise.catch(() => {});
      await waitForFast(() => {
        expect(card.querySelector('[role="alert"]')).toBeNull();
        expect(message(card)).toBe("Disabled MCP server local.");
      });
    }
    enabledSwitch(card, "other").click();
    await waitForFast(() => expect(harness.patch).toHaveBeenCalledTimes(2));
    expect(harness.patch.mock.calls[1]?.[0].raw).toEqual(configWith({ other: { enabled: null } }));
  },
);
it("starts the selected connector and keeps a usable link when the popup is blocked", async () => {
  const { card, request, open, connection } = await mountLoginCard();
  request
    .mockResolvedValueOnce({ done: false, status: "running" })
    .mockResolvedValueOnce(browserStep)
    .mockResolvedValue({ status: "cancelled" });
  expect([request.mock.calls, open.mock.calls]).toEqual([[], []]);
  expect(card.querySelector('[aria-label="Sign in to docs"]')).toBeNull();
  openRow(card, "docs");
  expectNamedAction(card, "Sign in to docs", "Sign in");
  actionButton(card, "Sign in").click();
  await waitForFast(() => expect(card.querySelector(".wizard-step__external-link")).not.toBeNull());
  expect(request).toHaveBeenCalledWith(
    "mcp.authLogin",
    { sessionId: loginSessionId, serverName: "docs" },
    expect.anything(),
  );
  const link = expectDefined(
    card.querySelector<HTMLAnchorElement>(".wizard-step__external-link"),
    "browser sign-in recovery link",
  );
  expect(link).toMatchObject({ href: loginUrl, target: "_blank" });
  expect(open).toHaveBeenCalledWith(loginUrl, "_blank", "noopener,noreferrer");
  connection.publish({
    ...connection.gateway.snapshot,
    lastError: "Unrelated connection notice",
  });
  flush();
  expect(card.querySelector(".wizard-step__external-link")).toBe(link);
  actionButton(card, "Cancel").click();
  await waitForFast(() => expect(card.querySelector("openclaw-modal-dialog")).toBeNull());
  expect(actionButton(card, "Sign in").disabled).toBe(false);
});
const unavailableLoginCases: [NonNullable<Parameters<typeof mountLoginCard>[0]>, string][] = [
  [{ methods: [] }, loginCommand],
  [{ admin: false }, loginCommand],
  [{ server: { ...oauthServer, enabled: false } }, loginCommand],
  [
    { server: { ...oauthServer, oauth: { identity: "per-requester" } } },
    "Each person signs in to this MCP server in Chat.",
  ],
  [
    { server: { ...oauthServer, oauth: { authProfileId: "linked-account" } } },
    "Sign in through the linked account in Models.",
  ],
];
it.each(unavailableLoginCases)(
  "withholds native login for %j and shows %s",
  async (options, alternative) => {
    const { card, request, open, harness } = await mountLoginCard(options);
    openRow(card, "docs");
    expect(card.querySelector('[aria-label="Sign in to docs"]')).toBeNull();
    expect(card.textContent).toContain(alternative);
    if (options.admin === false) {
      // Reading a server stays open to read-only operators; only changes are blocked.
      const controls = [
        ...card.querySelectorAll<HTMLButtonElement>(
          "button:not(.mcp-server-row__summary, .chat-copy-btn, .settings-section__help-button)",
        ),
      ];
      expect(controls.length).toBeGreaterThan(0);
      expect(controls.every((button) => button.disabled)).toBe(true);
      expect(
        controls.every((button) => button.title === "You need admin access to change MCP servers."),
      ).toBe(true);
      expect(enabledSwitch(card, "docs").disabled).toBe(true);
      enabledSwitch(card, "docs").click();
      expect(harness.patch).not.toHaveBeenCalled();
    }
    expect(card.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  },
);
it.each(["target replacement", "agent selection", "disconnect", "capability drop"] as const)(
  "cancels on the initiating client and hides late success after %s",
  async (change) => {
    const { card, context, connection, request } = await mountLoginCard();
    const lateNext = deferred<WizardNextResult>();
    const nextRequested = deferred();
    request
      .mockResolvedValueOnce({ done: false, status: "running" })
      .mockImplementationOnce(() => {
        nextRequested.resolve();
        return lateNext.promise;
      })
      .mockResolvedValue({ status: "cancelled" });
    const replacement = new GatewayBrowserClient({ url: "ws://gateway-b.example.test" });
    const replacementRequest = vi.spyOn(replacement, "request");
    openRow(card, "docs");
    actionButton(card, "Sign in").click();
    await nextRequested.promise;
    const snapshot = connection.gateway.snapshot;
    const hello = expectDefined(snapshot.hello, "connected Gateway hello");
    if (change === "agent selection") {
      context.agentSelection.set("another-agent");
    } else if (change === "disconnect") {
      connection.publish({ ...snapshot, phase: "reconnecting", client: null, hello: null });
    } else {
      connection.publish({
        ...snapshot,
        client: change === "target replacement" ? replacement : snapshot.client,
        hello: {
          ...hello,
          features: { methods: change === "capability drop" ? [] : ["mcp.authLogin"] },
        },
      });
    }
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "wizard.cancel",
        { sessionId: loginSessionId, closeInput: true },
        expect.any(Object),
      ),
    );
    lateNext.resolve({ done: true, status: "done" });
    await lateNext.promise;
    flush();
    expect(card.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(card.textContent).not.toContain("Signed in");
    expect(replacementRequest).not.toHaveBeenCalled();
  },
);
it.each([
  [
    "docs",
    {
      url: "https://m.test/?keep=y&token=secret",
      auth: "oauth",
      toolFilter: {},
      sslVerify: false,
    },
    ["https://m.test/?keep=y&token=***", "Tool filter · TLS verification off"],
    ["secret"],
  ],
  [
    "local",
    {
      command: "node",
      args: ["server.js", "secret"],
      enabled: false,
      supportsParallelToolCalls: true,
      clientCert: "client.pem",
    },
    ["node", "Parallel · mTLS"],
    ["server.js", "secret"],
  ],
  [
    "mixed",
    { command: "node", url: "https://m.test/?token=secret", transport: httpTransport },
    ["node"],
    ["m.test", "secret"],
  ],
  ["docs; echo unsafe", docsServer, ["openclaw mcp probe 'docs; echo unsafe'"], []],
] satisfies [string, Record<string, unknown>, string[], string[]][])(
  "renders %s without exposing credentials or unsafe shell commands",
  async (name, server, visible, hidden) => {
    const { card } = await mountCard({ servers: { [name]: server } });
    openRow(card, name);
    const row = expectDefined(card.querySelector(`[data-mcp-name="${name}"]`), name);
    for (const text of visible) {
      expect(row.textContent).toContain(text);
    }
    for (const text of hidden) {
      expect(row.textContent).not.toContain(text);
    }
  },
);
it.each([
  [httpTransport, httpSseUrl, { url: httpSseUrl, transport: httpTransport }],
  ["sse", eventsUrl, { url: eventsUrl, transport: "sse" }],
  ["stdio", 'npx mcp "/My Files"', { command: "npx", args: ["mcp", "/My Files"] }],
  ["stdio", '"\\\\host\\share\\mcp" -s', { command: "\\\\host\\share\\mcp", args: ["-s"] }],
  ["stdio", 'mcp "C:\\My Files\\\\"', { command: "mcp", args: ["C:\\My Files\\"] }],
] as const)("adds a %s server from %s", async (transport, target, expected) => {
  const { card, harness } = await mountCard();
  expect(card.querySelector(".settings-empty")?.textContent).toContain("No MCP servers yet.");
  const setupLink = card.querySelector<HTMLAnchorElement>(".settings-empty a");
  expect(setupLink).toMatchObject({
    href: "https://docs.openclaw.ai/tools/mcp",
    target: "_blank",
    rel: "noopener noreferrer",
  });
  await submitAddForm(card, "context7", target, transport);
  await waitMessage(card, "Added MCP server context7.");
  expect(harness.patch.mock.calls[0]?.[0].raw).toEqual(configWith({ context7: expected }));
  expect(harness.patch.mock.calls[0]?.[0]).not.toHaveProperty("replacePaths");
  expect(card.querySelector(".mcp-server-form")).toBeNull();
});
it.each([
  ["bad name!", httpTransport, docsServer.url, "Server names use"],
  ["new", "stdio", docsServer.url, "valid command line"],
  ["new", httpTransport, "npx mcp", "valid command line"],
  ["new", "stdio", 'npx mcp "unfinished', "valid command line"],
  ["docs", httpTransport, httpSseUrl, "An MCP server named “docs” already exists."],
] as const)("rejects %s / %s / %s before patching", async (name, transport, target, error) => {
  const { card, harness } = await mountCard({ servers: { docs: docsServer } });
  await submitAddForm(card, name, target, transport);
  await waitForFast(() => expect(message(card, "alert")).toContain(error));
  expect(harness.patch).not.toHaveBeenCalled();
});
it("retries removal confirmation and removes arrays after queued writes settle", async () => {
  const retained = { command: "node", args: ["retained.mjs"], opaque: null };
  const updated = {
    command: "node",
    args: ["updated.mjs"],
    toolFilter: { include: ["search"], exclude: ["admin_*"] },
  };
  const configs = [
    configWith({ docs: { ...localServer, args: ["initial.mjs"] }, retained }),
    configWith({ docs: updated, retained }),
    configWith({ retained }),
  ];
  let revision = 0;
  const gate = deferred();
  const patches: unknown[] = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.get") {
      return configSnapshot(expectDefined(configs[revision], "config"), `hash-${revision}`);
    }
    if (method !== "config.patch") {
      throw new Error(`Unexpected request ${method}`);
    }
    patches.push(params);
    if (revision === 0) {
      await gate.promise;
    }
    revision += 1;
    return { ok: true, config: configs[revision], hash: `hash-${revision}` };
  });
  const { runtimeConfig } = createConfigCapabilityHarness(
    request as GatewayBrowserClient["request"],
  );
  try {
    await runtimeConfig.ensureLoaded();
    const { card } = await mountCard({ runtimeConfig });
    openRow(card, "docs");
    vi.mocked(showConfirmDialog).mockRejectedValueOnce(new Error("Confirmation failed"));
    actionButton(card, "Remove docs").click();
    await waitMessage(card, "Confirmation failed", "alert");
    vi.mocked(showConfirmDialog).mockResolvedValueOnce(false);
    actionButton(card, "Remove docs").click();
    await waitForFast(() => expect(card.querySelector('[role="alert"]')).toBeNull());
    expect(patches).toEqual([]);
    expect(card.querySelector('[data-mcp-name="docs"]')).not.toBeNull();
    expect(showConfirmDialog).toHaveBeenCalledWith({
      title: "Remove docs?",
      message: expect.stringContaining("saved command"),
      confirmLabel: "Remove",
      danger: true,
    });
    const priorWrite = runtimeConfig.patch({
      raw: configWith({ docs: updated }),
      note: "update server",
      replacePaths: ["mcp.servers.docs.args"],
    });
    const confirmation = deferred<boolean>();
    vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
    actionButton(card, "Remove docs").click();
    await waitForFast(() => expect(patches).toHaveLength(1));
    confirmation.resolve(true);
    await confirmation.promise;
    gate.resolve();
    await expect(priorWrite).resolves.toBe(true);
    await waitMessage(card, "Removed MCP server docs.");
    expect(patches).toHaveLength(2);
    const removal = expectDefined(patches[1], "removal patch");
    expect(removal).toMatchObject({
      baseHash: "hash-1",
      raw: JSON.stringify({ mcp: { servers: { docs: null } } }),
      replacePaths: [
        "mcp.servers.docs.args",
        "mcp.servers.docs.toolFilter.include",
        "mcp.servers.docs.toolFilter.exclude",
      ],
    });
    expect(runtimeConfig.state.configSnapshot?.sourceConfig).toEqual(configWith({ retained }));
  } finally {
    gate.resolve();
    runtimeConfig.dispose();
  }
});
const mcpTool = (server: string, name: string, description = "") => ({
  id: `${server}__${name}`,
  label: name,
  description,
  rawDescription: description,
  source: "mcp",
  mcpServer: server,
  mcpToolName: name,
});
async function mountStatusCard(result: unknown, servers: Record<string, unknown>) {
  const client = new GatewayBrowserClient({ url: "ws://gateway-a.example.test" });
  const request = vi.spyOn(client, "request");
  if (result instanceof Error) {
    request.mockRejectedValue(result);
  } else {
    request.mockResolvedValue(result);
  }
  const mounted = await mountCard({
    client,
    methods: ["tools.effective", "mcp.authLogin"],
    servers,
  });
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("tools.effective", { sessionKey: "main" }),
  );
  await flushPromises();
  return { ...mounted, request };
}
const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  flush();
};
const rowStatus = (card: HTMLElement, name: string) =>
  card.querySelector(`[data-mcp-name="${name}"] .mcp-server-row__status`)?.textContent?.trim();
it("states each server's condition from the session's tools and shows them on demand", async () => {
  const { card } = await mountStatusCard(
    {
      agentId: "main",
      profile: "full",
      groups: [
        {
          id: "mcp",
          label: "MCP",
          source: "mcp",
          tools: [mcpTool("docs", "search_docs", "Search the docs."), mcpTool("broken", "stale")],
        },
      ],
      notices: [
        {
          id: "mcp-server-diagnostic:broken",
          severity: "warning",
          message: 'MCP server "broken": spawn ENOENT',
          servers: ["broken"],
        },
      ],
    },
    {
      broken: localServer,
      docs: docsServer,
      empty: docsServer,
      login: oauthServer,
      off: { ...docsServer, enabled: false },
    },
  );
  await waitForFast(() => expect(rowStatus(card, "docs")).toBe("Tools listed"));
  expect(rowStatus(card, "broken")).toBe("Failing");
  expect(rowStatus(card, "empty")).toBe("No tools");
  // Sign-in state is not readable here, so an OAuth server is not told it needs one.
  expect(rowStatus(card, "login")).toBe("No tools");
  expect(rowStatus(card, "off")).toBe("");
  expect(card.querySelector(".mcp-server-tools")).toBeNull();
  openRow(card, "docs");
  expect(card.querySelector(".mcp-server-tools")?.textContent).toContain("search_docs");
  expect(card.querySelector(".mcp-server-tools")?.textContent).toContain("Search the docs.");
  openRow(card, "broken");
  expect(card.querySelector('[data-mcp-name="docs"] .mcp-server-tools')).toBeNull();
  const panel = card.querySelector('[data-mcp-name="broken"] .mcp-server-row__note');
  expect(panel?.textContent).toBe("spawn ENOENT");
});
it("clears session tools on selection changes and ignores an earlier session's response", async () => {
  const result = (name: string) => ({
    agentId: "main",
    profile: "full",
    groups: [{ id: "mcp", label: "MCP", source: "mcp", tools: [mcpTool("docs", name)] }],
  });
  const { card, context, connection, request } = await mountStatusCard(result("initial"), {
    docs: docsServer,
  });
  openRow(card, "docs");
  expect(card.querySelector(".mcp-server-tools")?.textContent).toContain("initial");

  const pending = deferred<unknown>();
  request.mockReturnValueOnce(pending.promise);
  connection.publish({ ...context.gateway.snapshot, sessionKey: "second" });
  flush();
  expect(card.querySelector(".mcp-server-tools")).toBeNull();
  expect(rowStatus(card, "docs")).toBe("");
  expect(request).toHaveBeenLastCalledWith("tools.effective", { sessionKey: "second" });

  request.mockResolvedValueOnce(result("current"));
  connection.publish({ ...context.gateway.snapshot, sessionKey: "third" });
  await waitForFast(() =>
    expect(card.querySelector(".mcp-server-tools")?.textContent).toContain("current"),
  );
  pending.resolve(result("stale"));
  await flushPromises();
  expect(card.querySelector(".mcp-server-tools code")?.textContent).toBe("current");
  expect(request).toHaveBeenCalledTimes(3);
});

it("does not call an unused server failing before a session has connected it", async () => {
  const { card, request } = await mountStatusCard(
    {
      agentId: "main",
      profile: "full",
      groups: [],
      notices: [
        {
          id: "mcp-not-yet-connected",
          severity: "info",
          message: "not connected",
          servers: ["docs"],
        },
      ],
    },
    { docs: docsServer },
  );
  await waitForFast(() => expect(rowStatus(card, "docs")).toBe("Not connected yet"));
  expect(card.querySelector(".settings-status--danger")).toBeNull();
  expect(card.querySelector(".settings-section__desc")).toBeNull();
  expect(card.querySelector(".settings-section__help-button")).not.toBeNull();
  expect(card.querySelector(".settings-section__help-panel")?.textContent).toContain(
    "connections rebuild on next use",
  );
  expect(request.mock.calls.filter(([method]) => method === "tools.effective")).toHaveLength(1);
});
it("states nothing about a server saved differently since the session's tools were read", () => {
  const read = {
    result: {
      agentId: "main",
      profile: "full",
      groups: [{ id: "mcp", label: "MCP", source: "mcp", tools: [mcpTool("docs", "search_docs")] }],
    },
    servers: { docs: docsServer },
  } as unknown as McpToolsRead;
  expect(resolveReadMcpServerRuntime(read, "docs", { ...docsServer }).kind).toBe("connected");
  expect(resolveReadMcpServerRuntime(read, "docs", { url: "https://other.test" }).kind).toBe(
    "unknown",
  );
  expect(resolveReadMcpServerRuntime(read, "added", docsServer).kind).toBe("unknown");
});
it("states nothing when the session's tools cannot be read", async () => {
  const { card } = await mountStatusCard(new Error('unknown session key "main"'), {
    docs: docsServer,
  });
  expect(rowStatus(card, "docs")).toBe("");
  expect(card.querySelector('[role="alert"]')).toBeNull();
});
