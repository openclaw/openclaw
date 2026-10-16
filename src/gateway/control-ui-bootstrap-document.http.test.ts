import fs from "node:fs";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { escapeHtml } from "../shared/html-escape.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE } from "./control-ui-bootstrap-contract.js";
import * as pluginAssets from "./control-ui-plugin-assets.js";
import { handleControlUiHttpRequest } from "./control-ui.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "embeds the endpoint payload only in admitted documents (catalog failure: %s)",
  async (catalogFails) => {
    const plugin = {
      pluginId: "review",
      name: "Review",
      revision: "one",
      entryUrl: "/control/__openclaw__/plugins/control-ui/review/one/index.js",
      styles: ["/control/__openclaw__/plugins/control-ui/review/one/index.css"],
      imports: ["/control/__openclaw__/plugins/control-ui/review/one/chunk.js"],
    };
    const catalog = vi.spyOn(pluginAssets, "listControlUiPluginCatalog");
    if (catalogFails) {
      catalog.mockRejectedValue(new Error("plugin registry is no longer active"));
    } else {
      catalog.mockResolvedValue({ revision: "catalog-one", plugins: [plugin], diagnostics: [] });
    }
    const root = dirs.make("bootstrap-document-");
    fs.writeFileSync(
      path.join(root, "index.html"),
      "<!doctype html>\n<html><head></head><body><openclaw-app></openclaw-app></body></html>",
    );
    const name = '"><script>alert(1)</script> $$ $`';
    const config: OpenClawConfig = {
      agents: { entries: { main: { workspace: root, identity: { name, emoji: "🔭" } } } },
      gateway: { terminal: { enabled: false } },
    };
    const options = {
      basePath: "/control",
      root: { kind: "resolved" as const, path: root },
      config,
      getRuntimeConfig: () => config,
      auth: { mode: "token" as const, token: "test-token", allowTailscale: false },
    };
    const request = async (url: string, admitted: boolean, authorized: boolean) => {
      const req = new IncomingMessage(new Socket());
      req.url = url;
      req.method = "GET";
      req.headers = authorized ? { authorization: "Bearer test-token" } : {};
      const response = makeMockHttpResponse();
      await handleControlUiHttpRequest(req, response.res, {
        ...options,
        ...(admitted
          ? { sessionEntryPath: "/control/chat/main/topic", isSessionEntryCurrent: () => true }
          : {}),
      });
      return { ...response, body: String(response.end.mock.calls[0]?.[0] ?? "") };
    };
    const endpoint = await request("/control/control-ui-config.json", false, true);
    expect(endpoint.res.statusCode).toBe(200);
    expect(JSON.parse(endpoint.body)).toMatchObject({
      assistantName: name,
      assistantAvatar: "🔭",
      terminalEnabled: false,
      pluginControlUiModules: catalogFails ? [] : [plugin],
    });
    const document = await request("/control/chat/main/topic", true, true);
    expect(document.res.statusCode).toBe(200);
    expect(document.body).toContain(
      `${CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE}="${escapeHtml(endpoint.body)}"`,
    );
    expect(document.body).not.toContain("<script>alert(1)</script>");
    expect(document.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");

    const anonymous = await request("/control/", false, false);
    expect(anonymous.res.statusCode).toBe(200);
    expect(anonymous.body).not.toContain(CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE);
    expect(anonymous.body).not.toContain("alert(1)");
    const denied = await request("/control/chat/main/topic", true, false);
    expect(denied.res.statusCode).toBe(200);
    expect(denied.body).not.toContain(CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE);
  },
);
