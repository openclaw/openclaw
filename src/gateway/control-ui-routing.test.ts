import { describe, expect, it } from "vitest";
import { classifyControlUiRequest, isControlUiApprovalDocumentPath } from "./control-ui-routing.js";

const serve = { kind: "serve", spaFallback: true } as const;
const outside = { kind: "not-control-ui" } as const;
const notFound = { kind: "not-found" } as const;

describe("isControlUiApprovalDocumentPath", () => {
  it.each([
    { basePath: "", pathname: "/approve" },
    { basePath: "", pathname: "/approve/" },
    { basePath: "", pathname: "/approve/plugin%3Arequest.json" },
    { basePath: "/openclaw", pathname: "/openclaw/approve/exec%3Aa%2Fb" },
  ])("reserves $pathname", ({ basePath, pathname }) => {
    expect(isControlUiApprovalDocumentPath({ basePath, pathname })).toBe(true);
  });

  it.each([
    { basePath: "", pathname: "/approvals/id" },
    { basePath: "", pathname: "/approve/id/extra" },
    { basePath: "/openclaw", pathname: "/approve/id" },
  ])("does not reserve $pathname", ({ basePath, pathname }) => {
    expect(isControlUiApprovalDocumentPath({ basePath, pathname })).toBe(false);
  });
});

const mountedChat = { basePath: "/openclaw", pathname: "/openclaw/chat", method: "HEAD" };
type Route = Partial<Parameters<typeof classifyControlUiRequest>[0]>;

describe("Control UI SPA fallback Accept routing", () => {
  it.each<[string, string | undefined, boolean, Route?]>([
    ["missing Accept header", undefined, true],
    ["plugin tab slug at root", "text/html", true, { pathname: "/reports" }],
    ["empty Accept header", "  ", true, mountedChat],
    [
      "browser Accept header",
      "text/html, application/xhtml+xml;q=0.9, application/xml;q=0.8",
      true,
    ],
    [
      "nonzero text wildcard under a base path",
      "application/json, text/*;q=0.5",
      true,
      mountedChat,
    ],
    ["zero-quality text wildcard rejection", "text/*;q=0", false],
    ["zero-quality HTML rejection", "text/html;q=0", false],
    ["specific HTML rejection overrides an accepting wildcard", "text/html;q=0, */*", false],
    ...(
      [
        ["text/html;q=0, text/*;charset=utf-8", false],
        ["text/html;charset=utf-8;q=0, text/html;q=1", false],
        ["text/html;q=0;charset=utf-8, */*", false],
        ["text/html;q=1;charset=utf-16, */*;q=0", false],
        ["text/html;profile=other;q=0, */*", true],
        ['text/html;note="a,b;c", */*', true],
        ["application/xhtml+xml", true],
      ] satisfies [string, boolean][]
    ).map(([accept, expected]): [string, string, boolean, Route] => [
      `representation precedence: ${accept}`,
      accept,
      expected,
      mountedChat,
    ]),
    ["nonzero HTML quality", "text/html;q=0.5", true],
    ["mixed-case zero-quality parameter", "text/html; Q = 0", false],
    ["trailing-dot zero quality", "text/html; q=0.", false],
    [
      "mixed-case XHTML three-decimal rejection",
      "application/json, Application/XHTML+XML ; q=0.000",
      false,
      mountedChat,
    ],
    ["zero-quality wildcard rejection", "application/json, */*;q=0", false],
    ["JSON-only Accept header", "application/json", false],
    [
      "plugin manager recovery at root",
      "application/json",
      true,
      { pathname: "/settings/plugins" },
    ],
  ])("classifies %s", (_name, accept, expected, route) => {
    expect(
      classifyControlUiRequest({
        basePath: "",
        pathname: "/chat",
        search: "",
        method: "GET",
        accept,
        ...route,
      }),
    ).toEqual({ kind: "serve", spaFallback: expected });
  });
});

describe("classifyControlUiRequest", () => {
  describe("root-mounted control ui", () => {
    it.each([
      ["serves the root entrypoint", "/", "GET", serve],
      ["serves other read-only SPA routes", "/chat", "HEAD", serve],
      ["plugin manager", "/settings/plugins", "GET", serve],
      ["health probes", "/healthz", "GET", outside],
      ["readiness probes", "/ready", "HEAD", outside],
      ["plugin routes", "/plugins/webhook", "GET", outside],
      ["marketplace root", "/plugins", "GET", serve],
      ["marketplace root slash", "/plugins/", "GET", serve],
      ["API routes", "/api/sessions", "GET", outside],
      ["the device join root", "/j", "GET", outside],
      ["device join codes", `/j/${"a".repeat(22)}`, "GET", outside],
      ["the OpenAI-compatible API root", "/v1", "GET", outside],
      ["the OpenAI-compatible API root slash", "/v1/", "HEAD", outside],
      ["model discovery", "/v1/models", "GET", outside],
      ["model details", "/v1/models/openclaw", "GET", outside],
      ["responses", "/v1/responses", "HEAD", outside],
      ["the standalone MCP App shell", "/__openclaw__/mcp-app", "GET", outside],
      ["the standalone MCP App view", "/__openclaw__/mcp-app/view", "HEAD", outside],
      ["MCP App lookalike", "/__openclaw__/mcp-apps", "GET", serve],
      ["MCP App descendants", "/__openclaw__/mcp-app/other", "GET", outside],
      ["worker admission", "/__openclaw__/worker", "GET", outside],
      ["worker admission descendants", "/__openclaw__/worker/other", "GET", outside],
      ["worker lookalike", "/__openclaw__/workers", "GET", serve],
      [
        "workspace transfers",
        "/__openclaw__/worker-transfer/v1/environments/worker%3A1/blobs/abc",
        "GET",
        outside,
      ],
      ["malformed workspace transfer", "/__openclaw__/worker-transfer/other", "GET", outside],
      ["transfer lookalike", "/__openclaw__/worker-transfers", "GET", serve],
      ["health probe descendants", "/healthz/details", "GET", outside],
      ["readiness probe trailing slashes", "/readyz/", "HEAD", outside],
      ["SPA lookalike: probe paths", "/healthcheck", "GET", serve],
      ["API root lookalike", "/v12", "GET", serve],
      ["API lookalike", "/v12/models", "GET", serve],
      ["returns not-found for legacy ui routes", "/ui/settings", "GET", notFound],
      ["falls through non-read requests", "/imessage-webhook", "POST", outside],
    ])("%s", (_name, pathname, method, expected) => {
      expect(
        classifyControlUiRequest({
          basePath: "",
          pathname,
          search: "",
          method,
        }),
      ).toEqual(expected);
    });
  });

  describe("plugin catalogue documents vs plugin HTTP", () => {
    it.each([
      ["HTML catalogue root slash", "/plugins/", "text/html", serve],
      ["JSON catalogue", "/plugins", "application/json", outside],
      ["JSON catalogue slash", "/plugins/", "application/json", outside],
    ] as const)("%s", (_name, pathname, accept, expected) => {
      expect(
        classifyControlUiRequest({
          basePath: "",
          pathname,
          search: "",
          method: "GET",
          accept,
        }),
      ).toEqual(expected);
    });
  });

  describe("basePath-mounted control ui", () => {
    it.each<[string, string, string, string, ReturnType<typeof classifyControlUiRequest>]>([
      [
        "redirects the basePath entrypoint",
        "/openclaw",
        "?foo=1",
        "GET",
        { kind: "redirect" as const, location: "/openclaw/?foo=1" },
      ],
      ["serves nested read-only routes", "/openclaw/chat", "", "HEAD", serve],
      ["catalogue", "/openclaw/plugins", "", "GET", serve],
      ["catalogue slash", "/openclaw/plugins/", "", "GET", serve],
      ["plugin manager", "/openclaw/settings/plugins", "", "GET", serve],
      ["falls through unmatched paths", "/elsewhere/chat", "", "GET", outside],
      ["write entrypoint", "/openclaw", "", "POST", outside],
      ["write subroute", "/openclaw/webhook", "", "PATCH", outside],
    ])("%s", (_name, pathname, search, method, expected) => {
      expect(
        classifyControlUiRequest({
          basePath: "/openclaw",
          pathname,
          search,
          method,
        }),
      ).toEqual(expected);
    });
  });
});
