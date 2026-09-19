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
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

const readDocument = vi.hoisted(() => vi.fn());
vi.mock("../../canvas/documents.js", () => ({ readCanvasDocumentHtmlSource: readDocument }));

function createHarness(method = "canvas.document.view") {
  const client = {
    connect: { role: "operator", scopes: ["operator.read"] },
    connId: "viewer",
  } as GatewayClient;
  const methodRegistry = createGatewayMethodRegistry([]);
  const context = {
    getRuntimeConfig: () => ({}),
    getMcpAppSandboxPort: () => 18790,
    ensureSandboxHostPort: vi.fn(async () => 18790),
    isConnectionActive: () => true,
    getGatewayMethodRegistry: () => methodRegistry,
  } as unknown as GatewayRequestContext;
  context.resolveGatewayContext = () => context;
  const invoke = async (
    params: Record<string, unknown> = { docId: "cv_widget" },
    options: Partial<GatewayRequestHandlerOptions> = {},
  ) => {
    const respond = vi.fn();
    await canvasHandlers[method]!({
      req: { type: "req", id: "canvas", method, params },
      params,
      client,
      context,
      isWebchatConnect: () => true,
      respond,
      ...options,
    });
    return respond;
  };
  return { client, context, invoke };
}

beforeEach(() => {
  resetGatewayWorkAdmission();
  readDocument.mockReset().mockResolvedValue({ html: "<p>Widget</p>", cspSandbox: "scripts" });
});
afterEach(() => resetGatewayWorkAdmission());

describe("canvas.document.view", () => {
  it("returns only the hosted document and isolated sandbox metadata", async () => {
    const { context, invoke } = createHarness();
    context.getRuntimeConfig = () => ({
      mcp: { apps: { sandboxOrigin: "https://sandbox.example" } },
    });
    const respond = await invoke();
    expect(respond.mock.calls[0]).toEqual([
      true,
      {
        html: "<p>Widget</p>",
        sandboxUrl: expect.stringMatching(/^\/mcp-app-sandbox\?csp=/),
        sandboxPort: 18790,
        sandboxOrigin: "https://sandbox.example",
      },
    ]);
    const result = respond.mock.calls[0]![1];
    const url = new URL(result.sandboxUrl, "https://sandbox.example");
    const policy = decodeSandboxHostCsp(url.searchParams.get("csp"));
    expect(policy).toMatchObject({
      blockDescendantFrames: true,
      resourceDomains: expect.arrayContaining([
        "https://cdn.jsdelivr.net",
        "https://fonts.googleapis.com",
        "https://fonts.gstatic.com",
      ]),
    });
    expect(policy?.connectDomains).toBeUndefined();
    expect(context.ensureSandboxHostPort).not.toHaveBeenCalled();
  });

  it("starts sandbox provisioning while the document read is pending", async () => {
    const { context, invoke } = createHarness();
    const document = createDeferred<{ html: string; cspSandbox: "scripts" }>();
    const sandbox = createDeferred<number>();
    readDocument.mockReturnValue(document.promise);
    context.getMcpAppSandboxPort = () => undefined;
    vi.mocked(context.ensureSandboxHostPort!).mockReturnValue(sandbox.promise);
    const pending = invoke();
    expect(readDocument).toHaveBeenCalledWith("cv_widget", { maxBytes: 2 * 1024 * 1024 });
    expect(context.ensureSandboxHostPort).toHaveBeenCalledOnce();
    sandbox.resolve(18790);
    document.resolve({ html: "<p>Widget</p>", cspSandbox: "scripts" });
    expect((await pending).mock.calls[0]?.[0]).toBe(true);
  });

  it.each([{}, { docId: "../private" }, { docId: "." }, { docId: "cv_widget", html: "injected" }])(
    "rejects invalid document identifiers and extra source fields: %j",
    async (params) => {
      const { invoke } = createHarness();
      const respond = await invoke(params);
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(respond.mock.calls[0]?.[2]).toMatchObject({ code: "INVALID_REQUEST" });
      expect(readDocument).not.toHaveBeenCalled();
    },
  );

  it("honors Canvas hosting disablement before reading content", async () => {
    const { context, invoke } = createHarness();
    context.getRuntimeConfig = () => ({
      plugins: { entries: { canvas: { config: { host: { enabled: false } } } } },
    });
    const respond = await invoke();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(readDocument).not.toHaveBeenCalled();
  });

  it("refuses non-widget documents and oversized widget bytes", async () => {
    const { invoke } = createHarness();
    for (const document of [
      { html: "<p>Non-widget artifact</p>" },
      { html: "x".repeat(2 * 1024 * 1024 + 1), cspSandbox: "scripts" },
    ]) {
      readDocument.mockResolvedValueOnce(document);
      expect((await invoke()).mock.calls[0]?.[0]).toBe(false);
    }
  });

  it.each(["gateway", "client", "signal", "configuration"] as const)(
    "rejects a retired %s before returning awaited content",
    async (boundary) => {
      const { context, client, invoke } = createHarness();
      const document = createDeferred<{ html: string; cspSandbox: "scripts" }>();
      readDocument.mockReturnValue(document.promise);
      const controller = new AbortController();
      const pending = invoke(undefined, { signal: controller.signal });
      if (boundary === "gateway") {
        context.resolveGatewayContext = () => undefined;
      }
      if (boundary === "client") {
        client.invalidated = true;
      }
      if (boundary === "signal") {
        controller.abort();
      }
      if (boundary === "configuration") {
        context.getRuntimeConfig = () => ({
          plugins: { entries: { canvas: { config: { host: { enabled: false } } } } },
        });
      }
      document.resolve({ html: "<p>Private widget</p>", cspSandbox: "scripts" });
      const respond = await pending;
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(respond.mock.calls[0]?.[1]).toBeUndefined();
    },
  );

  it("reports missing documents and unavailable sandbox listeners without exposing file paths", async () => {
    const { context, invoke } = createHarness();
    readDocument.mockRejectedValueOnce(new Error("ENOENT: /private/state/canvas/secret"));
    const missing = await invoke();
    expect(missing.mock.calls[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
    expect(JSON.stringify(missing.mock.calls)).not.toContain("/private/state");
    context.getMcpAppSandboxPort = () => undefined;
    context.ensureSandboxHostPort = undefined;
    expect((await invoke()).mock.calls[0]?.[0]).toBe(false);
  });
});

describe("canvas.document.preview", () => {
  function createPreviewHarness() {
    return createHarness("canvas.document.preview");
  }

  afterEach(() => {
    expect(readDocument).not.toHaveBeenCalled();
  });

  it("returns unchanged caller HTML with only default-policy isolated sandbox metadata", async () => {
    const { context, invoke } = createPreviewHarness();
    context.getRuntimeConfig = () => ({
      mcp: { apps: { sandboxOrigin: "https://sandbox.example/preview" } },
    });
    const html =
      "\uFEFF<!doctype html>\r\n<p>café 漢字 🦀</p><script>window.example = true;</script>\n";
    const respond = await invoke({ html });
    expect(respond.mock.calls).toEqual([
      [
        true,
        {
          html,
          sandboxUrl: expect.stringMatching(/^\/mcp-app-sandbox\?csp=/),
          sandboxPort: 18790,
          sandboxOrigin: "https://sandbox.example",
        },
      ],
    ]);
    const result = respond.mock.calls[0]![1];
    const url = new URL(result.sandboxUrl, "https://sandbox.example");
    expect(decodeSandboxHostCsp(url.searchParams.get("csp"))).toEqual({
      blockDescendantFrames: true,
    });
    expect(context.ensureSandboxHostPort).not.toHaveBeenCalled();
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

  it.each(["", "a".repeat(256 * 1024), "🦀".repeat(64 * 1024)])(
    "accepts empty HTML and the exact ASCII/multibyte UTF-8 limit (case %#)",
    async (html) => {
      const { invoke } = createPreviewHarness();
      const respond = await invoke({ html });
      expect(respond.mock.calls[0]).toEqual([
        true,
        { html, sandboxPort: 18790, sandboxUrl: expect.any(String) },
      ]);
    },
  );

  it.each(["a".repeat(256 * 1024 + 1), "🦀".repeat(64 * 1024) + "a"])(
    "rejects oversized ASCII/multibyte bytes before provisioning (case %#)",
    async (html) => {
      const { context, invoke } = createPreviewHarness();
      context.getMcpAppSandboxPort = () => undefined;
      const respond = await invoke({ html });
      expect(respond.mock.calls[0]).toEqual([
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      ]);
      expect(context.ensureSandboxHostPort).not.toHaveBeenCalled();
    },
  );

  it.each([
    {},
    { html: 1 },
    { html: null },
    { html: [] },
    { docId: "cv_widget" },
    { html: "<p>Preview</p>", docId: "cv_widget" },
    { html: "<p>Preview</p>", path: "/private/document.html" },
    { html: "<p>Preview</p>", csp: { connectDomains: ["https://example.com"] } },
  ])("rejects invalid params without granting document or policy selection: %j", async (params) => {
    const { context, invoke } = createPreviewHarness();
    context.getMcpAppSandboxPort = () => undefined;
    const respond = await invoke(params);
    expect(respond.mock.calls[0]?.[2]).toMatchObject({ code: "INVALID_REQUEST" });
    expect(context.ensureSandboxHostPort).not.toHaveBeenCalled();
  });

  const retiredBoundaries = [
    "gateway",
    "resolver",
    "client",
    "connection",
    "method-registry",
    "signal",
    "configuration",
    "admission",
    "commit-guard",
  ] as const;
  it.each(retiredBoundaries)(
    "rejects a retired %s before and after provisioning",
    async (boundary) => {
      for (const when of ["before", "after"] as const) {
        const { client, context, invoke } = createPreviewHarness();
        const sandbox = createDeferred<number>();
        context.getMcpAppSandboxPort = () => undefined;
        vi.mocked(context.ensureSandboxHostPort!).mockReturnValue(sandbox.promise);
        const controller = new AbortController();
        let guardActive = true;
        let currentContext: GatewayRequestContext | undefined = context;
        context.resolveGatewayContext = () => currentContext;
        const options = {
          signal: controller.signal,
          sessionMutationCommitGuard: () => {
            if (!guardActive) {
              throw new Error("retired request");
            }
          },
        };
        const retire = () => {
          switch (boundary) {
            case "gateway":
              currentContext = undefined;
              break;
            case "resolver":
              context.resolveGatewayContext = () => context;
              break;
            case "client":
              client.invalidated = true;
              break;
            case "connection":
              context.isConnectionActive = () => false;
              break;
            case "method-registry": {
              const replacement = createGatewayMethodRegistry([]);
              context.getGatewayMethodRegistry = () => replacement;
              break;
            }
            case "signal":
              controller.abort();
              break;
            case "configuration":
              context.getRuntimeConfig = () => ({
                plugins: { entries: { canvas: { config: { host: { enabled: false } } } } },
              });
              break;
            case "admission":
              markGatewayRestartDraining();
              break;
            case "commit-guard":
              guardActive = false;
              break;
          }
        };
        // Replacing an otherwise live resolver/registry only retires already-captured requests.
        if (when === "before" && (boundary === "resolver" || boundary === "method-registry")) {
          continue;
        }
        if (when === "before") {
          retire();
        }
        const pending = invoke({ html: "<p>Preview</p>" }, options);
        if (when === "after") {
          expect(context.ensureSandboxHostPort).toHaveBeenCalledOnce();
          retire();
        } else {
          expect(context.ensureSandboxHostPort).not.toHaveBeenCalled();
        }
        sandbox.resolve(18790);
        expect((await pending).mock.calls).toEqual([
          [false, undefined, expect.objectContaining({ code: "UNAVAILABLE" })],
        ]);
        resetGatewayWorkAdmission();
      }
    },
  );

  it("provisions the existing host without touching stored documents", async () => {
    const { context, invoke } = createPreviewHarness();
    context.getMcpAppSandboxPort = () => undefined;
    const respond = await invoke({ html: "<h1>Preview</h1>" });
    expect(context.ensureSandboxHostPort).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[0]).toBe(true);
  });

  it("reports unavailable or failed listeners without exposing server details", async () => {
    const { context, invoke } = createPreviewHarness();
    context.getMcpAppSandboxPort = () => undefined;
    vi.mocked(context.ensureSandboxHostPort!).mockRejectedValue(new Error("/private/sandbox-host"));
    const failed = await invoke({ html: "<p>Preview</p>" });
    expect(failed.mock.calls[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
    expect(JSON.stringify(failed.mock.calls)).not.toContain("/private/");
    context.ensureSandboxHostPort = undefined;
    expect((await invoke({ html: "" })).mock.calls[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
  });
});
