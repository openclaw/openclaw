/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../api/gateway.ts";
import type { WizardNextResult } from "../api/types.ts";
import { createAgentSelectionCapability } from "../app/agent-selection.ts";
import type { ApplicationContext, ApplicationGateway } from "../app/context.ts";
import { i18n } from "../i18n/index.ts";
import type { ConfigPatchOptions } from "../lib/config/config-gateway-operations.ts";
import { createConfigCapabilityHarness } from "../lib/config/config-test-harness.ts";
import { buildRemoveMcpServerPatch, patchMcpServers } from "../lib/config/mcp-servers.ts";
import type { RuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import * as uuid from "../lib/uuid.ts";
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
type RuntimeConfigHarness = ReturnType<typeof createRuntimeConfig>;
function createGateway(
  options: {
    connected?: boolean;
    admin?: boolean;
    client?: GatewayBrowserClient;
    methods?: string[];
  } = {},
): ApplicationGateway {
  const connected = options.connected ?? true;
  const admin = options.admin ?? true;
  const snapshot = {
    client: options.client ?? null,
    phase: connected ? "connected" : "reconnecting",
    hello: {
      type: "hello-ok" as const,
      protocol: 1,
      features: { methods: options.methods ?? [] },
      auth: {
        role: "operator",
        scopes: admin ? ["operator.read", "operator.admin"] : ["operator.read"],
      },
    },
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  return {
    snapshot,
    connection: { gatewayUrl: "ws://localhost", token: "", password: "", bootstrapToken: "" },
    eventLog: [],
    connect: () => undefined,
    setSessionKey: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    subscribe: () => () => undefined,
    subscribeEventLog: () => () => undefined,
    subscribeEvents: () => () => undefined,
  } as unknown as ApplicationGateway;
}
function createRuntimeConfig(config: Record<string, unknown>) {
  const ensureLoaded = vi.fn<() => Promise<void>>(async () => undefined);
  const patch = vi.fn<(options: ConfigPatchOptions) => Promise<boolean>>(async () => true);
  const listeners = new Set<() => void>();
  const state = {
    configSnapshot: { sourceConfig: config, hash: "base" },
    lastError: null as string | null,
  };
  const patchFromSnapshot = vi.fn(async (build: ConfigPatchBuilder) => {
    const built = build(config);
    if ("error" in built) {
      state.lastError = built.error;
      return false;
    }
    return patch(built.options);
  });
  const runtimeConfig = {
    state,
    ensureLoaded,
    patch,
    patchFromSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ApplicationContext["runtimeConfig"];
  return { runtimeConfig, ensureLoaded, patch };
}
async function mountCard(
  options: {
    config?: Record<string, unknown>;
    connected?: boolean;
    admin?: boolean;
    gateway?: ApplicationGateway;
    initialLoad?: Promise<void>;
  } = {},
) {
  const harness = createRuntimeConfig(options.config ?? { mcp: { servers: {} } });
  if (options.initialLoad) {
    harness.ensureLoaded.mockReturnValueOnce(options.initialLoad);
  }
  const gateway =
    options.gateway ?? createGateway({ connected: options.connected, admin: options.admin });
  const context = {
    gateway,
    agentSelection: createAgentSelectionCapability(gateway, {
      state: { agentsList: null },
      subscribe: () => () => undefined,
    }),
    runtimeConfig: harness.runtimeConfig,
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
  await waitForFast(() => expect(harness.ensureLoaded).toHaveBeenCalled());
  const card = expectDefined(
    container.querySelector<HTMLElement>("openclaw-mcp-servers-card"),
    "MCP servers card",
  );
  return { card, context, harness };
}
function expectRow(card: HTMLElement, name: string, includes: string[], excludes: string[] = []) {
  const row = expectDefined(card.querySelector(`[data-mcp-name="${name}"]`), `${name} row`);
  for (const text of includes) {
    expect(row.textContent).toContain(text);
  }
  for (const text of excludes) {
    expect(row.textContent).not.toContain(text);
  }
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
  actionButton(card, "Add server").click();
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
function configWith(servers: Record<string, unknown>) {
  return { mcp: { servers } };
}
function firstPatchCall(harness: RuntimeConfigHarness) {
  return expectDefined(harness.patch.mock.calls[0]?.[0], "config patch payload");
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
  const connection = createApplicationGateway(
    createGateway({
      client,
      admin: options.admin,
      methods: options.methods ?? ["mcp.authLogin"],
    }).snapshot,
  );
  const mounted = await mountCard({
    gateway: connection.gateway,
    config: configWith({ docs: options.server ?? oauthServer }),
  });
  return { ...mounted, connection, client, request, open };
}
describe("openclaw-mcp-servers-card", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(true);
  });
  afterEach(() => {
    cleanupSolid();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });
  it("keeps form toggles ordered before the next render", async () => {
    const { card } = await mountCard();
    const add = actionButton(card, "Add server");
    add.click();
    add.click();
    flush();
    expect(card.querySelector(".mcp-server-form")).toBeNull();
    add.click();
    flush();
    expect(card.querySelector(".mcp-server-form")).not.toBeNull();
  });
  it("admits one mutation before rendering busy and releases it after completion", async () => {
    const { card, harness } = await mountCard({
      config: configWith({
        local: { command: "node" },
        other: { command: "node", enabled: false },
      }),
    });
    const completion = deferred<boolean>();
    harness.patch.mockReturnValueOnce(completion.promise);
    const disable = actionButton(card, "Disable");
    disable.click();
    actionButton(card, "Remove local").click();
    await waitForFast(() => expect(harness.patch).toHaveBeenCalledOnce());
    expect(disable.disabled).toBe(true);
    expect(disable.textContent?.trim()).toBe("Working…");
    expect(actionButton(card, "Add server").disabled).toBe(true);
    expect(disable.getAttribute("aria-label")).toBe("Working… local");
    const other = actionButton(card, "Working… other");
    expect(other.disabled).toBe(true);
    expect(other.textContent?.trim()).toBe("Working…");
    completion.resolve(true);
    await waitForFast(() => {
      expect(disable.disabled).toBe(false);
      expect(card.querySelector('[role="status"]')?.textContent).toBe("Disabled MCP server local.");
    });
    expect(disable.textContent?.trim()).toBe("Disable");
    expect(disable.getAttribute("aria-label")).toBe("Disable local");
    disable.click();
    await waitForFast(() => expect(harness.patch).toHaveBeenCalledTimes(2));
  });
  it("names each row action after its server and keeps the visible label", async () => {
    const client = new GatewayBrowserClient({ url: "ws://gateway-a.example.test" });
    const { card } = await mountCard({
      gateway: createApplicationGateway(
        createGateway({ client, methods: ["mcp.authLogin"] }).snapshot,
      ).gateway,
      config: configWith({ docs: oauthServer, search: { ...oauthServer, enabled: false } }),
    });
    const named = (name: string) =>
      [...card.querySelectorAll("button")]
        .filter((button) => button.getAttribute("aria-label") === name)
        .map((button) => button.textContent?.trim());
    expect(named("Sign in docs")).toEqual(["Sign in"]);
    expect(named("Disable docs")).toEqual(["Disable"]);
    expect(named("Enable search")).toEqual(["Enable"]);
  });
  it("starts the selected connector and keeps a usable link when the popup is blocked", async () => {
    const { card, request, open, connection } = await mountLoginCard();
    request
      .mockResolvedValueOnce({ done: false, status: "running" })
      .mockResolvedValueOnce(browserStep)
      .mockResolvedValue({ status: "cancelled" });
    expect(request).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    actionButton(card, "Sign in").click();
    await waitForFast(() =>
      expect(card.querySelector(".wizard-step__external-link")).not.toBeNull(),
    );
    expect(request).toHaveBeenNthCalledWith(
      1,
      "mcp.authLogin",
      { sessionId: loginSessionId, serverName: "docs" },
      { timeoutMs: null },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "wizard.next",
      { sessionId: loginSessionId },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const link = expectDefined(
      card.querySelector<HTMLAnchorElement>(".wizard-step__external-link"),
      "browser sign-in recovery link",
    );
    expect(link).toMatchObject({ href: loginUrl, target: "_blank" });
    expect(link.textContent).toContain("Reopen browser tab");
    expect(open).toHaveBeenCalledWith(loginUrl, "_blank", "noopener,noreferrer");
    connection.publish({
      ...connection.gateway.snapshot,
      lastError: "Unrelated connection notice",
    });
    flush();
    expect(card.querySelector(".wizard-step__external-link")).toBe(link);
    expect(request.mock.calls.some(([method]) => method === "wizard.cancel")).toBe(false);
    actionButton(card, "Cancel").click();
    await waitForFast(() => expect(card.querySelector("openclaw-modal-dialog")).toBeNull());
    expect(request).toHaveBeenCalledWith(
      "wizard.cancel",
      { sessionId: loginSessionId },
      expect.any(Object),
    );
    expect(request).toHaveBeenCalledWith(
      "wizard.status",
      { sessionId: loginSessionId },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(actionButton(card, "Sign in").disabled).toBe(false);
  });
  it.each([
    { name: "missing method", methods: [], text: "openclaw mcp login docs" },
    { name: "non-admin", admin: false, text: "openclaw mcp login docs" },
    {
      name: "disabled",
      server: { ...oauthServer, enabled: false },
      text: "openclaw mcp login docs",
    },
    {
      name: "requester-owned",
      server: { ...oauthServer, oauth: { identity: "per-requester" } },
      text: "Each person signs in through this MCP server in chat.",
    },
    {
      name: "mapped profile",
      server: { ...oauthServer, oauth: { authProfileId: "linked-account" } },
      text: "Sign in through the linked account in Models.",
    },
  ])("does not offer native login for $name and shows the correct alternative", async (options) => {
    const { card, request, open, harness } = await mountLoginCard(options);
    expect(
      [...card.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Sign in",
      ),
    ).toBe(false);
    expect(card.textContent).toContain(options.text);
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
  });
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
      expect(request.mock.calls.filter(([method]) => method === "mcp.authLogin")).toHaveLength(1);
      if (change === "disconnect") {
        connection.publish({
          ...snapshot,
          client: replacement,
          hello: { ...hello, features: { methods: [] } },
        });
        flush();
      }
      if (change === "disconnect" || change === "capability drop") {
        expect(card.textContent).toContain("openclaw mcp login docs");
        expect(
          [...card.querySelectorAll("button")].some(
            (button) => button.textContent?.trim() === "Sign in",
          ),
        ).toBe(false);
        expect(replacementRequest).not.toHaveBeenCalled();
      }
    },
  );
  it("renders rich rows without exposing URL credentials or stdio arguments", async () => {
    const { card } = await mountCard({
      config: {
        mcp: {
          servers: {
            docs: {
              url: "https://mcp.example.com/mcp?keep=visible&token=test-token",
              auth: "oauth",
              toolFilter: { include: ["search"] },
              sslVerify: false,
            },
            local: {
              command: "node",
              args: ["server.js", "--token", "test-token"],
              enabled: false,
              supportsParallelToolCalls: true,
              clientCert: "/tmp/client.pem",
            },
            mixed: {
              command: "node",
              url: "https://mcp.example.com/mcp?token=test-token",
              transport: "streamable-http",
            },
            // Config files can carry names the add form would reject; the
            // command snippet must stay shell-safe for copy/paste.
            "docs; echo unsafe": { url: "https://mcp.example.com/mcp" },
          },
        },
      },
    });
    expectRow(
      card,
      "docs",
      [
        "https://mcp.example.com/mcp?keep=visible&token=***",
        "sse · oauth · tool filter · TLS verify off",
        "openclaw mcp login docs",
      ],
      ["test-token"],
    );
    expectRow(
      card,
      "local",
      ["node", "stdio · parallel · mTLS", "openclaw mcp probe local"],
      ["server.js", "test-token"],
    );
    expectRow(card, "mixed", ["node", "stdio"], ["mcp.example.com", "test-token"]);
    expectRow(card, "docs; echo unsafe", ["openclaw mcp probe 'docs; echo unsafe'"]);
  });
  it.each([
    [
      "streamable HTTP URL whose path ends in /sse",
      "streamable-http",
      "https://mcp.context7.com/sse",
      { url: "https://mcp.context7.com/sse", transport: "streamable-http" },
    ],
    [
      "SSE URL with an arbitrary endpoint path",
      "sse",
      "https://mcp.example.com/events?token=test",
      { url: "https://mcp.example.com/events?token=test", transport: "sse" },
    ],
    [
      "stdio command with a quoted argument",
      "stdio",
      'npx some-mcp-server "/Users/alice/My Files"',
      { command: "npx", args: ["some-mcp-server", "/Users/alice/My Files"] },
    ],
    [
      "stdio command with a UNC path",
      "stdio",
      '"\\\\server\\share\\mcp.exe" --stdio',
      { command: "\\\\server\\share\\mcp.exe", args: ["--stdio"] },
    ],
    [
      "stdio command with a quoted Windows directory ending in a backslash",
      "stdio",
      'server.exe "C:\\Program Files\\\\"',
      { command: "server.exe", args: ["C:\\Program Files\\"] },
    ],
  ] as const)("adds a server from a %s", async (_label, transport, target, expected) => {
    const { card, harness } = await mountCard();
    const sectionLink = card.querySelector<HTMLAnchorElement>(".settings-section__desc a");
    expect(sectionLink?.textContent?.trim()).toBe("Learn more");
    expect(sectionLink?.classList.contains("learn-more-link")).toBe(true);
    expect(sectionLink?.getAttribute("href")).toBe("/settings/plugins");
    expect(card.querySelector(".settings-empty")?.textContent).toContain(
      "No MCP servers configured.",
    );
    const setupLink = card.querySelector<HTMLAnchorElement>(".settings-empty a");
    expect(setupLink?.textContent?.trim()).toBe("Set up your first MCP server");
    expect(setupLink).toMatchObject({
      href: "https://docs.openclaw.ai/tools/mcp",
      target: "_blank",
      rel: "noopener noreferrer",
    });
    await submitAddForm(card, "context7", target, transport);
    await waitForFast(() => expect(harness.patch).toHaveBeenCalledOnce());
    expect(firstPatchCall(harness)).toEqual({
      raw: { mcp: { servers: { context7: expected } } },
      note: "mcp settings: add server context7",
    });
    await waitForFast(() =>
      expect(card.querySelector('[role="status"]')?.textContent).toContain(
        "Added MCP server context7.",
      ),
    );
    expect(card.querySelector(".mcp-server-form")).toBeNull();
  });
  it.each([
    [
      "invalid name",
      "bad name!",
      "streamable-http",
      "https://mcp.example.com/mcp",
      "Server names use",
    ],
    ["stdio URL", "new", "stdio", "https://mcp.example.com/mcp", "valid command line"],
    ["HTTP command", "new", "streamable-http", "npx some-mcp-server", "valid command line"],
    [
      "unterminated stdio quote",
      "new",
      "stdio",
      'npx some-mcp-server "unfinished',
      "valid command line",
    ],
    ["HTTP URL without a host", "new", "streamable-http", "http://", "valid command line"],
    [
      "duplicate name",
      "docs",
      "streamable-http",
      "https://other.example.com/mcp",
      "An MCP server named “docs” already exists.",
    ],
  ] as const)("rejects %s before patching", async (_label, name, transport, target, error) => {
    const { card, harness } = await mountCard({
      config: configWith({ docs: { url: "https://mcp.example.com/mcp" } }),
    });
    await submitAddForm(card, name, target, transport);
    await waitForFast(() =>
      expect(card.querySelector('[role="alert"]')?.textContent).toContain(error),
    );
    expect(harness.patch).not.toHaveBeenCalled();
  });
  it.each([
    [{ command: "node", enabled: false }, "Enable", { enabled: null }],
    [{ command: "node" }, "Disable", { enabled: false }],
  ] as const)("writes the exact merge patch for %s / %s", async (current, action, expected) => {
    const note = `mcp settings: ${action.toLowerCase()} server local`;
    const { card, harness } = await mountCard({
      config: configWith({ local: current }),
    });
    actionButton(card, action).click();
    await waitForFast(() => expect(harness.patch).toHaveBeenCalledOnce());
    expect(firstPatchCall(harness)).toEqual({
      raw: { mcp: { servers: { local: expected } } },
      note,
    });
  });
  it.each([
    { name: "HTTP", server: { url: "https://mcp.example.test/mcp" }, replacePaths: [] },
    {
      name: "stdio with nested filters",
      server: {
        command: "node",
        args: ["synthetic-server.mjs"],
        toolFilter: { include: ["search"], exclude: ["admin_*"] },
      },
      replacePaths: [
        "mcp.servers.docs.args",
        "mcp.servers.docs.toolFilter.include",
        "mcp.servers.docs.toolFilter.exclude",
      ],
    },
  ])("removes a $name server with exact array intent", async ({ server, replacePaths }) => {
    const retained = { command: "node", args: ["retained.mjs"] };
    const { card, harness } = await mountCard({
      config: configWith({ docs: server, retained }),
    });
    actionButton(card, "Remove docs").click();
    await waitForFast(() => expect(harness.patch).toHaveBeenCalledOnce());
    expect(showConfirmDialog).toHaveBeenCalledOnce();
    expect(firstPatchCall(harness)).toEqual({
      raw: { mcp: { servers: { docs: null } } },
      note: "mcp settings: remove server docs",
      ...(replacePaths.length ? { replacePaths } : {}),
    });
  });
  it("keeps the server and sends no patch when removal is cancelled", async () => {
    const { card, harness } = await mountCard({
      config: configWith({ docs: { command: "node", args: ["synthetic-server.mjs"] } }),
    });
    vi.mocked(showConfirmDialog).mockResolvedValueOnce(false);

    actionButton(card, "Remove docs").click();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(harness.patch).not.toHaveBeenCalled();
    expectRow(card, "docs", ["docs"]);
    expect(showConfirmDialog).toHaveBeenCalledWith({
      title: "Remove docs?",
      message: expect.stringContaining("saved configuration"),
      confirmLabel: "Remove",
      danger: true,
    });
  });
  it("shows failed removal confirmation and clears it while retrying", async () => {
    const { card, harness } = await mountCard({
      config: configWith({ docs: { command: "node", args: ["synthetic-server.mjs"] } }),
    });
    vi.mocked(showConfirmDialog).mockRejectedValueOnce(
      new Error("Unable to open removal confirmation."),
    );
    actionButton(card, "Remove docs").click();
    await waitForFast(() =>
      expect(card.querySelector('[role="alert"]')?.textContent).toBe(
        "Unable to open removal confirmation.",
      ),
    );
    expect(harness.patch).not.toHaveBeenCalled();
    expectRow(card, "docs", ["docs"]);

    const confirmation = deferred<boolean>();
    vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
    actionButton(card, "Remove docs").click();
    await waitForFast(() => expect(card.querySelector('[role="alert"]')).toBeNull());
    expect(harness.patch).not.toHaveBeenCalled();
    confirmation.resolve(true);
    await waitForFast(() => {
      expect(harness.patch).toHaveBeenCalledOnce();
      expect(card.querySelector('[role="status"]')?.textContent).toBe("Removed MCP server docs.");
    });
  });
  it.each(["load", "patch rejection", "patch refusal"] as const)(
    "shows a %s mutation failure and releases the controls for retry",
    async (stage) => {
      const { card, harness } = await mountCard({
        config: configWith({ local: { command: "node" } }),
      });
      const failure = new Error("synthetic mutation failure");
      if (stage === "load") {
        harness.ensureLoaded.mockRejectedValueOnce(failure);
      } else if (stage === "patch rejection") {
        harness.patch.mockRejectedValueOnce(failure);
      } else {
        harness.runtimeConfig.state.lastError = failure.message;
        harness.patch.mockResolvedValueOnce(false);
      }

      actionButton(card, "Disable").click();

      await waitForFast(() =>
        expect(card.querySelector('[role="alert"]')?.textContent).toBe(failure.message),
      );
      expect(actionButton(card, "Disable").disabled).toBe(false);

      const retry = deferred<boolean>();
      harness.patch.mockReturnValueOnce(retry.promise);
      actionButton(card, "Disable").click();
      await waitForFast(() => {
        expect(card.querySelector('[role="alert"]')).toBeNull();
        expect(actionButton(card, "Working").disabled).toBe(true);
      });
      retry.resolve(true);
      await waitForFast(() =>
        expect(card.querySelector('[role="status"]')?.textContent).toBe(
          "Disabled MCP server local.",
        ),
      );
    },
  );

  it("shows an initial configuration failure without replacing the controls", async () => {
    const initialLoad = deferred();
    const { card } = await mountCard({
      config: configWith({ local: { command: "node" } }),
      initialLoad: initialLoad.promise,
    });
    initialLoad.reject(new Error("Configuration could not be loaded"));
    await waitForFast(() =>
      expect(card.querySelector('[role="alert"]')?.textContent).toBe(
        "Configuration could not be loaded",
      ),
    );
    expect(actionButton(card, "Disable").disabled).toBe(false);
  });

  it("keeps a successful mutation visible when an older initial read fails", async () => {
    const initialLoad = deferred();
    const { card, harness } = await mountCard({
      config: configWith({ local: { command: "node" } }),
      initialLoad: initialLoad.promise,
    });
    actionButton(card, "Disable").click();
    await waitForFast(() =>
      expect(card.querySelector('[role="status"]')?.textContent).toBe("Disabled MCP server local."),
    );
    initialLoad.reject(new Error("Earlier configuration read failed"));
    await initialLoad.promise.catch(() => {});
    await waitForFast(() => {
      expect(card.querySelector('[role="alert"]')).toBeNull();
      expect(card.querySelector('[role="status"]')?.textContent).toBe("Disabled MCP server local.");
      expect(harness.patch).toHaveBeenCalledOnce();
    });
  });

  it("builds removal intent from the snapshot after queued writes settle", async () => {
    const retained = { command: "node", args: ["retained.mjs"], opaque: null };
    let config: Record<string, unknown> = {
      mcp: { servers: { docs: { command: "node", args: ["initial.mjs"] }, retained } },
    };
    let hash = "before";
    const gate = deferred();
    const patches: unknown[] = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        return {
          config,
          sourceConfig: config,
          raw: JSON.stringify(config),
          hash,
          valid: true,
          issues: [],
        };
      }
      if (method !== "config.patch") {
        throw new Error(`Unexpected request ${method}`);
      }
      patches.push(params);
      if (patches.length === 1) {
        await gate.promise;
        config = {
          mcp: {
            servers: {
              docs: { command: "node", args: ["updated.mjs"], toolFilter: { include: ["search"] } },
              retained,
            },
          },
        };
        hash = "queued-write";
      } else {
        config = { mcp: { servers: { retained } } };
        hash = "removed";
      }
      return { ok: true, config, hash };
    });
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    try {
      await runtimeConfig.ensureLoaded();
      const priorWrite = runtimeConfig.patch({
        raw: {
          mcp: {
            servers: { docs: { args: ["updated.mjs"], toolFilter: { include: ["search"] } } },
          },
        },
        note: "update server",
        replacePaths: ["mcp.servers.docs.args"],
      });
      const removal = patchMcpServers(runtimeConfig, {
        buildPatch: (servers) => buildRemoveMcpServerPatch(servers, "docs"),
        note: "remove server",
      });
      await waitForFast(() => expect(patches).toHaveLength(1));
      gate.resolve();
      await expect(priorWrite).resolves.toBe(true);
      await expect(removal).resolves.toBeUndefined();
      expect(patches).toHaveLength(2);
      expect(patches[1]).toMatchObject({
        baseHash: "queued-write",
        raw: JSON.stringify({ mcp: { servers: { docs: null } } }),
        replacePaths: ["mcp.servers.docs.args", "mcp.servers.docs.toolFilter.include"],
      });
      expect(runtimeConfig.state.configSnapshot?.sourceConfig).toEqual({
        mcp: { servers: { retained } },
      });
    } finally {
      gate.resolve();
      runtimeConfig.dispose();
    }
  });
});
