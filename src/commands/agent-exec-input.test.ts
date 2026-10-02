import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildExecRunConfig, resolveAgentExecPrompt } from "./agent-exec-input.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("agent exec prompt sources", () => {
  it("accepts a positional prompt", async () => {
    await expect(resolveAgentExecPrompt("fix it", undefined)).resolves.toBe("fix it");
  });

  it("reads a UTF-8 prompt file", async () => {
    const root = tempDirs.make("openclaw-agent-exec-prompt-");
    const promptPath = path.join(root, "prompt.md");
    await fs.writeFile(promptPath, "\uFEFFline one\nline two", "utf8");

    await expect(resolveAgentExecPrompt(undefined, promptPath)).resolves.toBe("line one\nline two");
  });

  it("reads --message-file - from stdin", async () => {
    const stdin = Readable.from([Buffer.from("from stdin", "utf8")]);
    await expect(resolveAgentExecPrompt(undefined, "-", stdin)).resolves.toBe("from stdin");
  });
});

describe("agent exec run config layering", () => {
  it("keeps the run scoped to the invocation folder over any config", () => {
    const config = buildExecRunConfig({
      base: { agents: { defaults: { workspace: "/elsewhere", skipBootstrap: false } } },
      cwd: "/run/here",
    });

    expect(config.agents?.defaults?.workspace).toBe("/run/here");
    expect(config.agents?.defaults?.skipBootstrap).toBe(true);
    expect(config.skills?.load?.watch).toBe(false);
  });

  it("never downgrades a configured sandbox or shell env to the exec defaults", () => {
    const config = buildExecRunConfig({
      base: {
        env: { shellEnv: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "all" } } },
        tools: { profile: "full" },
      },
      cwd: "/run/here",
    });

    expect(config.agents?.defaults?.sandbox?.mode).toBe("all");
    expect(config.env?.shellEnv?.enabled).toBe(true);
    expect(config.tools?.profile).toBe("full");
  });

  it("applies coding one-shot defaults when the config leaves them unset", () => {
    const config = buildExecRunConfig({ base: {}, cwd: "/run/here" });

    expect(config.agents?.defaults?.sandbox?.mode).toBe("off");
    expect(config.env?.shellEnv?.enabled).toBe(false);
    expect(config.tools?.profile).toBe("coding");
    expect(config.tools?.fs?.workspaceOnly).toBe(true);
  });

  it("leaves exec host routing to the configured sandbox", () => {
    const sandboxed = buildExecRunConfig({
      base: { agents: { defaults: { sandbox: { mode: "all" } } } },
      cwd: "/run/here",
    });

    expect(sandboxed.agents?.defaults?.sandbox?.mode).toBe("all");
    expect(sandboxed.tools?.exec?.host).toBeUndefined();
    expect(buildExecRunConfig({ base: {}, cwd: "/run/here" }).tools?.exec?.host).toBeUndefined();
  });

  it("carries config-owned provider and harness surfaces into the run", () => {
    const config = buildExecRunConfig({
      base: {
        models: { providers: { custom: { baseUrl: "https://example.invalid", models: [] } } },
        tools: { codeMode: { enabled: true } },
      },
      cwd: "/run/here",
    });

    expect(config.models?.providers?.custom?.baseUrl).toBe("https://example.invalid");
    expect(config.tools?.codeMode).toMatchObject({ enabled: true });
  });

  it("pins per-agent workspaces to the invocation folder", () => {
    const config = buildExecRunConfig({
      base: { agents: { entries: { ops: { workspace: "/elsewhere" } } } },
      cwd: "/run/here",
    });

    expect(config.agents?.entries?.ops?.workspace).toBe("/run/here");
  });

  it("drops inherited agent directories so run state stays in the state dir", () => {
    const config = buildExecRunConfig({
      base: {
        agents: {
          entries: { ops: { agentDir: "/persistent/agents/ops", model: "openai/gpt-5.6-sol" } },
        },
      },
      cwd: "/run/here",
    });

    expect(config.agents?.entries?.ops?.agentDir).toBeUndefined();
    // Only the directory is dropped; the rest of the entry is still inherited.
    expect(config.agents?.entries?.ops?.model).toBe("openai/gpt-5.6-sol");
  });

  it("drops an inherited session store so the invocation state dir owns the agent database", () => {
    const config = buildExecRunConfig({
      base: {
        session: {
          store: "/persistent/agents/{agentId}/sessions/sessions.json",
          mainKey: "primary",
        },
      },
      cwd: "/run/here",
    });

    expect(config.session?.store).toBeUndefined();
    expect(config.session?.mainKey).toBe("primary");
  });

  it("drops an inherited harness cwd so --cwd wins", () => {
    const config = buildExecRunConfig({
      base: {
        agents: {
          entries: {
            ops: { runtime: { type: "acp", acp: { agent: "codex", cwd: "/other/repo" } } },
          },
        },
      },
      cwd: "/run/here",
    });

    const runtime = config.agents?.entries?.ops?.runtime;
    expect(runtime?.type === "acp" ? runtime.acp?.cwd : "unset").toBeUndefined();
    // The rest of the harness selection survives.
    expect(runtime?.type === "acp" ? runtime.acp?.agent : undefined).toBe("codex");
  });

  it("keeps Code Mode limits while enabling the lean local-model flag", () => {
    const config = buildExecRunConfig({
      base: { tools: { codeMode: { enabled: true, maxOutputBytes: 4096 } } },
      cwd: "/run/here",
      opts: { localModelLean: true },
    });

    expect(config.tools?.codeMode).toEqual({ enabled: true, maxOutputBytes: 4096 });
    expect(config.agents?.defaults?.experimental?.localModelLean).toBe(true);
  });
});
