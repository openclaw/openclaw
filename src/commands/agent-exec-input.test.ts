import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildExecRunConfig, resolveAgentExecPrompt } from "./agent-exec-input.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("agent exec prompt sources", () => {
  it.each([
    { source: "positional", text: "fix it", expected: "fix it" },
    { source: "file", text: "\uFEFFline one\nline two", expected: "line one\nline two" },
    { source: "stdin", text: "from stdin", expected: "from stdin" },
  ])("reads a $source prompt", async ({ source, text, expected }) => {
    let messageFile = source === "stdin" ? "-" : undefined;
    if (source === "file") {
      messageFile = path.join(tempDirs.make("openclaw-agent-exec-prompt-"), "prompt.md");
      await fs.writeFile(messageFile, text, "utf8");
    }
    await expect(
      resolveAgentExecPrompt(
        source === "positional" ? text : undefined,
        messageFile,
        source === "stdin" ? Readable.from([Buffer.from(text, "utf8")]) : undefined,
      ),
    ).resolves.toBe(expected);
  });
});

describe("agent exec run config layering", () => {
  it("applies coding one-shot defaults when the config leaves them unset", () => {
    const config = buildExecRunConfig({ base: {}, cwd: "/run/here" });
    expect(config.agents?.defaults?.sandbox?.mode).toBe("off");
    expect(config.env?.shellEnv?.enabled).toBe(false);
    expect(config.tools?.profile).toBe("coding");
    expect(config.tools?.fs?.workspaceOnly).toBe(true);
    expect(config.tools?.exec?.host).toBeUndefined();
  });

  it("inherits configured capabilities while pinning workspace and state to the invocation", () => {
    const config = buildExecRunConfig({
      base: {
        env: { shellEnv: { enabled: true } },
        models: { providers: { custom: { baseUrl: "https://example.invalid", models: [] } } },
        tools: { profile: "full", codeMode: { enabled: true, maxOutputBytes: 4096 } },
        session: {
          store: "/persistent/agents/{agentId}/sessions/sessions.json",
          mainKey: "primary",
        },
        agents: {
          defaults: { workspace: "/elsewhere", skipBootstrap: false, sandbox: { mode: "all" } },
          entries: {
            ops: {
              workspace: "/elsewhere",
              agentDir: "/persistent/agents/ops",
              model: "openai/gpt-5.6-sol",
            },
            harness: { runtime: { type: "acp", acp: { agent: "codex", cwd: "/other/repo" } } },
          },
        },
      },
      cwd: "/run/here",
      opts: { localModelLean: true },
    });
    expect(config.agents?.defaults?.workspace).toBe("/run/here");
    expect(config.agents?.defaults?.skipBootstrap).toBe(true);
    expect(config.skills?.load?.watch).toBe(false);
    expect(config.agents?.defaults?.sandbox?.mode).toBe("all");
    expect(config.env?.shellEnv?.enabled).toBe(true);
    expect(config.tools?.profile).toBe("full");
    expect(config.tools?.exec?.host).toBeUndefined();
    expect(config.models?.providers?.custom?.baseUrl).toBe("https://example.invalid");
    expect(config.tools?.codeMode).toEqual({ enabled: true, maxOutputBytes: 4096 });
    expect(config.agents?.defaults?.experimental?.localModelLean).toBe(true);
    expect(config.agents?.entries?.ops?.workspace).toBe("/run/here");
    expect(config.agents?.entries?.ops?.agentDir).toBeUndefined();
    expect(config.agents?.entries?.ops?.model).toBe("openai/gpt-5.6-sol");
    expect(config.session?.store).toBeUndefined();
    expect(config.session?.mainKey).toBe("primary");
    const runtime = config.agents?.entries?.harness?.runtime;
    expect(runtime?.type === "acp" ? runtime.acp?.cwd : "unset").toBeUndefined();
    expect(runtime?.type === "acp" ? runtime.acp?.agent : undefined).toBe("codex");
  });
});
