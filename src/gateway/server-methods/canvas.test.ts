import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { decodeSandboxHostCsp } from "../../agents/sandbox-host.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createCoreGatewayMethodDescriptors } from "../methods/core-method-policy.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { canvasHandlers } from "./canvas.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const readDocument = vi.hoisted(() => vi.fn());
vi.mock("../../canvas/documents.js", () => ({ readCanvasDocumentHtmlSource: readDocument }));

function createHarness(method = "canvas.document.view", provisioning = false) {
  const sandbox = createDeferred<number>();
  const controller = new AbortController();
  const guard = new AbortController();
  const client = { connId: "viewer" } as GatewayClient;
  const methodRegistry = createGatewayMethodRegistry([]);
  const context = {
    getRuntimeConfig: () => ({}),
    getMcpAppSandboxPort: () => (provisioning ? undefined : 18790),
    ensureSandboxHostPort: vi.fn(() => (provisioning ? sandbox.promise : Promise.resolve(18790))),
    isConnectionActive: () => true,
    getGatewayMethodRegistry: () => methodRegistry,
  } as unknown as GatewayRequestContext;
  const authority: { context: GatewayRequestContext | undefined } = { context };
  context.resolveGatewayContext = () => authority.context;
  const invoke = async (
    params: Record<string, unknown> = method.endsWith("preview")
      ? { html: "<p>Preview</p>" }
      : { docId: "cv_widget" },
  ) => {
    const respond = vi.fn();
    await canvasHandlers[method]!({
      req: { type: "req", id: "canvas", method, params },
      params,
      client,
      context,
      isWebchatConnect: () => true,
      respond,
      signal: controller.signal,
      sessionMutationCommitGuard: () => guard.signal.throwIfAborted(),
    });
    expect(respond).toHaveBeenCalledOnce();
    if (method.endsWith("preview")) {
      expect(readDocument).not.toHaveBeenCalled();
    }
    return respond.mock.calls[0]!;
  };
  return { client, context, invoke, sandbox, authority, controller, guard };
}

const retirements = {
  gateway: ({ authority }) => (authority.context = undefined),
  resolver: ({ context }) => (context.resolveGatewayContext = () => context),
  client: ({ client }) => (client.invalidated = true),
  connection: ({ context }) => (context.isConnectionActive = () => false),
  "method-registry": ({ context }) => {
    const replacement = createGatewayMethodRegistry([]);
    context.getGatewayMethodRegistry = () => replacement;
  },
  signal: ({ controller }) => controller.abort(),
  configuration: ({ context }) => (context.getRuntimeConfig = hostingDisabled),
  admission: () => markGatewayRestartDraining(),
  "commit-guard": ({ guard }) => guard.abort(),
} satisfies Record<string, (harness: ReturnType<typeof createHarness>) => unknown>;

function expectFailure(reply: unknown[], code = "UNAVAILABLE") {
  expect(reply).toEqual([false, undefined, expect.objectContaining({ code })]);
}

const hostingDisabled = () => ({
  plugins: { entries: { canvas: { config: { host: { enabled: false } } } } },
});

beforeEach(() => {
  resetGatewayWorkAdmission();
  readDocument.mockReset().mockResolvedValue({ html: "<p>Widget</p>", cspSandbox: "scripts" });
});
afterEach(() => resetGatewayWorkAdmission());

it.each(["view", "preview"])(
  "canvas.document.%s returns unchanged HTML and isolated sandbox metadata",
  async (method) => {
    const { context, invoke } = createHarness(`canvas.document.${method}`);
    const origin = `https://sandbox.example${method === "preview" ? "/preview" : ""}`;
    context.getRuntimeConfig = () => ({
      mcp: { apps: { sandboxOrigin: origin } },
    });
    const html =
      method === "view"
        ? "<p>Widget</p>"
        : "\uFEFF<!doctype html>\r\n<p>café 漢字 🦀</p><script>window.example = true;</script>\n";
    const reply = await invoke(method === "view" ? { docId: "cv_widget" } : { html });
    expect(reply).toEqual([
      true,
      {
        html,
        sandboxUrl: expect.stringMatching(/^\/mcp-app-sandbox\?csp=/),
        sandboxPort: 18790,
        sandboxOrigin: "https://sandbox.example",
      },
    ]);
    const url = new URL(reply[1].sandboxUrl, origin);
    const policy = decodeSandboxHostCsp(url.searchParams.get("csp"));
    expect(policy).toEqual(
      method === "preview"
        ? { blockDescendantFrames: true }
        : expect.objectContaining({
            blockDescendantFrames: true,
            resourceDomains: expect.arrayContaining([
              "https://cdn.jsdelivr.net",
              "https://fonts.googleapis.com",
              "https://fonts.gstatic.com",
            ]),
          }),
    );
    expect(policy?.connectDomains).toBeUndefined();
    expect(context.ensureSandboxHostPort).not.toHaveBeenCalled();
  },
);

it("starts sandbox provisioning while the document read is pending", async () => {
  const { context, invoke, sandbox } = createHarness("canvas.document.view", true);
  const document = createDeferred<{ html: string; cspSandbox: "scripts" }>();
  readDocument.mockReturnValue(document.promise);
  const pending = invoke();
  expect(readDocument).toHaveBeenCalledWith("cv_widget", { maxBytes: 10 * 1024 * 1024 });
  expect(context.ensureSandboxHostPort).toHaveBeenCalledOnce();
  sandbox.resolve(18790);
  document.resolve({ html: "<p>Widget</p>", cspSandbox: "scripts" });
  expect((await pending)[0]).toBe(true);
});

it("honors Canvas hosting disablement before reading content", async () => {
  const { context, invoke } = createHarness();
  context.getRuntimeConfig = hostingDisabled;
  expectFailure(await invoke());
  expect(readDocument).not.toHaveBeenCalled();
});

it("refuses non-widget documents and oversized widget bytes", async () => {
  const { invoke } = createHarness();
  const html = "é".repeat(5 * 1024 * 1024);
  readDocument.mockResolvedValueOnce({ html, cspSandbox: "scripts" });
  expect((await invoke())[1]?.html).toBe(html);
  for (const document of [
    { html: "<p>Non-widget artifact</p>" },
    { html: html + "é", cspSandbox: "scripts" },
  ]) {
    readDocument.mockResolvedValueOnce(document);
    expect((await invoke())[0]).toBe(false);
  }
});

it("registers as an advertised read-only Canvas method", () => {
  const descriptor = createCoreGatewayMethodDescriptors(canvasHandlers).find(
    (entry) => entry.name === "canvas.document.preview",
  );
  expect(descriptor).toMatchObject({ name: "canvas.document.preview", scope: "operator.read" });
  expect(descriptor?.controlPlaneWrite).not.toBe(true);
  expect(descriptor?.advertise).not.toBe(false);
  expect(descriptor?.handler).toBe(canvasHandlers["canvas.document.preview"]);
});

it.each([
  "",
  "a".repeat(2 * 1024 * 1024 - 1),
  "a".repeat(2 * 1024 * 1024),
  "🦀".repeat(512 * 1024),
])("accepts empty HTML and the exact ASCII/multibyte UTF-8 limit (case %#)", async (html) => {
  const { invoke } = createHarness("canvas.document.preview");
  expect(await invoke({ html })).toEqual([
    true,
    { html, sandboxPort: 18790, sandboxUrl: expect.any(String) },
  ]);
});

it.each(["a".repeat(2 * 1024 * 1024 + 1), "🦀".repeat(512 * 1024) + "a"])(
  "rejects oversized ASCII/multibyte bytes before provisioning (case %#)",
  async (html) => {
    const { context, invoke } = createHarness("canvas.document.preview", true);
    expectFailure(await invoke({ html }), "INVALID_REQUEST");
    expect(context.ensureSandboxHostPort).not.toHaveBeenCalled();
  },
);

it.each(Object.entries(retirements))(
  "rejects a retired %s before and after provisioning",
  async (boundary, retire) => {
    // Resolver and registry replacement only retires already-captured requests.
    const phases =
      boundary === "resolver" || boundary === "method-registry" ? ["after"] : ["before", "after"];
    for (const when of phases) {
      const harness = createHarness("canvas.document.preview", true);
      const { context, invoke, sandbox } = harness;
      if (when === "before") {
        retire(harness);
      }
      const pending = invoke();
      expect(context.ensureSandboxHostPort).toHaveBeenCalledTimes(when === "after" ? 1 : 0);
      if (when === "after") {
        retire(harness);
      }
      sandbox.resolve(18790);
      expectFailure(await pending);
      resetGatewayWorkAdmission();
    }
  },
);

it.each(["view", "preview"])(
  "canvas.document.%s redacts failures and rejects missing listeners",
  async (method) => {
    const { context, invoke } = createHarness(`canvas.document.${method}`, true);
    const failure = new Error("ENOENT: /private/state/canvas/secret");
    if (method === "view") {
      readDocument.mockRejectedValueOnce(failure);
    } else {
      vi.mocked(context.ensureSandboxHostPort!).mockRejectedValue(failure);
    }
    const reply = await invoke();
    expectFailure(reply);
    expect(JSON.stringify(reply)).not.toContain("/private/");
    context.ensureSandboxHostPort = undefined;
    expectFailure(await invoke(method === "preview" ? { html: "" } : undefined));
  },
);

const invalidParams: Record<string, Record<string, unknown>[]> = {
  view: [{}, { docId: "../private" }, { docId: "." }, { docId: "cv_widget", html: "injected" }],
  preview: [
    {},
    { html: 1 },
    { html: null },
    { html: [] },
    { docId: "cv_widget" },
    { html: "<p>Preview</p>", docId: "cv_widget" },
    { html: "<p>Preview</p>", path: "/private/document.html" },
    { html: "<p>Preview</p>", csp: { connectDomains: ["https://example.com"] } },
  ],
};
describe.each(Object.entries(invalidParams))("canvas.document.%s", (method, cases) => {
  it.each(cases)(
    "rejects invalid identifiers and caller-selected source or policy: %j",
    async (params) => {
      const { context, invoke } = createHarness(`canvas.document.${method}`, true);
      expectFailure(await invoke(params), "INVALID_REQUEST");
      expect(context.ensureSandboxHostPort).not.toHaveBeenCalled();
      expect(readDocument).not.toHaveBeenCalled();
    },
  );
});
