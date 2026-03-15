import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { GatewaySessionRow } from "../types.ts";
import { executeSlashCommand } from "./slash-command-executor.ts";

function row(key: string, overrides?: Partial<GatewaySessionRow>): GatewaySessionRow {
  return {
    key,
    spawnedBy: overrides?.spawnedBy,
    kind: "direct",
    updatedAt: null,
    ...overrides,
  };
}

describe("executeSlashCommand /kill", () => {
  it("aborts every sub-agent session for /kill all", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("main"),
            row("agent:main:subagent:one", { spawnedBy: "main" }),
            row("agent:main:subagent:parent", { spawnedBy: "main" }),
            row("agent:main:subagent:parent:subagent:child", {
              spawnedBy: "agent:main:subagent:parent",
            }),
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

    expect(result.content).toBe("Aborted 3 sub-agent sessions.");
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
    expect(request).toHaveBeenNthCalledWith(2, "chat.abort", {
      sessionKey: "agent:main:subagent:one",
    });
    expect(request).toHaveBeenNthCalledWith(3, "chat.abort", {
      sessionKey: "agent:main:subagent:parent",
    });
    expect(request).toHaveBeenNthCalledWith(4, "chat.abort", {
      sessionKey: "agent:main:subagent:parent:subagent:child",
    });
  });

  it("aborts matching sub-agent sessions for /kill <agentId>", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:subagent:one", { spawnedBy: "agent:main:main" }),
            row("agent:main:subagent:two", { spawnedBy: "agent:main:main" }),
            row("agent:other:subagent:three", { spawnedBy: "agent:other:main" }),
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
            row("agent:main:subagent:parent", { spawnedBy: "agent:main:main" }),
            row("agent:main:subagent:parent:subagent:child", {
              spawnedBy: "agent:main:subagent:parent",
            }),
            row("agent:main:subagent:sibling", { spawnedBy: "agent:main:main" }),
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
          sessions: [
            row("agent:main:subagent:one", { spawnedBy: "agent:main:main" }),
            row("agent:main:subagent:two", { spawnedBy: "agent:main:main" }),
          ],
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
            row("agent:main:subagent:one", { spawnedBy: "agent:main:main" }),
            row("agent:main:subagent:two", { spawnedBy: "agent:main:main" }),
            row("agent:other:subagent:three", { spawnedBy: "agent:other:main" }),
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

  it("does not abort unrelated same-agent subagents from another root session", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:main"),
            row("agent:main:subagent:mine", { spawnedBy: "agent:main:main" }),
            row("agent:main:subagent:mine:subagent:child", {
              spawnedBy: "agent:main:subagent:mine",
            }),
            row("agent:main:subagent:other-root", {
              spawnedBy: "agent:main:discord:dm:alice",
            }),
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
      sessionKey: "agent:main:subagent:mine",
    });
    expect(request).toHaveBeenNthCalledWith(3, "chat.abort", {
      sessionKey: "agent:main:subagent:mine:subagent:child",
    });
  });
});

describe("executeSlashCommand /model subcommands", () => {
  it("treats /model status as an info query, not a model name", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          defaults: { model: "default-model" },
          sessions: [
            row("agent:main:main", {
              model: "openai-codex/gpt-5.4",
            }),
          ],
        };
      }
      if (method === "models.list") {
        return {
          models: [{ id: "openai-codex/gpt-5.4" }],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "model",
      "status",
    );

    // Should show current model info, NOT try to set the model to "status"
    expect(result.content).toContain("Current model:");
    expect(result.content).toContain("openai-codex/gpt-5.4");
    // Ensure sessions.patch was never called
    expect(request).not.toHaveBeenCalledWith(
      "sessions.patch",
      expect.objectContaining({ model: "status" }),
    );
  });

  it("treats /model list as an info query", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          defaults: { model: "default-model" },
          sessions: [row("agent:main:main", { model: "gpt-4.1" })],
        };
      }
      if (method === "models.list") {
        return { models: [{ id: "gpt-4.1" }, { id: "gpt-4.1-mini" }] };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "model",
      "list",
    );

    expect(result.content).toContain("Current model:");
    expect(request).not.toHaveBeenCalledWith(
      "sessions.patch",
      expect.objectContaining({ model: "list" }),
    );
  });

  it("treats /model info as an info query", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          defaults: { model: "default-model" },
          sessions: [row("agent:main:main", { model: "gpt-4.1" })],
        };
      }
      if (method === "models.list") {
        return { models: [{ id: "gpt-4.1" }] };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "model",
      "info",
    );

    expect(result.content).toContain("Current model:");
    expect(request).not.toHaveBeenCalledWith(
      "sessions.patch",
      expect.objectContaining({ model: "info" }),
    );
  });

  it("sets a real model name via sessions.patch (regression)", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.patch") {
        return { ok: true };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "model",
      "gpt-4.1",
    );

    expect(result.content).toContain("gpt-4.1");
    expect(request).toHaveBeenCalledWith(
      "sessions.patch",
      expect.objectContaining({ model: "gpt-4.1" }),
    );
  });
});

describe("executeSlashCommand directives", () => {
  it("resolves the legacy main alias for bare /model", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          defaults: { model: "default-model" },
          sessions: [
            row("agent:main:main", {
              model: "gpt-4.1-mini",
            }),
          ],
        };
      }
      if (method === "models.list") {
        return {
          models: [{ id: "gpt-4.1-mini" }, { id: "gpt-4.1" }],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "model",
      "",
    );

    expect(result.content).toBe(
      "**Current model:** `gpt-4.1-mini`\n**Available:** `gpt-4.1-mini`, `gpt-4.1`",
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
    expect(request).toHaveBeenNthCalledWith(2, "models.list", {});
  });

  it("resolves the legacy main alias for /usage", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:main", {
              model: "gpt-4.1-mini",
              inputTokens: 1200,
              outputTokens: 300,
              totalTokens: 1500,
              contextTokens: 4000,
            }),
          ],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "usage",
      "",
    );

    expect(result.content).toBe(
      "**Session Usage**\nInput: **1.2k** tokens\nOutput: **300** tokens\nTotal: **1.5k** tokens\nContext: **30%** of 4k\nModel: `gpt-4.1-mini`",
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
  });

  it("reports the current thinking level for bare /think", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:main", {
              modelProvider: "openai",
              model: "gpt-4.1-mini",
            }),
          ],
        };
      }
      if (method === "models.list") {
        return {
          models: [{ id: "gpt-4.1-mini", provider: "openai", reasoning: true }],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "think",
      "",
    );

    expect(result.content).toBe(
      "Current thinking level: low.\nOptions: off, minimal, low, medium, high, adaptive.",
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
    expect(request).toHaveBeenNthCalledWith(2, "models.list", {});
  });

  it("accepts minimal and xhigh thinking levels", async () => {
    const request = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true });

    const minimal = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "think",
      "minimal",
    );
    const xhigh = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "think",
      "xhigh",
    );

    expect(minimal.content).toBe("Thinking level set to **minimal**.");
    expect(xhigh.content).toBe("Thinking level set to **xhigh**.");
    expect(request).toHaveBeenNthCalledWith(1, "sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "minimal",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "xhigh",
    });
  });

  it("reports the current verbose level for bare /verbose", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [row("agent:main:main", { verboseLevel: "full" })],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "verbose",
      "",
    );

    expect(result.content).toBe("Current verbose level: full.\nOptions: on, full, off.");
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
  });

  it("reports the current fast mode for bare /fast", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [row("agent:main:main", { fastMode: true })],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "fast",
      "",
    );

    expect(result.content).toBe("Current fast mode: on.\nOptions: status, on, off.");
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
  });

  it("patches fast mode for /fast on", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "fast",
      "on",
    );

    expect(result.content).toBe("Fast mode enabled.");
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      fastMode: true,
    });
  });
});
