// Plugin documentation example tests validate plugin snippets from docs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { transform } from "esbuild";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import type {
  AuthorizationInvocationContext,
  AuthorizationPolicyRegistration,
} from "../plugins/authorization-policy.types.js";
import { expectNoReaddirSyncDuring } from "../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../test-utils/repo-files.js";

const PLUGIN_DOCS_DIR = path.join(process.cwd(), "docs", "plugins");
const AUTHORIZATION_POLICY_DOC = path.join(PLUGIN_DOCS_DIR, "authorization-policies.md");

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function listMarkdownFiles(dir: string): string[] {
  const externalFiles = listExternalMarkdownFiles(dir);
  if (externalFiles) {
    return externalFiles;
  }
  return walkMarkdownFiles(dir);
}

function listExternalMarkdownFiles(dir: string): string[] | null {
  const repoPath = toRepoRelativePath(process.cwd(), dir);
  return listGitMarkdownFiles(repoPath) ?? listFindMarkdownFiles(dir);
}

function listGitMarkdownFiles(repoPath: string): string[] | null {
  const files = listGitTrackedFiles({ pathspecs: repoPath });
  if (!files) {
    return null;
  }
  return files
    .filter((line) => line.endsWith(".md"))
    .map((filePath) => path.join(process.cwd(), filePath))
    .toSorted();
}

function listFindMarkdownFiles(dir: string): string[] | null {
  const result = spawnSync("find", [dir, "-type", "f", "-name", "*.md"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .toSorted();
}

function walkMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files;
}

async function loadAuthorizationPolicyExample(): Promise<{
  createMaintainerPolicy: (config: Record<string, unknown>) => AuthorizationPolicyRegistration;
}> {
  const markdown = fs.readFileSync(AUTHORIZATION_POLICY_DOC, "utf8");
  const section = markdown.slice(markdown.indexOf("### Register the policy"));
  const code = /```typescript\n([\s\S]*?)```/u.exec(section)?.[1];
  if (!code) {
    throw new Error("authorization policy TypeScript example is missing");
  }
  const executable = code.replace(
    /import \{[\s\S]*?\} from "openclaw\/plugin-sdk\/plugin-entry";/u,
    "const definePluginEntry = (entry: unknown) => entry;",
  );
  const compiled = await transform(executable, {
    format: "esm",
    loader: "ts",
    target: "es2022",
  });
  const encoded = Buffer.from(compiled.code, "utf8").toString("base64");
  return (await import(`data:text/javascript;base64,${encoded}`)) as {
    createMaintainerPolicy: (config: Record<string, unknown>) => AuthorizationPolicyRegistration;
  };
}

describe("plugin docs examples", () => {
  it("lists plugin docs without scanning directories in-process", () => {
    expectNoReaddirSyncDuring(() => {
      const files = listMarkdownFiles(PLUGIN_DOCS_DIR);

      expect(files.length).toBeGreaterThan(0);
      expect(files.every((filePath) => filePath.endsWith(".md"))).toBe(true);
    });
  });

  it("keeps plugin docs JSON fences parseable", () => {
    const failures: string[] = [];
    for (const docPath of listMarkdownFiles(PLUGIN_DOCS_DIR)) {
      const markdown = fs.readFileSync(docPath, "utf8");
      const blocks = markdown.matchAll(/```(json5|json)\n([\s\S]*?)```/g);
      for (const match of blocks) {
        const lang = match[1] ?? "";
        const code = match[2] ?? "";
        const relativePath = toRepoRelativePath(process.cwd(), docPath);
        const location = `${relativePath}:${lineNumberAt(markdown, match.index ?? 0)}`;
        try {
          if (lang === "json") {
            JSON.parse(code);
          } else {
            JSON5.parse(code);
          }
        } catch (error) {
          failures.push(`${location} ${lang.toUpperCase()} parse failed: ${String(error)}`);
        }
      }
    }
    expect(failures).toStrictEqual([]);
  });

  it("keeps the sender-aware authorization example scoped and fail closed", async () => {
    const { createMaintainerPolicy } = await loadAuthorizationPolicyExample();
    const policy = createMaintainerPolicy({
      targetAgentId: "maintenance-agent",
      provider: "discord",
      accountId: "bot-account",
      conversationIds: ["maintenance"],
      ownerKeys: ["discord:bot-account:owner"],
      maintainerRoleKeys: ["discord:bot-account:maintainer-role"],
      maintainerToolNames: ["read"],
    });
    const context = (
      principal: AuthorizationInvocationContext["principal"],
      overrides: Partial<AuthorizationInvocationContext> = {},
    ): AuthorizationInvocationContext => ({
      principal,
      agentId: "maintenance-agent",
      conversationId: "maintenance",
      ...overrides,
    });
    const maintainer = context({
      kind: "sender",
      provider: "discord",
      accountId: "bot-account",
      senderId: "maintainer",
      isAuthorizedSender: true,
      roleIds: ["maintainer-role"],
    });
    const owner = context({
      kind: "sender",
      provider: "discord",
      accountId: "bot-account",
      senderId: "owner",
      senderIsOwner: true,
    });
    const other = context({
      kind: "sender",
      provider: "discord",
      accountId: "bot-account",
      senderId: "other",
      isAuthorizedSender: true,
    });
    const tool = policy.handlers["tool.call"];
    const message = policy.handlers["message.action"];
    const command = policy.handlers["command.invoke"];
    expect(tool).toBeTypeOf("function");
    expect(message).toBeTypeOf("function");
    expect(command).toBeTypeOf("function");
    if (!tool || !message || !command) {
      throw new Error("authorization example handlers are incomplete");
    }

    const readRequest = {
      operation: "tool.call" as const,
      toolName: "read",
      phase: "final" as const,
      input: {},
    };
    expect(await tool(readRequest, owner, new AbortController().signal)).toEqual({
      effect: "pass",
    });
    expect(await tool(readRequest, maintainer, new AbortController().signal)).toEqual({
      effect: "pass",
    });
    expect(await tool(readRequest, other, new AbortController().signal)).toMatchObject({
      effect: "deny",
    });
    expect(
      await tool(
        readRequest,
        context(maintainer.principal, { agentId: "other" }),
        new AbortController().signal,
      ),
    ).toEqual({ effect: "pass" });
    expect(
      await tool(
        readRequest,
        context(maintainer.principal, { conversationId: "general" }),
        new AbortController().signal,
      ),
    ).toEqual({ effect: "pass" });
    for (const principal of [
      { ...maintainer.principal, provider: "telegram" },
      { ...maintainer.principal, accountId: "other" },
    ]) {
      expect(
        await tool(readRequest, context(principal), new AbortController().signal),
      ).toMatchObject({ effect: "deny" });
    }

    const messageRequest = (target: string, threadId?: string) => ({
      operation: "message.action" as const,
      action: "send",
      channel: "discord",
      accountId: "bot-account",
      target,
      ...(threadId ? { threadId } : {}),
      dryRun: false,
      input: {},
    });
    expect(
      await message(messageRequest("maintenance"), maintainer, new AbortController().signal),
    ).toEqual({ effect: "pass" });
    const threadContext = context(maintainer.principal, {
      conversationId: "thread-1",
      parentConversationId: "maintenance",
    });
    expect(
      await message(
        messageRequest("maintenance", "thread-1"),
        threadContext,
        new AbortController().signal,
      ),
    ).toEqual({ effect: "pass" });
    expect(
      await message(messageRequest("other"), maintainer, new AbortController().signal),
    ).toMatchObject({ effect: "deny" });

    const commandRequest = {
      operation: "command.invoke" as const,
      phase: "final" as const,
      commandName: "fix",
      owner: { kind: "plugin" as const, pluginId: "maintainer-authorization" },
      source: "native" as const,
    };
    expect(await command(commandRequest, maintainer, new AbortController().signal)).toEqual({
      effect: "pass",
    });
    expect(
      await command(
        { ...commandRequest, owner: { kind: "core" } },
        maintainer,
        new AbortController().signal,
      ),
    ).toMatchObject({ effect: "deny" });
    expect(policy.unhandled).toBeUndefined();
  });
});
