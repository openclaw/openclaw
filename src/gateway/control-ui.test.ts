<<<<<<< HEAD
import { describe, expect, it } from "vitest";
import {
  buildControlUiAvatarUrl,
  normalizeControlUiBasePath,
  resolveAssistantAvatarUrl,
} from "./control-ui-shared.js";

describe("resolveAssistantAvatarUrl", () => {
  it("normalizes base paths", () => {
    expect(normalizeControlUiBasePath()).toBe("");
    expect(normalizeControlUiBasePath("")).toBe("");
    expect(normalizeControlUiBasePath(" ")).toBe("");
    expect(normalizeControlUiBasePath("/")).toBe("");
    expect(normalizeControlUiBasePath("ui")).toBe("/ui");
    expect(normalizeControlUiBasePath("/ui/")).toBe("/ui");
  });

  it("builds avatar URLs", () => {
    expect(buildControlUiAvatarUrl("", "main")).toBe("/avatar/main");
    expect(buildControlUiAvatarUrl("/ui", "main")).toBe("/ui/avatar/main");
  });

  it("keeps remote and data URLs", () => {
    expect(
      resolveAssistantAvatarUrl({
        avatar: "https://example.com/avatar.png",
        agentId: "main",
        basePath: "/ui",
      }),
    ).toBe("https://example.com/avatar.png");
    expect(
      resolveAssistantAvatarUrl({
        avatar: "data:image/png;base64,abc",
        agentId: "main",
        basePath: "/ui",
      }),
    ).toBe("data:image/png;base64,abc");
  });

  it("prefixes basePath for /avatar endpoints", () => {
    expect(
      resolveAssistantAvatarUrl({
        avatar: "/avatar/main",
        agentId: "main",
        basePath: "/ui",
      }),
    ).toBe("/ui/avatar/main");
    expect(
      resolveAssistantAvatarUrl({
        avatar: "/ui/avatar/main",
        agentId: "main",
        basePath: "/ui",
      }),
    ).toBe("/ui/avatar/main");
  });

  it("maps local avatar paths to the avatar endpoint", () => {
    expect(
      resolveAssistantAvatarUrl({
        avatar: "avatars/me.png",
        agentId: "main",
        basePath: "/ui",
      }),
    ).toBe("/ui/avatar/main");
    expect(
      resolveAssistantAvatarUrl({
        avatar: "avatars/profile",
        agentId: "main",
        basePath: "/ui",
      }),
    ).toBe("/ui/avatar/main");
  });

  it("leaves local paths untouched when agentId is missing", () => {
    expect(
      resolveAssistantAvatarUrl({
        avatar: "avatars/me.png",
        basePath: "/ui",
      }),
    ).toBe("avatars/me.png");
  });

  it("keeps short text avatars", () => {
    expect(
      resolveAssistantAvatarUrl({
        avatar: "PS",
        agentId: "main",
        basePath: "/ui",
      }),
    ).toBe("PS");
=======
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
  it("sets anti-clickjacking headers for Control UI responses", async () => {
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
      expect(setHeader).toHaveBeenCalledWith("Content-Security-Policy", "frame-ancestors 'none'");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
>>>>>>> upstream/main
  });
});
