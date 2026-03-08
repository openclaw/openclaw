import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { runSessionSanitizationHelper } from "./runtime.js";

function createConfig(): OpenClawConfig {
  return {
    memory: {
      sessions: {
        sanitization: {
          enabled: true,
        },
      },
    },
    agents: {
      defaults: {
        sandbox: {
          mode: "non-main",
        },
      },
    },
  };
}

describe("session sanitization helper runtime", () => {
  it("requires a sandboxed helper runtime and exposes only the read tool override", async () => {
    let capturedParams: Record<string, unknown> | undefined;
    const runner = vi.fn(async (params: Record<string, unknown>) => {
      capturedParams = params;
      return {
        payloads: [
          {
            text: JSON.stringify({
              mode: "write",
              decisions: [],
              actionItems: [],
              entities: [],
              discard: true,
            }),
          },
        ],
        meta: { durationMs: 1 },
      };
    });

    await runSessionSanitizationHelper({
      cfg: createConfig(),
      agentId: "main",
      mode: "write",
      runner,
      files: [
        {
          relativePath: "raw-turn.json",
          content: JSON.stringify({ messageId: "m1" }),
        },
      ],
    });

    expect(capturedParams?.toolPolicyOverride).toEqual({ allow: ["read"] });
    expect(capturedParams?.systemPromptOverride).toContain("transcript sanitization helper");
  });

  it("rejects invalid helper JSON and deletes temporary workspace artifacts", async () => {
    let workspaceDir = "";
    const runner = vi.fn(async (params: Record<string, unknown>) => {
      workspaceDir = String(params.workspaceDir ?? "");
      expect(await fs.readFile(path.join(workspaceDir, "mode.json"), "utf8")).toContain("write");
      return {
        payloads: [{ text: "{not json" }],
        meta: { durationMs: 1 },
      };
    });

    await expect(
      runSessionSanitizationHelper({
        cfg: createConfig(),
        agentId: "main",
        mode: "write",
        runner,
        files: [
          {
            relativePath: "mode.json",
            content: JSON.stringify({ mode: "write" }),
          },
        ],
      }),
    ).rejects.toThrow("invalid JSON");

    expect(workspaceDir).not.toBe("");
    await expect(fs.stat(path.dirname(workspaceDir))).rejects.toThrow();
  });

  it("rejects helper outputs that try to emit confidence", async () => {
    const runner = vi.fn(async () => ({
      payloads: [
        {
          text: JSON.stringify({
            mode: "recall",
            result: "hi",
            source: "summary",
            matchedSummaryIds: [],
            usedRawMessageIds: [],
            confidence: "high",
          }),
        },
      ],
      meta: { durationMs: 1 },
    }));

    await expect(
      runSessionSanitizationHelper({
        cfg: createConfig(),
        agentId: "main",
        mode: "recall",
        runner,
        files: [
          {
            relativePath: "mode.json",
            content: JSON.stringify({ mode: "recall", query: "hi" }),
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it("uses mode-specific system prompt schemas", async () => {
    let recallSystemPrompt = "";
    const recallRunner = vi.fn(async (params: Record<string, unknown>) => {
      recallSystemPrompt = String(params.systemPromptOverride ?? "");
      return {
        payloads: [
          {
            text: JSON.stringify({
              mode: "recall",
              result: "ok",
              source: "summary",
              matchedSummaryIds: [],
              usedRawMessageIds: [],
            }),
          },
        ],
        meta: { durationMs: 1 },
      };
    });

    await runSessionSanitizationHelper({
      cfg: createConfig(),
      agentId: "main",
      mode: "recall",
      runner: recallRunner,
      files: [
        {
          relativePath: "mode.json",
          content: JSON.stringify({ mode: "recall", query: "status" }),
        },
      ],
    });

    expect(recallSystemPrompt).toContain('"mode": "recall"');
    expect(recallSystemPrompt).not.toContain('"mode": "mcp"');

    let mcpSystemPrompt = "";
    const mcpRunner = vi.fn(async (params: Record<string, unknown>) => {
      mcpSystemPrompt = String(params.systemPromptOverride ?? "");
      return {
        payloads: [
          {
            text: JSON.stringify({
              mode: "mcp",
              safe: true,
              structuredResult: {},
              flags: [],
              contextNote: "",
            }),
          },
        ],
        meta: { durationMs: 1 },
      };
    });

    await runSessionSanitizationHelper({
      cfg: createConfig(),
      agentId: "main",
      mode: "mcp",
      runner: mcpRunner,
      files: [
        {
          relativePath: "query.json",
          content: JSON.stringify({ tool: "t" }),
        },
        {
          relativePath: "mcp-result.json",
          content: JSON.stringify({ ok: true }),
        },
      ],
    });

    expect(mcpSystemPrompt).toContain('"mode": "mcp"');
    expect(mcpSystemPrompt).toContain('"structuredResult": {}');
  });

  it("fails closed when sandbox isolation is unavailable", async () => {
    await expect(
      runSessionSanitizationHelper({
        cfg: {
          memory: {
            sessions: {
              sanitization: {
                enabled: true,
              },
            },
          },
          agents: {
            defaults: {
              sandbox: {
                mode: "off",
              },
            },
          },
        },
        agentId: "main",
        mode: "signal",
        files: [],
      }),
    ).rejects.toThrow("sandbox isolation unavailable");
  });

  it("does not fail a successful helper run when temp cleanup throws", async () => {
    const rmSpy = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup lock"));
    const runner = vi.fn(async () => ({
      payloads: [
        {
          text: JSON.stringify({
            mode: "write",
            decisions: ["keep"],
            actionItems: [],
            entities: [],
            contextNote: "ok",
            discard: false,
          }),
        },
      ],
      meta: { durationMs: 1 },
    }));

    const result = await runSessionSanitizationHelper({
      cfg: createConfig(),
      agentId: "main",
      mode: "write",
      runner,
      files: [
        {
          relativePath: "raw-turn.json",
          content: JSON.stringify({ messageId: "m1" }),
        },
      ],
    });

    expect(result).toMatchObject({
      mode: "write",
      decisions: ["keep"],
      discard: false,
    });
    rmSpy.mockRestore();
  });
});
