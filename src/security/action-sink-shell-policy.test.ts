import { describe, expect, it } from "vitest";
import { classifyShellCommand } from "./action-sink-shell-policy.js";

describe("shell command classifier", () => {
  it("classifies safe read-only command", () => {
    expect(classifyShellCommand({ command: "git status --short" })).toMatchObject({
      highRisk: false,
      riskTags: ["safe_readonly"],
    });
  });

  it("classifies unknown commands", () => {
    expect(classifyShellCommand({ command: "custom-deployer arg" }).riskTags).toContain(
      "unknown_command",
    );
  });

  it("covers redirection heredoc and tee writes", () => {
    expect(classifyShellCommand({ command: "echo hi > file" }).riskTags).toContain("redirection");
    expect(classifyShellCommand({ command: "cat <<EOF\nhi\nEOF" }).riskTags).toContain("heredoc");
    expect(classifyShellCommand({ command: "echo hi | tee file" }).riskTags).toContain(
      "pipe_to_mutator",
    );
  });

  it("covers inline scripts and wrappers", () => {
    expect(
      classifyShellCommand({ command: 'node -e \'require("fs").writeFileSync("x","y")\'' })
        .riskTags,
    ).toContain("inline_script");
    expect(classifyShellCommand({ command: "bash -c 'rm x'" }).riskTags).toContain("shell_wrapper");
  });

  it("covers chains traversal mutators and network/external clients", () => {
    expect(classifyShellCommand({ command: "find . -exec rm {} \\;" }).riskTags).toContain(
      "find_exec",
    );
    expect(classifyShellCommand({ command: "git add . && git commit -m x" }).riskTags).toContain(
      "compound",
    );
    expect(
      classifyShellCommand({ command: "curl -X POST https://example.test" }).riskTags,
    ).toContain("network_write");
  });

  it("does not classify loopback-only curl checks as external network", () => {
    const checks = [
      "curl -fsS http://127.0.0.1:3001/api/health | head -c 300",
      "curl -fsS http://localhost:18789/api/health",
      "curl -g -fsS 'http://[::1]:18789/api/health'",
    ];

    for (const command of checks) {
      expect(classifyShellCommand({ command }).riskTags).not.toContain("network_write");
    }
  });

  it("keeps mixed loopback and external curl commands classified as external network", () => {
    expect(
      classifyShellCommand({
        command: "curl -fsS http://127.0.0.1:3001/api/health https://example.test",
      }).riskTags,
    ).toContain("network_write");
  });
});
