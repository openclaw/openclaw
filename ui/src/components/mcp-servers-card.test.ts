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
        pluginsHref: "/settings/plugins",
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
async function submitAddForm(
  card: HTMLElement,
  name: string,
  target: string,
  transport: "streamable-http" | "sse" | "stdio" = "streamable-http",
) {
  const add = actionButton(card, "Add server");
  add.click();
  add.click();
  flush();
  expect(card.querySelector(".mcp-server-form")).toBeNull();
  add.click();
  flush();
  const form = expectDefined(card.querySelector<HTMLFormElement>(".mcp-server-form"), "MCP form");
  const field = (fieldName: string) =>
    expectDefined(
      form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="mcp-${fieldName}"]`),
      `${fieldName} field`,
    );
  field("name").value = name;
  field("transport").value = transport;
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
      actionButton(card, "Disable").click();
    }
    await waitMessage(card, failure.message, "alert");
    expect(actionButton(card, "Disable").disabled).toBe(false);
    harness.patch.mockClear();
    const completion = deferred<boolean>();
    harness.patch.mockReturnValueOnce(completion.promise);
    expectNamedAction(card, "Disable local", "Disable");
    expectNamedAction(card, "Enable other", "Enable");
    const disable = actionButton(card, "Disable");
    disable.click();
    actionButton(card, "Remove local").click();
    await waitForFast(() => expect(harness.patch).toHaveBeenCalledOnce());
    expect(harness.patch.mock.calls[0]?.[0].raw).toEqual(configWith({ local: { enabled: false } }));
    expect(card.querySelector('[role="alert"]')).toBeNull();
    expect(disable.disabled).toBe(true);
    expect(disable.textContent?.trim()).toBe("Working…");
    expect(actionButton(card, "Add server").disabled).toBe(true);
    expect(disable.getAttribute("aria-label")).toBe("Working… local");
    const other = actionButton(card, "Working… other");
    expect(other.disabled).toBe(true);
    completion.resolve(true);
    await waitForFast(() => {
      expect(disable.disabled).toBe(false);
      expect(message(card)).toBe("Disabled MCP server local.");
    });
    expect(disable.textContent?.trim()).toBe("Disable");
    expect(disable.getAttribute("aria-label")).toBe("Disable local");
    if (stage !== "initial") {
      initialLoad.reject(new Error("Earlier read failed"));
      await initialLoad.promise.catch(() => {});
      await waitForFast(() => {
        expect(card.querySelector('[role="alert"]')).toBeNull();
        expect(message(card)).toBe("Disabled MCP server local.");
      });
    }
    actionButton(card, "Enable other").click();
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
  expectNamedAction(card, "Sign in docs", "Sign in");
  expectNamedAction(card, "Disable docs", "Disable");
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
    "Each person signs in through this MCP server in chat.",
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
    expect(card.querySelector('[aria-label="Sign in docs"]')).toBeNull();
    expect(card.textContent).toContain(alternative);
    if (options.admin === false) {
      const controls = [...card.querySelectorAll<HTMLButtonElement>("button")];
      expect(controls.length).toBeGreaterThan(0);
      expect(controls.every((button) => button.disabled)).toBe(true);
      expect(controls.every((button) => button.title.includes("operator.admin"))).toBe(true);
      actionButton(card, "Disable").click();
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
    expect(card.textContent).not.toContain("Authentication saved");
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
    ["https://m.test/?keep=y&token=***", "sse · oauth · tool filter · TLS verify off"],
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
    ["node", "stdio · parallel · mTLS"],
    ["server.js", "secret"],
  ],
  [
    "mixed",
    { command: "node", url: "https://m.test/?token=secret", transport: httpTransport },
    ["node", "stdio"],
    ["m.test", "secret"],
  ],
  ["docs; echo unsafe", docsServer, ["openclaw mcp probe 'docs; echo unsafe'"], []],
] satisfies [string, Record<string, unknown>, string[], string[]][])(
  "renders %s without exposing credentials or unsafe shell commands",
  async (name, server, visible, hidden) => {
    const { card } = await mountCard({ servers: { [name]: server } });
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
  expect(card.querySelector(".settings-empty")?.textContent).toContain(
    "No MCP servers configured.",
  );
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
      message: expect.stringContaining("saved configuration"),
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
