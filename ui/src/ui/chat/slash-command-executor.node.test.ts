import { describe, expect, it, vi } from "vitest";
import {
  createResolvedModelPatch,
  createModelCatalog,
  DEEPSEEK_CHAT_MODEL,
  OPENAI_GPT5_MINI_MODEL,
} from "../chat-model.test-helpers.ts";
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

function createKillRequest(params: { sessions: GatewaySessionRow[]; aborted?: boolean }) {
  return vi.fn(async (method: string, _payload?: unknown) => {
    if (method === "sessions.list") {
      return { sessions: params.sessions };
    }
    if (method === "chat.abort") {
      return { ok: true, aborted: params.aborted ?? true };
    }
    throw new Error(`unexpected method: ${method}`);
  });
}

function expectAbortCalls(request: ReturnType<typeof vi.fn>, sessionKeys: string[]) {
  expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {});
  for (const [index, sessionKey] of sessionKeys.entries()) {
    expect(request).toHaveBeenNthCalledWith(index + 2, "chat.abort", {
      sessionKey,
    });
  }
}

describe("executeSlashCommand /kill", () => {
  it("aborts every sub-agent session for /kill all", async () => {
    const request = createKillRequest({
      sessions: [
        row("main"),
        row("agent:main:subagent:one", { spawnedBy: "main" }),
        row("agent:main:subagent:parent", { spawnedBy: "main" }),
        row("agent:main:subagent:parent:subagent:child", {
          spawnedBy: "agent:main:subagent:parent",
        }),
        row("agent:other:main"),
      ],
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "kill",
      "all",
    );

    expect(result.content).toBe("Aborted 3 sub-agent sessions.");
    expectAbortCalls(request, [
      "agent:main:subagent:one",
      "agent:main:subagent:parent",
      "agent:main:subagent:parent:subagent:child",
    ]);
  });

  it("aborts matching sub-agent sessions for /kill <agentId>", async () => {
    const request = createKillRequest({
      sessions: [
        row("agent:main:subagent:one", { spawnedBy: "agent:main:main" }),
        row("agent:main:subagent:two", { spawnedBy: "agent:main:main" }),
        row("agent:other:subagent:three", { spawnedBy: "agent:other:main" }),
      ],
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "kill",
      "main",
    );

    expect(result.content).toBe("Aborted 2 matching sub-agent sessions for `main`.");
    expectAbortCalls(request, ["agent:main:subagent:one", "agent:main:subagent:two"]);
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
    const request = createKillRequest({
      sessions: [
        row("agent:main:subagent:one", { spawnedBy: "agent:main:main" }),
        row("agent:main:subagent:two", { spawnedBy: "agent:main:main" }),
      ],
      aborted: false,
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "kill",
      "all",
    );

    expect(result.content).toBe("No active sub-agent runs to abort.");
    expectAbortCalls(request, ["agent:main:subagent:one", "agent:main:subagent:two"]);
  });

  it("treats the legacy main session key as the default agent scope", async () => {
    const request = createKillRequest({
      sessions: [
        row("main"),
        row("agent:main:subagent:one", { spawnedBy: "agent:main:main" }),
        row("agent:main:subagent:two", { spawnedBy: "agent:main:main" }),
        row("agent:other:subagent:three", { spawnedBy: "agent:other:main" }),
      ],
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "kill",
      "all",
    );

    expect(result.content).toBe("Aborted 2 sub-agent sessions.");
    expectAbortCalls(request, ["agent:main:subagent:one", "agent:main:subagent:two"]);
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

describe("executeSlashCommand directives", () => {
  it("resolves the legacy main alias for bare /model", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          defaults: { modelProvider: "openai", model: "default-model" },
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

  it("mirrors resolved provider-qualified model refs after /model changes", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.patch") {
        return createResolvedModelPatch("gpt-5-mini", "openai");
      }
      if (method === "models.list") {
        return { models: createModelCatalog(OPENAI_GPT5_MINI_MODEL) };
      }
      if (method === "models.list") {
        return { models: [{ id: "gpt-5-mini", name: "gpt-5-mini", provider: "openai" }] };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "model",
      "gpt-5-mini",
      {
        chatModelCatalog: [{ id: "gpt-5-mini", name: "gpt-5-mini", provider: "openai" }],
      },
    );

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: "gpt-5-mini",
    });
    expect(result.sessionPatch?.modelOverride).toEqual({
      kind: "qualified",
      value: "openai/gpt-5-mini",
    });
  });

  it("uses the local model catalog to qualify raw /model overrides when the patch response omits provider", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.patch") {
        return {
          ok: true,
          key: "main",
          resolved: {
            model: "gpt-5-mini",
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "model",
      "gpt-5-mini",
      {
        chatModelCatalog: [{ id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" }],
      },
    );

    expect(result.sessionPatch?.modelOverride).toEqual({
      kind: "qualified",
      value: "openai/gpt-5-mini",
    });
  });

  it("corrects stale patched providers with the catalog after /model", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.patch") {
        return createResolvedModelPatch("deepseek-chat", "zai");
      }
      if (method === "models.list") {
        return { models: createModelCatalog(DEEPSEEK_CHAT_MODEL) };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "model",
      "deepseek-chat",
    );

    expect(result.sessionPatch?.modelOverride).toEqual({
      kind: "qualified",
      value: "deepseek/deepseek-chat",
    });
  });

  it("falls back to the patched server provider when catalog lookup fails", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.patch") {
        return createResolvedModelPatch("gpt-5-mini", "openai");
      }
      if (method === "models.list") {
        throw new Error("models unavailable");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "model",
      "gpt-5-mini",
    );

    expect(result.sessionPatch?.modelOverride).toEqual({
      kind: "qualified",
      value: "openai/gpt-5-mini",
    });
  });

  it("reuses a provided model catalog for /model updates without refetching", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.patch") {
        return createResolvedModelPatch("gpt-5-mini", "openai");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "main",
      "model",
      "gpt-5-mini",
      { modelCatalog: createModelCatalog(OPENAI_GPT5_MINI_MODEL) },
    );

    expect(result.sessionPatch?.modelOverride).toEqual({
      kind: "qualified",
      value: "openai/gpt-5-mini",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalledWith("models.list", {});
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

describe("executeSlashCommand /steer (soft inject)", () => {
  it("injects into the current session via chat.send with deliver: false", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return { sessions: [row("agent:main:main")] };
      }
      if (method === "chat.send") {
        return { status: "started", runId: "run-1", messageSeq: 2 };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "steer",
      "try a different approach",
    );

    expect(result.content).toBe("Steered.");
    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        message: "try a different approach",
        deliver: false,
      }),
    );
  });

  it("injects into a matching subagent when the first word resolves to one", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:main"),
            row("agent:main:subagent:einstein", { spawnedBy: "agent:main:main" }),
          ],
        };
      }
      if (method === "chat.send") {
        return { status: "started", runId: "run-2", messageSeq: 1 };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "steer",
      "einstein try a different approach",
    );

    expect(result.content).toBe("Steered `einstein`.");
    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "agent:main:subagent:einstein",
        message: "try a different approach",
        deliver: false,
      }),
    );
  });

  it("returns usage when no message is provided", async () => {
    const request = vi.fn();

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "steer",
      "",
    );

    expect(result.content).toBe("Usage: `/steer [id] <message>`");
    expect(request).not.toHaveBeenCalled();
  });

  it("returns error message on RPC failure", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return { sessions: [row("agent:main:main")] };
      }
      throw new Error("connection lost");
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "steer",
      "try again",
    );

    expect(result.content).toBe("Failed to steer: Error: connection lost");
  });
});

describe("executeSlashCommand /redirect (hard kill-and-restart)", () => {
  it("calls sessions.steer to abort and restart the current session", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return { sessions: [row("agent:main:main")] };
      }
      if (method === "sessions.steer") {
        return { status: "started", runId: "run-1", messageSeq: 2, interruptedActiveRun: true };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "redirect",
      "start over with a new plan",
    );

    expect(result.content).toBe("Redirected.");
    expect(request).toHaveBeenCalledWith("sessions.steer", {
      key: "agent:main:main",
      message: "start over with a new plan",
    });
  });

  it("redirects a matching subagent when the first word resolves to one", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            row("agent:main:main"),
            row("agent:main:subagent:einstein", { spawnedBy: "agent:main:main" }),
          ],
        };
      }
      if (method === "sessions.steer") {
        return { status: "started", runId: "run-2", messageSeq: 1 };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "redirect",
      "einstein start over completely",
    );

    expect(result.content).toBe("Redirected `einstein`.");
    expect(request).toHaveBeenCalledWith("sessions.steer", {
      key: "agent:main:subagent:einstein",
      message: "start over completely",
    });
  });

  it("returns usage when no message is provided", async () => {
    const request = vi.fn();

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "redirect",
      "",
    );

    expect(result.content).toBe("Usage: `/redirect [id] <message>`");
    expect(request).not.toHaveBeenCalled();
  });

  it("returns error message on RPC failure", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "sessions.list") {
        return { sessions: [row("agent:main:main")] };
      }
      throw new Error("connection lost");
    });

    const result = await executeSlashCommand(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "redirect",
      "try again",
    );

    expect(result.content).toBe("Failed to redirect: Error: connection lost");
  });
});
