import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedPiRunResult } from "../../agents/pi-embedded-runner/types.js";

const runEmbeddedPiAgentMock =
  vi.fn<(params: { prompt?: string }) => Promise<EmbeddedPiRunResult>>();

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (params: { prompt?: string }) => runEmbeddedPiAgentMock(params),
}));

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: async (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<EmbeddedPiRunResult>;
  }) => ({
    provider: params.provider,
    model: params.model,
    result: await params.run(params.provider, params.model),
  }),
}));

import { runRlmHarness } from "./harness-rlm.js";

function resultWithText(text: string): EmbeddedPiRunResult {
  return {
    payloads: [{ text }],
    meta: { durationMs: 1, stopReason: "stop" },
  };
}

function resultEmpty(stopReason = "stop"): EmbeddedPiRunResult {
  return {
    payloads: [],
    meta: { durationMs: 1, stopReason },
  };
}

async function withHarnessRun(
  run: (ctx: { sessionFile: string; workspaceDir: string; agentDir: string }) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rlm-test-"));
  const sessionFile = path.join(root, "session.jsonl");
  await fs.writeFile(sessionFile, "", "utf8");
  try {
    await run({
      sessionFile,
      workspaceDir: root,
      agentDir: root,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("harness-rlm behavior", () => {
  beforeEach(() => {
    runEmbeddedPiAgentMock.mockReset();
  });

  it("does not emit unhandledRejection when REPL code forgets to await llm_query", async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", handler);

    try {
      runEmbeddedPiAgentMock.mockImplementation(async ({ prompt }) => {
        const depth = Number(/Depth:\s*(\d+)\//.exec(String(prompt ?? ""))?.[1] ?? "0");
        if (depth === 0) {
          return resultWithText('```js\nllm_query("child");\nsubmit("OK");\n```');
        }
        if (depth === 1) {
          return resultWithText('```js\nsubmit("CHILD");\n```');
        }
        throw new Error(`Unexpected depth ${depth}`);
      });

      await withHarnessRun(async (ctx) => {
        const out = await runRlmHarness({
          cfg: undefined,
          provider: "openai-codex",
          model: "gpt-5.3-codex",
          agentDir: ctx.agentDir,
          workspaceDir: ctx.workspaceDir,
          sessionId: "sess",
          sessionFile: ctx.sessionFile,
          timeoutMs: 20_000,
          runId: "run",
          maxDepth: 2,
          userPrompt: "root",
        });
        expect(out.result.payloads?.[0]?.text).toBe("OK");
      });
    } finally {
      process.off("unhandledRejection", handler);
    }

    expect(unhandled).toHaveLength(0);
  });

  it("does not emit unhandledRejection when submit rejects and REPL code does not await it", async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", handler);

    try {
      let calls = 0;
      runEmbeddedPiAgentMock.mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          // Template literal coercion => "[object Object]" which should be rejected by submit().
          return resultWithText("```js\nsubmit(`${({a: 1})}`);\n```");
        }
        return resultWithText('```js\nsubmit("SAFE_AFTER_SUBMIT_ERROR");\n```');
      });

      await withHarnessRun(async (ctx) => {
        const out = await runRlmHarness({
          cfg: undefined,
          provider: "openai-codex",
          model: "gpt-5.3-codex",
          agentDir: ctx.agentDir,
          workspaceDir: ctx.workspaceDir,
          sessionId: "sess",
          sessionFile: ctx.sessionFile,
          timeoutMs: 20_000,
          runId: "run",
          maxDepth: 0,
          userPrompt: "root",
        });
        expect(out.result.payloads?.[0]?.text).toBe("SAFE_AFTER_SUBMIT_ERROR");
        expect(calls).toBe(2);
      });
    } finally {
      process.off("unhandledRejection", handler);
    }

    expect(unhandled).toHaveLength(0);
  });

  it("awaits Promise submit values so final answer is not [object Promise]", async () => {
    runEmbeddedPiAgentMock.mockImplementation(async ({ prompt }) => {
      const depth = Number(/Depth:\s*(\d+)\//.exec(String(prompt ?? ""))?.[1] ?? "0");
      if (depth === 0) {
        return resultWithText('```js\nsubmit(llm_query("child"));\n```');
      }
      if (depth === 1) {
        return resultWithText('```js\nsubmit("OK");\n```');
      }
      throw new Error(`Unexpected depth ${depth}`);
    });

    await withHarnessRun(async (ctx) => {
      const out = await runRlmHarness({
        cfg: undefined,
        provider: "openai-codex",
        model: "gpt-5.3-codex",
        agentDir: ctx.agentDir,
        workspaceDir: ctx.workspaceDir,
        sessionId: "sess",
        sessionFile: ctx.sessionFile,
        timeoutMs: 20_000,
        runId: "run",
        maxDepth: 2,
        userPrompt: "root",
      });
      expect(out.result.payloads?.[0]?.text).toBe("OK");
      expect(out.result.payloads?.[0]?.text).not.toBe("[object Promise]");
    });
  });

  it("retries empty step outputs and succeeds on a later retry", async () => {
    let calls = 0;
    runEmbeddedPiAgentMock.mockImplementation(async ({ prompt }) => {
      calls += 1;
      if (calls === 1) {
        return resultEmpty("empty");
      }
      expect(String(prompt ?? "")).toContain("Retry 1/5");
      return resultWithText('```js\nsubmit("DONE");\n```');
    });

    await withHarnessRun(async (ctx) => {
      const out = await runRlmHarness({
        cfg: undefined,
        provider: "openai-codex",
        model: "gpt-5.3-codex",
        agentDir: ctx.agentDir,
        workspaceDir: ctx.workspaceDir,
        sessionId: "sess",
        sessionFile: ctx.sessionFile,
        timeoutMs: 20_000,
        runId: "run",
        maxDepth: 0,
        userPrompt: "root",
      });
      expect(out.result.payloads?.[0]?.text).toBe("DONE");
      expect(calls).toBe(2);
    });
  });

  it("rejects [object Promise] sentinel answers and continues", async () => {
    let calls = 0;
    runEmbeddedPiAgentMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return resultWithText('```js\nsubmit("[object Promise]");\n```');
      }
      return resultWithText('```js\nsubmit("SAFE");\n```');
    });

    await withHarnessRun(async (ctx) => {
      const out = await runRlmHarness({
        cfg: undefined,
        provider: "openai-codex",
        model: "gpt-5.3-codex",
        agentDir: ctx.agentDir,
        workspaceDir: ctx.workspaceDir,
        sessionId: "sess",
        sessionFile: ctx.sessionFile,
        timeoutMs: 20_000,
        runId: "run",
        maxDepth: 0,
        userPrompt: "root",
      });
      expect(out.result.payloads?.[0]?.text).toBe("SAFE");
      expect(calls).toBe(2);
    });
  });

  it("rejects [object Object] sentinel answers and continues", async () => {
    let calls = 0;
    runEmbeddedPiAgentMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return resultWithText('```js\nsubmit("[object Object]");\n```');
      }
      return resultWithText('```js\nsubmit("SAFE_OBJECT");\n```');
    });

    await withHarnessRun(async (ctx) => {
      const out = await runRlmHarness({
        cfg: undefined,
        provider: "openai-codex",
        model: "gpt-5.3-codex",
        agentDir: ctx.agentDir,
        workspaceDir: ctx.workspaceDir,
        sessionId: "sess",
        sessionFile: ctx.sessionFile,
        timeoutMs: 20_000,
        runId: "run",
        maxDepth: 0,
        userPrompt: "root",
      });
      expect(out.result.payloads?.[0]?.text).toBe("SAFE_OBJECT");
      expect(calls).toBe(2);
    });
  });

  it("uses extract fallback when iteration limit is reached", async () => {
    let calls = 0;
    runEmbeddedPiAgentMock.mockImplementation(async ({ prompt }) => {
      calls += 1;
      const text = String(prompt ?? "");
      if (text.includes("RLM extract fallback activated")) {
        return resultWithText("EXTRACTED_FINAL");
      }
      return resultWithText("```js\nconst x = 1;\n```");
    });

    await withHarnessRun(async (ctx) => {
      const out = await runRlmHarness({
        cfg: undefined,
        provider: "openai-codex",
        model: "gpt-5.3-codex",
        agentDir: ctx.agentDir,
        workspaceDir: ctx.workspaceDir,
        sessionId: "sess",
        sessionFile: ctx.sessionFile,
        timeoutMs: 20_000,
        runId: "run",
        maxDepth: 0,
        maxIterations: 1,
        userPrompt: "root",
      });
      expect(out.result.payloads?.[0]?.text).toBe("EXTRACTED_FINAL");
      expect(calls).toBe(2);
      expect(out.result.meta?.stopReason).toContain("rlm:extract");
    });
  });

  it("fails with diagnostics after empty-step retries are exhausted", async () => {
    let calls = 0;
    runEmbeddedPiAgentMock.mockImplementation(async () => {
      calls += 1;
      return resultEmpty("error");
    });

    await withHarnessRun(async (ctx) => {
      await expect(
        runRlmHarness({
          cfg: undefined,
          provider: "openai-codex",
          model: "gpt-5.3-codex",
          agentDir: ctx.agentDir,
          workspaceDir: ctx.workspaceDir,
          sessionId: "sess",
          sessionFile: ctx.sessionFile,
          timeoutMs: 20_000,
          runId: "run",
          maxDepth: 0,
          userPrompt: "root",
        }),
      ).rejects.toThrow(/RLM step returned empty model output\..*stopReason=error/);
    });
    expect(calls).toBe(6);
  });

  it("retries transient connection errors thrown by the model runner", async () => {
    let calls = 0;
    runEmbeddedPiAgentMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error("Connection error.");
        throw err;
      }
      return resultWithText('```js\nsubmit("RECOVERED");\n```');
    });

    await withHarnessRun(async (ctx) => {
      const out = await runRlmHarness({
        cfg: undefined,
        provider: "openai",
        model: "gpt-4",
        agentDir: ctx.agentDir,
        workspaceDir: ctx.workspaceDir,
        sessionId: "sess",
        sessionFile: ctx.sessionFile,
        timeoutMs: 20_000,
        runId: "run",
        maxDepth: 0,
        userPrompt: "root",
      });
      expect(out.result.payloads?.[0]?.text).toBe("RECOVERED");
      expect(calls).toBe(2);
    });
  });

  it("retries errors with network error codes", async () => {
    let calls = 0;
    runEmbeddedPiAgentMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error("connect ECONNREFUSED 127.0.0.1:443");
        (err as Error & { code: string }).code = "ECONNREFUSED";
        throw err;
      }
      return resultWithText('```js\nsubmit("OK_AFTER_ECONNREFUSED");\n```');
    });

    await withHarnessRun(async (ctx) => {
      const out = await runRlmHarness({
        cfg: undefined,
        provider: "openai",
        model: "gpt-4",
        agentDir: ctx.agentDir,
        workspaceDir: ctx.workspaceDir,
        sessionId: "sess",
        sessionFile: ctx.sessionFile,
        timeoutMs: 20_000,
        runId: "run",
        maxDepth: 0,
        userPrompt: "root",
      });
      expect(out.result.payloads?.[0]?.text).toBe("OK_AFTER_ECONNREFUSED");
      expect(calls).toBe(2);
    });
  });

  it("exposes repo_search and repo_read primitives for workspace-backed tasks", async () => {
    runEmbeddedPiAgentMock.mockResolvedValue(
      resultWithText(
        [
          "```js",
          'const hits = await repo_search("alpha", 5);',
          "if (!hits.length) {",
          '  submit("NO_HITS");',
          "} else {",
          "  const first = await repo_read(hits[0].path, 0, 120);",
          "  submit(`${hits[0].path}|${first?.text ?? ''}`);",
          "}",
          "```",
        ].join("\n"),
      ),
    );

    await withHarnessRun(async (ctx) => {
      await fs.mkdir(path.join(ctx.workspaceDir, "src"), { recursive: true });
      await fs.writeFile(
        path.join(ctx.workspaceDir, "src", "alpha-policy.txt"),
        "alpha rule one",
        "utf8",
      );
      await fs.writeFile(
        path.join(ctx.workspaceDir, "src", "beta-policy.txt"),
        "beta rule two",
        "utf8",
      );

      const out = await runRlmHarness({
        cfg: undefined,
        provider: "openai-codex",
        model: "gpt-5.3-codex",
        agentDir: ctx.agentDir,
        workspaceDir: ctx.workspaceDir,
        sessionId: "sess",
        sessionFile: ctx.sessionFile,
        timeoutMs: 20_000,
        runId: "run",
        maxDepth: 0,
        userPrompt: "root",
      });
      expect(out.result.payloads?.[0]?.text).toContain("src/alpha-policy.txt");
      expect(out.result.payloads?.[0]?.text).toContain("alpha rule one");
    });
  });

  it("accepts explicit object shorthand for runtime text inputs", async () => {
    runEmbeddedPiAgentMock.mockResolvedValue(
      resultWithText(
        [
          "```js",
          'const hits = await repo_search({ query: "alpha" }, 5);',
          'const goodRead = await repo_read({ path: "src/alpha-policy.txt" }, 0, 20);',
          'set_var({ key: "coerced" }, "ok");',
          'const val = get_var({ key: "coerced" });',
          'submit(`${hits.length > 0}|${(goodRead?.text ?? "").includes("alpha")}|${val === "ok"}`);',
          "```",
        ].join("\n"),
      ),
    );

    await withHarnessRun(async (ctx) => {
      await fs.mkdir(path.join(ctx.workspaceDir, "src"), { recursive: true });
      await fs.writeFile(
        path.join(ctx.workspaceDir, "src", "alpha-policy.txt"),
        "alpha rule one",
        "utf8",
      );

      const out = await runRlmHarness({
        cfg: undefined,
        provider: "openai-codex",
        model: "gpt-5.3-codex",
        agentDir: ctx.agentDir,
        workspaceDir: ctx.workspaceDir,
        sessionId: "sess",
        sessionFile: ctx.sessionFile,
        timeoutMs: 20_000,
        runId: "run",
        maxDepth: 0,
        userPrompt: "root",
      });
      expect(out.result.payloads?.[0]?.text).toBe("true|true|true");
    });
  });

  it("does not expose Node.js globals (process, require, Buffer) in VM sandbox", async () => {
    runEmbeddedPiAgentMock.mockResolvedValue(
      resultWithText(
        [
          "```js",
          "const results = [",
          '  typeof process === "undefined",',
          '  typeof require === "undefined",',
          '  typeof Buffer === "undefined",',
          '  typeof global === "undefined",',
          '  typeof globalThis === "undefined" || globalThis === this,',
          '  typeof module === "undefined",',
          '  typeof __filename === "undefined",',
          '  typeof __dirname === "undefined",',
          "].join(',');",
          "submit(results);",
          "```",
        ].join("\n"),
      ),
    );

    await withHarnessRun(async (ctx) => {
      const out = await runRlmHarness({
        cfg: undefined,
        provider: "openai-codex",
        model: "gpt-5.3-codex",
        agentDir: ctx.agentDir,
        workspaceDir: ctx.workspaceDir,
        sessionId: "sess",
        sessionFile: ctx.sessionFile,
        timeoutMs: 20_000,
        runId: "run",
        maxDepth: 0,
        userPrompt: "root",
      });
      const answer = out.result.payloads?.[0]?.text ?? "";
      // Every check should be "true" — no Node.js globals leak into sandbox
      for (const val of answer.split(",")) {
        expect(val).toBe("true");
      }
    });
  });

  it("rejects invalid object shapes for runtime text inputs", async () => {
    runEmbeddedPiAgentMock.mockResolvedValue(
      resultWithText(
        [
          "```js",
          "try {",
          '  await repo_search({ q: "alpha" }, 5);',
          '  submit("unexpected-success");',
          "} catch (err) {",
          '  submit(String((err && err.message) || err).includes(\'expects text or an object containing "query"\') ? "ok" : "bad-error");',
          "}",
          "```",
        ].join("\n"),
      ),
    );

    await withHarnessRun(async (ctx) => {
      const out = await runRlmHarness({
        cfg: undefined,
        provider: "openai-codex",
        model: "gpt-5.3-codex",
        agentDir: ctx.agentDir,
        workspaceDir: ctx.workspaceDir,
        sessionId: "sess",
        sessionFile: ctx.sessionFile,
        timeoutMs: 20_000,
        runId: "run",
        maxDepth: 0,
        userPrompt: "root",
      });
      expect(out.result.payloads?.[0]?.text).toBe("ok");
    });
  });
});
