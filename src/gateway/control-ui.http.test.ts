import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "./control-ui-contract.js";
import { handleControlUiAvatarRequest, handleControlUiHttpRequest } from "./control-ui.js";
import { makeMockHttpResponse } from "./test-http-response.js";

describe("handleControlUiHttpRequest", () => {
  async function withControlUiRoot<T>(params: {
    indexHtml?: string;
    fn: (tmp: string) => Promise<T>;
  }) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "index.html"), params.indexHtml ?? "<html></html>\n");
      return await params.fn(tmp);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  function parseBootstrapPayload(end: ReturnType<typeof makeMockHttpResponse>["end"]) {
    return JSON.parse(String(end.mock.calls[0]?.[0] ?? "")) as {
      basePath: string;
      assistantName: string;
      assistantAvatar: string;
      assistantAgentId: string;
    };
  }

  function expectNotFoundResponse(params: {
    handled: boolean;
    res: ReturnType<typeof makeMockHttpResponse>["res"];
    end: ReturnType<typeof makeMockHttpResponse>["end"];
  }) {
    expect(params.handled).toBe(true);
    expect(params.res.statusCode).toBe(404);
    expect(params.end).toHaveBeenCalledWith("Not Found");
  }

  function expectUnhandledRoutes(params: {
    urls: string[];
    method: "GET" | "POST";
    rootPath: string;
    basePath?: string;
    expectationLabel: string;
  }) {
    for (const url of params.urls) {
      const { handled, end } = runControlUiRequest({
        url,
        method: params.method,
        rootPath: params.rootPath,
        ...(params.basePath ? { basePath: params.basePath } : {}),
      });
      expect(handled, `${params.expectationLabel}: ${url}`).toBe(false);
      expect(end, `${params.expectationLabel}: ${url}`).not.toHaveBeenCalled();
    }
  }

  function runControlUiRequest(params: {
    url: string;
    method: "GET" | "HEAD" | "POST";
    rootPath: string;
    basePath?: string;
    rootKind?: "resolved" | "bundled";
  }) {
    const { res, end } = makeMockHttpResponse();
    const handled = handleControlUiHttpRequest(
      { url: params.url, method: params.method } as IncomingMessage,
      res,
      {
        ...(params.basePath ? { basePath: params.basePath } : {}),
        root: { kind: params.rootKind ?? "resolved", path: params.rootPath },
      },
    );
    return { res, end, handled };
  }

  function runAvatarRequest(params: {
    url: string;
    method: "GET" | "HEAD";
    resolveAvatar: Parameters<typeof handleControlUiAvatarRequest>[2]["resolveAvatar"];
    basePath?: string;
  }) {
    const { res, end } = makeMockHttpResponse();
    const handled = handleControlUiAvatarRequest(
      { url: params.url, method: params.method } as IncomingMessage,
      res,
      {
        ...(params.basePath ? { basePath: params.basePath } : {}),
        resolveAvatar: params.resolveAvatar,
      },
    );
    return { res, end, handled };
  }

  async function writeAssetFile(rootPath: string, filename: string, contents: string) {
    const assetsDir = path.join(rootPath, "assets");
    await fs.mkdir(assetsDir, { recursive: true });
    const filePath = path.join(assetsDir, filename);
    await fs.writeFile(filePath, contents);
    return { assetsDir, filePath };
  }

  async function withBasePathRootFixture<T>(params: {
    siblingDir: string;
    fn: (paths: { root: string; sibling: string }) => Promise<T>;
  }) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-root-"));
    try {
      const root = path.join(tmp, "ui");
      const sibling = path.join(tmp, params.siblingDir);
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(sibling, { recursive: true });
      await fs.writeFile(path.join(root, "index.html"), "<html>ok</html>\n");
      return await params.fn({ root, sibling });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  it("sets security headers for Control UI responses", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, setHeader } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: "/", method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
          },
        );
        expect(handled).toBe(true);
        expect(setHeader).toHaveBeenCalledWith("X-Frame-Options", "DENY");
        const csp = setHeader.mock.calls.find((call) => call[0] === "Content-Security-Policy")?.[1];
        expect(typeof csp).toBe("string");
        expect(String(csp)).toContain("frame-ancestors 'none'");
        expect(String(csp)).toContain("script-src 'self'");
        expect(String(csp)).not.toContain("script-src 'self' 'unsafe-inline'");
      },
    });
  });

  it("does not inject inline scripts into index.html", async () => {
    const html = "<html><head></head><body>Hello</body></html>\n";
    await withControlUiRoot({
      indexHtml: html,
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: "/", method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: {
              agents: { defaults: { workspace: tmp } },
              ui: { assistant: { name: "</script><script>alert(1)//", avatar: "evil.png" } },
            },
          },
        );
        expect(handled).toBe(true);
        expect(end).toHaveBeenCalledWith(html);
      },
    });
  });

  it.each([
    {
      name: "at root",
      url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
      expectedBasePath: "",
      assistantName: "</script><script>alert(1)//",
      assistantAvatar: "</script>.png",
      expectedAvatarUrl: "/avatar/main",
    },
    {
      name: "under basePath",
      url: `/openclaw${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`,
      basePath: "/openclaw",
      expectedBasePath: "/openclaw",
      assistantName: "Ops",
      assistantAvatar: "ops.png",
      expectedAvatarUrl: "/openclaw/avatar/main",
    },
  ])("serves bootstrap config JSON $name", async (testCase) => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: testCase.url, method: "GET" } as IncomingMessage,
          res,
          {
            ...(testCase.basePath ? { basePath: testCase.basePath } : {}),
            root: { kind: "resolved", path: tmp },
            config: {
              agents: { defaults: { workspace: tmp } },
              ui: {
                assistant: {
                  name: testCase.assistantName,
                  avatar: testCase.assistantAvatar,
                },
              },
            },
          },
        );
        expect(handled).toBe(true);
        const parsed = parseBootstrapPayload(end);
        expect(parsed.basePath).toBe(testCase.expectedBasePath);
        expect(parsed.assistantName).toBe(testCase.assistantName);
        expect(parsed.assistantAvatar).toBe(testCase.expectedAvatarUrl);
        expect(parsed.assistantAgentId).toBe("main");
      },
    });
  });

  it.each([
    {
      name: "at root",
      url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
    },
    {
      name: "under basePath",
      url: `/openclaw${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`,
      basePath: "/openclaw",
    },
  ])("serves bootstrap config HEAD $name without writing a body", async (testCase) => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: testCase.url, method: "HEAD" } as IncomingMessage,
          res,
          {
            ...(testCase.basePath ? { basePath: testCase.basePath } : {}),
            root: { kind: "resolved", path: tmp },
          },
        );
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(end.mock.calls[0]?.length ?? -1).toBe(0);
      },
    });
  });

  it("serves local avatar bytes through hardened avatar handler", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-http-"));
    try {
      const avatarPath = path.join(tmp, "main.png");
      await fs.writeFile(avatarPath, "avatar-bytes\n");

      const { res, end, handled } = runAvatarRequest({
        url: "/avatar/main",
        method: "GET",
        resolveAvatar: () => ({ kind: "local", filePath: avatarPath }),
      });

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(String(end.mock.calls[0]?.[0] ?? "")).toBe("avatar-bytes\n");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects avatar symlink paths from resolver", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-http-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-http-outside-"));
    try {
      const outsideFile = path.join(outside, "secret.txt");
      await fs.writeFile(outsideFile, "outside-secret\n");
      const linkPath = path.join(tmp, "avatar-link.png");
      await fs.symlink(outsideFile, linkPath);

      const { res, end, handled } = runAvatarRequest({
        url: "/avatar/main",
        method: "GET",
        resolveAvatar: () => ({ kind: "local", filePath: linkPath }),
      });

      expectNotFoundResponse({ handled, res, end });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects symlinked assets that resolve outside control-ui root", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const assetsDir = path.join(tmp, "assets");
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-outside-"));
        try {
          const outsideFile = path.join(outsideDir, "secret.txt");
          await fs.mkdir(assetsDir, { recursive: true });
          await fs.writeFile(outsideFile, "outside-secret\n");
          await fs.symlink(outsideFile, path.join(assetsDir, "leak.txt"));

          const { res, end } = makeMockHttpResponse();
          const handled = handleControlUiHttpRequest(
            { url: "/assets/leak.txt", method: "GET" } as IncomingMessage,
            res,
            {
              root: { kind: "resolved", path: tmp },
            },
          );
          expectNotFoundResponse({ handled, res, end });
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      },
    });
  });

  it("allows symlinked assets that resolve inside control-ui root", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { assetsDir, filePath } = await writeAssetFile(tmp, "actual.txt", "inside-ok\n");
        await fs.symlink(filePath, path.join(assetsDir, "linked.txt"));

        const { res, end, handled } = runControlUiRequest({
          url: "/assets/linked.txt",
          method: "GET",
          rootPath: tmp,
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(String(end.mock.calls[0]?.[0] ?? "")).toBe("inside-ok\n");
      },
    });
  });

  it("serves HEAD for in-root assets without writing a body", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        await writeAssetFile(tmp, "actual.txt", "inside-ok\n");

        const { res, end, handled } = runControlUiRequest({
          url: "/assets/actual.txt",
          method: "HEAD",
          rootPath: tmp,
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(end.mock.calls[0]?.length ?? -1).toBe(0);
      },
    });
  });

  it("rejects symlinked SPA fallback index.html outside control-ui root", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-index-outside-"));
        try {
          const outsideIndex = path.join(outsideDir, "index.html");
          await fs.writeFile(outsideIndex, "<html>outside</html>\n");
          await fs.rm(path.join(tmp, "index.html"));
          await fs.symlink(outsideIndex, path.join(tmp, "index.html"));

          const { res, end, handled } = runControlUiRequest({
            url: "/app/route",
            method: "GET",
            rootPath: tmp,
          });
          expectNotFoundResponse({ handled, res, end });
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      },
    });
  });

  it("rejects hardlinked index.html for non-package control-ui roots", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-index-hardlink-"));
        try {
          const outsideIndex = path.join(outsideDir, "index.html");
          await fs.writeFile(outsideIndex, "<html>outside-hardlink</html>\n");
          await fs.rm(path.join(tmp, "index.html"));
          await fs.link(outsideIndex, path.join(tmp, "index.html"));

          const { res, end, handled } = runControlUiRequest({
            url: "/",
            method: "GET",
            rootPath: tmp,
          });
          expectNotFoundResponse({ handled, res, end });
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      },
    });
  });

  it.each([
    {
      name: "rejects hardlinked asset files for custom/resolved roots",
      rootKind: "resolved" as const,
      expectedStatus: 404,
      expectedBody: "Not Found",
    },
    {
      name: "serves hardlinked asset files for bundled roots",
      rootKind: "bundled" as const,
      expectedStatus: 200,
      expectedBody: "console.log('hi');",
    },
  ])("$name", async (testCase) => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const assetsDir = path.join(tmp, "assets");
        await fs.mkdir(assetsDir, { recursive: true });
        await fs.writeFile(path.join(assetsDir, "app.js"), "console.log('hi');");
        await fs.link(path.join(assetsDir, "app.js"), path.join(assetsDir, "app.hl.js"));

        const { res, end, handled } = runControlUiRequest({
          url: "/assets/app.hl.js",
          method: "GET",
          rootPath: tmp,
          rootKind: testCase.rootKind,
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(testCase.expectedStatus);
        expect(String(end.mock.calls[0]?.[0] ?? "")).toBe(testCase.expectedBody);
      },
    });
  });

  it("does not handle POST to root-mounted paths (plugin webhook passthrough)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        expectUnhandledRoutes({
          urls: ["/bluebubbles-webhook", "/custom-webhook", "/callback"],
          method: "POST",
          rootPath: tmp,
          expectationLabel: "POST should pass through to plugin handlers",
        });
      },
    });
  });

  it("does not handle POST to paths outside basePath", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        expectUnhandledRoutes({
          urls: ["/bluebubbles-webhook"],
          method: "POST",
          rootPath: tmp,
          basePath: "/openclaw",
          expectationLabel: "POST outside basePath should pass through",
        });
      },
    });
  });

  it.each([
    {
      name: "does not handle /api paths when basePath is empty",
      urls: ["/api", "/api/sessions", "/api/channels/nostr"],
    },
    {
      name: "does not handle /plugins paths when basePath is empty",
      urls: ["/plugins", "/plugins/diffs/view/abc/def"],
    },
  ])("$name", async (testCase) => {
    await withControlUiRoot({
      fn: async (tmp) => {
        expectUnhandledRoutes({
          urls: testCase.urls,
          method: "GET",
          rootPath: tmp,
          expectationLabel: "expected route to not be handled",
        });
      },
    });
  });

  it("falls through POST requests when basePath is empty", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        expectUnhandledRoutes({
          urls: ["/webhook/bluebubbles"],
          method: "POST",
          rootPath: tmp,
          expectationLabel: "POST webhook should fall through",
        });
      },
    });
  });

  it("falls through POST requests under configured basePath (plugin webhook passthrough)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        expectUnhandledRoutes({
          urls: ["/openclaw", "/openclaw/", "/openclaw/some-page"],
          method: "POST",
          rootPath: tmp,
          basePath: "/openclaw",
          expectationLabel: "POST under basePath should pass through to plugin handlers",
        });
      },
    });
  });

  it("rejects absolute-path escape attempts under basePath routes", async () => {
    await withBasePathRootFixture({
      siblingDir: "ui-secrets",
      fn: async ({ root, sibling }) => {
        const secretPath = path.join(sibling, "secret.txt");
        await fs.writeFile(secretPath, "sensitive-data");

        const secretPathUrl = secretPath.split(path.sep).join("/");
        const absolutePathUrl = secretPathUrl.startsWith("/") ? secretPathUrl : `/${secretPathUrl}`;
        const { res, end, handled } = runControlUiRequest({
          url: `/openclaw/${absolutePathUrl}`,
          method: "GET",
          rootPath: root,
          basePath: "/openclaw",
        });
        expectNotFoundResponse({ handled, res, end });
      },
    });
  });

  it("rejects symlink escape attempts under basePath routes", async () => {
    await withBasePathRootFixture({
      siblingDir: "outside",
      fn: async ({ root, sibling }) => {
        await fs.mkdir(path.join(root, "assets"), { recursive: true });
        const secretPath = path.join(sibling, "secret.txt");
        await fs.writeFile(secretPath, "sensitive-data");

        const linkPath = path.join(root, "assets", "leak.txt");
        try {
          await fs.symlink(secretPath, linkPath, "file");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM") {
            return;
          }
          throw error;
        }

        const { res, end, handled } = runControlUiRequest({
          url: "/openclaw/assets/leak.txt",
          method: "GET",
          rootPath: root,
          basePath: "/openclaw",
        });
        expectNotFoundResponse({ handled, res, end });
      },
    });
  });
});
