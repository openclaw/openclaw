import { describe, expect, it } from "vitest";
import { createInterceptorRegistry } from "../registry.js";
import { trigger } from "../trigger.js";
import { createSecurityAudit } from "./security-audit.js";

describe("security-audit interceptor", () => {
  function run(toolName: string, filePath: string) {
    const registry = createInterceptorRegistry();
    registry.add(createSecurityAudit());
    return trigger(
      registry,
      "tool.before",
      { toolName, toolCallId: "c1" },
      { args: { file_path: filePath } },
    );
  }

  it("blocks reading SSH private keys", async () => {
    const result = await run("read", "/home/user/.ssh/id_rsa");
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain("sensitive data");
  });

  it("blocks reading .aws credentials", async () => {
    const result = await run("read", "/home/user/.aws/credentials");
    expect(result.block).toBe(true);
  });

  it("blocks writing to /etc/shadow", async () => {
    const result = await run("write", "/etc/shadow");
    expect(result.block).toBe(true);
  });

  it("blocks reading .env files", async () => {
    const result = await run("read", "/app/.env");
    expect(result.block).toBe(true);
  });

  it("blocks .pem files", async () => {
    const result = await run("read", "/home/user/server.pem");
    expect(result.block).toBe(true);
  });

  it("blocks credentials.json", async () => {
    const result = await run("read", "/home/user/credentials.json");
    expect(result.block).toBe(true);
  });

  it("allows normal source files", async () => {
    const result = await run("read", "/home/user/project/src/index.ts");
    expect(result.block).toBeUndefined();
  });

  it("allows files in node_modules even if they match patterns", async () => {
    const result = await run("read", "/project/node_modules/some-lib/cert.pem");
    expect(result.block).toBeUndefined();
  });

  it("allows .pem in test fixtures", async () => {
    const result = await run("read", "/project/test/fixtures/mock.pem");
    expect(result.block).toBeUndefined();
  });

  it("allows package-lock.json", async () => {
    const result = await run("read", "/project/package-lock.json");
    expect(result.block).toBeUndefined();
  });

  it("blocks edit on sensitive files", async () => {
    const result = await run("edit", "/home/user/.gnupg/pubring.kbx");
    expect(result.block).toBe(true);
  });

  it("blocks Claude Code credentials", async () => {
    const result = await run("read", "/home/user/.claude/.credentials.json");
    expect(result.block).toBe(true);
  });

  it("blocks OpenClaw credentials directory", async () => {
    const result = await run("read", "/home/user/.openclaw/credentials/oauth.json");
    expect(result.block).toBe(true);
  });

  it("blocks Codex auth file", async () => {
    const result = await run("read", "/home/user/.codex/auth.json");
    expect(result.block).toBe(true);
  });

  it("blocks auth-profiles.json", async () => {
    const result = await run("read", "/home/user/.openclaw/agents/abc/agent/auth-profiles.json");
    expect(result.block).toBe(true);
  });

  it("blocks GitHub Copilot token file", async () => {
    const result = await run("read", "/home/user/.openclaw/credentials/github-copilot.token.json");
    expect(result.block).toBe(true);
  });

  it("blocks shell profile files", async () => {
    expect((await run("read", "/home/user/.bashrc")).block).toBe(true);
    expect((await run("read", "/home/user/.zshrc")).block).toBe(true);
    expect((await run("read", "/home/user/.profile")).block).toBe(true);
    expect((await run("read", "/home/user/.config/fish/config.fish")).block).toBe(true);
  });

  it("blocks Qwen OAuth credentials", async () => {
    const result = await run("read", "/home/user/.qwen/oauth_creds.json");
    expect(result.block).toBe(true);
  });

  it("blocks MiniMax OAuth credentials", async () => {
    const result = await run("read", "/home/user/.minimax/oauth_creds.json");
    expect(result.block).toBe(true);
  });

  it("does not trigger on exec tool", async () => {
    // Security audit only matches read/write/edit, not exec
    const registry = createInterceptorRegistry();
    registry.add(createSecurityAudit());
    const result = await trigger(
      registry,
      "tool.before",
      { toolName: "exec", toolCallId: "c1" },
      { args: { command: "cat /etc/shadow" } },
    );
    // toolMatcher doesn't match exec, so the interceptor doesn't run
    expect(result.block).toBeUndefined();
  });
});
