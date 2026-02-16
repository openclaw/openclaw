import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "./control-ui-contract.js";
import { handleControlUiHttpRequest } from "./control-ui.js";

const makeResponse = (): {
  res: ServerResponse;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} => {
  const setHeader = vi.fn();
  const end = vi.fn();
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader,
    end,
  } as unknown as ServerResponse;
  return { res, setHeader, end };
};

describe("handleControlUiHttpRequest", () => {
  it("sets security headers for Control UI responses", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "index.html"), "<html></html>\n");
      const { res, setHeader } = makeResponse();
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
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("does not inject inline scripts into index.html", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      const html = "<html><head></head><body>Hello</body></html>\n";
      await fs.writeFile(path.join(tmp, "index.html"), html);
      const { res, end } = makeResponse();
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
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("serves bootstrap config JSON", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "index.html"), "<html></html>\n");
      const { res, end } = makeResponse();
      const handled = handleControlUiHttpRequest(
        { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
        res,
        {
          root: { kind: "resolved", path: tmp },
          config: {
            agents: { defaults: { workspace: tmp } },
            ui: { assistant: { name: "</script><script>alert(1)//", avatar: "</script>.png" } },
          },
        },
      );
      expect(handled).toBe(true);
      const payload = String(end.mock.calls[0]?.[0] ?? "");
      const parsed = JSON.parse(payload) as {
        basePath: string;
        assistantName: string;
        assistantAvatar: string;
        assistantAgentId: string;
      };
      expect(parsed.basePath).toBe("");
      expect(parsed.assistantName).toBe("</script><script>alert(1)//");
      expect(parsed.assistantAvatar).toBe("/avatar/main");
      expect(parsed.assistantAgentId).toBe("main");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("serves bootstrap config JSON under basePath", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "index.html"), "<html></html>\n");
      const { res, end } = makeResponse();
      const handled = handleControlUiHttpRequest(
        { url: `/openclaw${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, method: "GET" } as IncomingMessage,
        res,
        {
          basePath: "/openclaw",
          root: { kind: "resolved", path: tmp },
          config: {
            agents: { defaults: { workspace: tmp } },
            ui: { assistant: { name: "Ops", avatar: "ops.png" } },
          },
        },
      );
      expect(handled).toBe(true);
      const payload = String(end.mock.calls[0]?.[0] ?? "");
      const parsed = JSON.parse(payload) as {
        basePath: string;
        assistantName: string;
        assistantAvatar: string;
        assistantAgentId: string;
      };
      expect(parsed.basePath).toBe("/openclaw");
      expect(parsed.assistantName).toBe("Ops");
      expect(parsed.assistantAvatar).toBe("/openclaw/avatar/main");
      expect(parsed.assistantAgentId).toBe("main");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
