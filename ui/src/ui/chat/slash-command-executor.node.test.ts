import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { GatewaySessionRow } from "../types.ts";
import { executeSlashCommand } from "./slash-command-executor.ts";

function row(key: string): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    updatedAt: null,
  };
}

describe("executeSlashCommand /kill", () => {
  it("aborts every sub-agent session for /kill all", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("main"),
            row("agent:main:subagent:one"),
            row("agent:main:subagent:parent:subagent:child"),
            row("agent:other:main"),
          ],
        };
      }
      if (method === "chat.abort") {
        return { ok: true, aborted: true };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "kill",
      "all",
    );

    expect(result.content).toBe("Aborted 2 sub-agent sessions.");
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
    expect(request).toHaveBeenNthCalledWith(2, "chat.abort", {
      sessionKey: "agent:main:subagent:one",
    });
    expect(request).toHaveBeenNthCalledWith(3, "chat.abort", {
      sessionKey: "agent:main:subagent:parent:subagent:child",
    });
  });

  it("aborts matching sub-agent sessions for /kill <agentId>", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:subagent:one"),
            row("agent:main:subagent:two"),
            row("agent:other:subagent:three"),
          ],
        };
      }
      if (method === "chat.abort") {
        return { ok: true, aborted: true };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "kill",
      "main",
    );

    expect(result.content).toBe("Aborted 2 matching sub-agent sessions for `main`.");
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
    expect(request).toHaveBeenNthCalledWith(2, "chat.abort", {
      sessionKey: "agent:main:subagent:one",
    });
    expect(request).toHaveBeenNthCalledWith(3, "chat.abort", {
      sessionKey: "agent:main:subagent:two",
    });
  });

  it("does not exact-match a session key outside the current subagent subtree", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:subagent:parent"),
            row("agent:main:subagent:parent:subagent:child"),
            row("agent:main:subagent:sibling"),
          ],
        };
      }
      if (method === "chat.abort") {
        return { ok: true, aborted: true };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:subagent:parent",
      "kill",
      "agent:main:subagent:sibling",
    );

    expect(result.content).toBe(
      "No matching sub-agent sessions found for `agent:main:subagent:sibling`.",
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
  });

  it("returns a no-op summary when matching sessions have no active runs", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [row("agent:main:subagent:one"), row("agent:main:subagent:two")],
        };
      }
      if (method === "chat.abort") {
        return { ok: true, aborted: false };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "kill",
      "all",
    );

    expect(result.content).toBe("No active sub-agent runs to abort.");
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
    expect(request).toHaveBeenNthCalledWith(2, "chat.abort", {
      sessionKey: "agent:main:subagent:one",
    });
    expect(request).toHaveBeenNthCalledWith(3, "chat.abort", {
      sessionKey: "agent:main:subagent:two",
    });
  });

  it("treats the legacy main session key as the default agent scope", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("main"),
            row("agent:main:subagent:one"),
            row("agent:main:subagent:two"),
            row("agent:other:subagent:three"),
          ],
        };
      }
      if (method === "chat.abort") {
        return { ok: true, aborted: true };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "kill",
      "all",
    );

    expect(result.content).toBe("Aborted 2 sub-agent sessions.");
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
    expect(request).toHaveBeenNthCalledWith(2, "chat.abort", {
      sessionKey: "agent:main:subagent:one",
    });
    expect(request).toHaveBeenNthCalledWith(3, "chat.abort", {
      sessionKey: "agent:main:subagent:two",
    });
  });
});
