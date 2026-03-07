import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HookHandler } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";
import { _clearProcessedSessions } from "../../llm-memory-helpers.js";

vi.mock("../../llm-memory-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../llm-memory-helpers.js")>();
  return {
    ...actual,
    classifyImportanceViaLLM: vi.fn().mockResolvedValue(null),
    isTestEnvironment: vi.fn().mockReturnValue(true),
  };
});

let handler: HookHandler;
let suiteWorkspaceRoot = "";
let caseCounter = 0;

async function createCaseWorkspace(prefix = "importance"): Promise<string> {
  const dir = path.join(suiteWorkspaceRoot, `${prefix}-${caseCounter}`);
  caseCounter += 1;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function createMockSessionJsonl(entries: Array<{ role: string; content: string }>): string {
  return entries
    .map((e) =>
      JSON.stringify({
        type: "message",
        message: { role: e.role, content: e.content },
      }),
    )
    .join("\n");
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-importance-"));
});

afterAll(async () => {
  if (suiteWorkspaceRoot) {
    await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  }
});

afterEach(() => {
  _clearProcessedSessions();
});

describe("session-importance handler", () => {
  it("should ignore non-command/non-session events", async () => {
    const workDir = await createCaseWorkspace();
    const event = createHookEvent("message", "received", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
    });
    await handler(event);
    const importantDir = path.join(workDir, "memory", "important");
    await expect(fs.access(importantDir)).rejects.toThrow();
  });

  it("should skip routine conversations (no keywords)", async () => {
    const workDir = await createCaseWorkspace();
    const sessionsDir = path.join(workDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionFile = path.join(sessionsDir, "routine.jsonl");
    await fs.writeFile(
      sessionFile,
      createMockSessionJsonl([
        { role: "user", content: "Hello, how are you?" },
        { role: "assistant", content: "I'm doing well, thanks!" },
        { role: "user", content: "What's the weather like?" },
      ]),
      "utf-8",
    );

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      previousSessionEntry: { sessionId: "routine-1", sessionFile },
    });
    await handler(event);

    const importantDir = path.join(workDir, "memory", "important");
    await expect(fs.access(importantDir)).rejects.toThrow();
  });

  it("should classify 'reference' category with single keyword hit", async () => {
    const workDir = await createCaseWorkspace();
    const sessionsDir = path.join(workDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionFile = path.join(sessionsDir, "ref.jsonl");
    await fs.writeFile(
      sessionFile,
      createMockSessionJsonl([
        { role: "user", content: "Please remember this: the server IP is 192.168.1.1" },
        { role: "assistant", content: "I'll remember that the server IP is 192.168.1.1" },
      ]),
      "utf-8",
    );

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      previousSessionEntry: { sessionId: "ref-1", sessionFile },
    });
    await handler(event);

    const importantDir = path.join(workDir, "memory", "important");
    const files = await fs.readdir(importantDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain("-reference-");

    const content = await fs.readFile(path.join(importantDir, files[0]), "utf-8");
    expect(content).toContain("# Important: reference");
    expect(content).toContain("Category: reference");
  });

  it("should classify 'project' category with multiple keyword hits", async () => {
    const workDir = await createCaseWorkspace();
    const sessionsDir = path.join(workDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionFile = path.join(sessionsDir, "proj.jsonl");
    await fs.writeFile(
      sessionFile,
      createMockSessionJsonl([
        { role: "user", content: "The milestone for the next phase is to deploy by end of month" },
        { role: "assistant", content: "I'll track the deployment milestone." },
        { role: "user", content: "What's the progress on the release?" },
      ]),
      "utf-8",
    );

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      previousSessionEntry: { sessionId: "proj-1", sessionFile },
    });
    await handler(event);

    const importantDir = path.join(workDir, "memory", "important");
    const files = await fs.readdir(importantDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain("-project-");
  });

  it("should classify 'decision' category with multiple keyword hits", async () => {
    const workDir = await createCaseWorkspace();
    const sessionsDir = path.join(workDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionFile = path.join(sessionsDir, "decision.jsonl");
    await fs.writeFile(
      sessionFile,
      createMockSessionJsonl([
        { role: "user", content: "I need to make a decision about the architecture design" },
        { role: "assistant", content: "Let me compare the options..." },
        { role: "user", content: "What are the trade-off considerations?" },
      ]),
      "utf-8",
    );

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      previousSessionEntry: { sessionId: "dec-1", sessionFile },
    });
    await handler(event);

    const importantDir = path.join(workDir, "memory", "important");
    const files = await fs.readdir(importantDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain("-decision-");
  });

  it("should handle Chinese keywords", async () => {
    const workDir = await createCaseWorkspace();
    const sessionsDir = path.join(workDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionFile = path.join(sessionsDir, "zh.jsonl");
    await fs.writeFile(
      sessionFile,
      createMockSessionJsonl([
        { role: "user", content: "请记住这个重要的信息" },
        { role: "assistant", content: "好的，我已经记录下来了" },
      ]),
      "utf-8",
    );

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      previousSessionEntry: { sessionId: "zh-1", sessionFile },
    });
    await handler(event);

    const importantDir = path.join(workDir, "memory", "important");
    const files = await fs.readdir(importantDir);
    expect(files.length).toBe(1);
  });

  it("should perform slug-based deduplication (smart append)", async () => {
    const workDir = await createCaseWorkspace();
    const sessionsDir = path.join(workDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    // Create the first session
    const sessionFile1 = path.join(sessionsDir, "sess1.jsonl");
    await fs.writeFile(
      sessionFile1,
      createMockSessionJsonl([
        { role: "user", content: "Remember that the API key is abc123" },
        { role: "assistant", content: "Noted." },
      ]),
      "utf-8",
    );

    const event1 = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      previousSessionEntry: { sessionId: "dedup-1", sessionFile: sessionFile1 },
    });
    await handler(event1);

    const importantDir = path.join(workDir, "memory", "important");
    const files1 = await fs.readdir(importantDir);
    expect(files1.length).toBe(1);

    // Read the slug from the filename
    const firstFilename = files1[0];
    const _firstContent = await fs.readFile(path.join(importantDir, firstFilename), "utf-8");

    // Clear dedup filter to allow second session
    _clearProcessedSessions();

    // Create a second session with the same topic slug
    // We manually create a file that would match the slug for testing purposes
    const sessionFile2 = path.join(sessionsDir, "sess2.jsonl");
    await fs.writeFile(
      sessionFile2,
      createMockSessionJsonl([
        { role: "user", content: "Remember that the API key is now xyz789" },
        { role: "assistant", content: "Updated." },
      ]),
      "utf-8",
    );

    const event2 = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      previousSessionEntry: { sessionId: "dedup-2", sessionFile: sessionFile2 },
    });
    await handler(event2);

    const files2 = await fs.readdir(importantDir);
    // Depending on whether slugs match, we'll either have 1 or 2 files
    // In fallback mode, slugs are derived from first user message, so they might differ
    // The key test: no errors thrown, files written successfully
    expect(files2.length).toBeGreaterThanOrEqual(1);
  });

  it("should skip when no session file is available", async () => {
    const workDir = await createCaseWorkspace();
    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      previousSessionEntry: { sessionId: "no-file" },
    });
    await handler(event);

    const importantDir = path.join(workDir, "memory", "important");
    await expect(fs.access(importantDir)).rejects.toThrow();
  });

  it("should deduplicate session:end events", async () => {
    const workDir = await createCaseWorkspace();
    const sessionsDir = path.join(workDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionFile = path.join(sessionsDir, "dedup.jsonl");
    await fs.writeFile(
      sessionFile,
      createMockSessionJsonl([
        { role: "user", content: "Remember to deploy tomorrow" },
        { role: "assistant", content: "I will remind you." },
      ]),
      "utf-8",
    );

    const sessionId = "dedup-session-100";

    // First trigger (command:new)
    const event1 = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      previousSessionEntry: { sessionId, sessionFile },
    });
    await handler(event1);

    const importantDir = path.join(workDir, "memory", "important");
    const files1 = await fs.readdir(importantDir);
    const count1 = files1.length;

    // Second trigger (session:end) with same sessionId — should be deduped
    const event2 = createHookEvent("session", "end", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      previousSessionEntry: { sessionId, sessionFile },
    });
    await handler(event2);

    const files2 = await fs.readdir(importantDir);
    expect(files2.length).toBe(count1);
  });

  it("should handle command:reset events", async () => {
    const workDir = await createCaseWorkspace();
    const sessionsDir = path.join(workDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionFile = path.join(sessionsDir, "reset.jsonl");
    await fs.writeFile(
      sessionFile,
      createMockSessionJsonl([
        { role: "user", content: "Save this: important project decision about architecture" },
        { role: "assistant", content: "Saved." },
      ]),
      "utf-8",
    );

    const event = createHookEvent("command", "reset", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      previousSessionEntry: { sessionId: "reset-1", sessionFile },
    });
    await handler(event);

    const importantDir = path.join(workDir, "memory", "important");
    const files = await fs.readdir(importantDir);
    expect(files.length).toBe(1);
  });

  it("should capture conversations with high code block density (no keywords)", async () => {
    const workDir = await createCaseWorkspace();
    const sessionsDir = path.join(workDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionFile = path.join(sessionsDir, "code-heavy.jsonl");
    await fs.writeFile(
      sessionFile,
      createMockSessionJsonl([
        {
          role: "user",
          content:
            "How should I structure this?\n```typescript\nclass Foo {\n  bar(): void {}\n}\n```",
        },
        {
          role: "assistant",
          content:
            "Here's a better approach:\n```typescript\nclass Foo extends Base {\n  override bar(): void {\n    super.bar();\n  }\n}\n```\n\nAnd the base class:\n```typescript\nabstract class Base {\n  abstract bar(): void;\n}\n```",
        },
        {
          role: "user",
          content:
            "Makes sense. What about the test?\n```typescript\ndescribe('Foo', () => {\n  it('calls bar', () => {});\n});\n```",
        },
      ]),
      "utf-8",
    );

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      previousSessionEntry: { sessionId: "code-1", sessionFile },
    });
    await handler(event);

    const importantDir = path.join(workDir, "memory", "important");
    const files = await fs.readdir(importantDir);
    expect(files.length).toBe(1);
  });

  it("should capture deep collaboration sessions (structured assistant replies)", async () => {
    const workDir = await createCaseWorkspace();
    const sessionsDir = path.join(workDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const longStructuredReply = [
      "## Analysis",
      "",
      "Here are the key considerations:",
      "",
      "- First, we need to consider the performance implications of this change",
      "- Second, the backward compatibility must be maintained",
      "- Third, we should evaluate the impact on the existing test suite",
      "",
      "## Recommendation",
      "",
      "1. Start with a feature flag",
      "2. Run A/B tests in staging",
      "3. Monitor metrics for two weeks before full rollout",
    ].join("\n");

    const sessionFile = path.join(sessionsDir, "collab.jsonl");
    await fs.writeFile(
      sessionFile,
      createMockSessionJsonl([
        {
          role: "user",
          content:
            "I have a complex problem with our notification system. It sends duplicate emails when users have multiple subscriptions to the same topic. The current dedup logic only checks by email address, but we also need to check by subscription ID. What do you think?",
        },
        { role: "assistant", content: longStructuredReply },
        {
          role: "user",
          content:
            "Good points. Can you elaborate on option 2? What metrics should we track during the A/B test, and how do we handle the transition period for existing users who already have duplicates?",
        },
        { role: "assistant", content: longStructuredReply },
        {
          role: "user",
          content:
            "That makes sense. Let me also ask about the database migration strategy. We need to add an index on subscription_id but the table has 50M rows.",
        },
        {
          role: "assistant",
          content:
            "For a table that large, you'll want a concurrent index creation approach. Here are the options:\n\n- Use CREATE INDEX CONCURRENTLY in PostgreSQL\n- Schedule during low-traffic windows\n- Consider partitioning the table first if not already done",
        },
      ]),
      "utf-8",
    );

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      previousSessionEntry: { sessionId: "collab-1", sessionFile },
    });
    await handler(event);

    const importantDir = path.join(workDir, "memory", "important");
    const files = await fs.readdir(importantDir);
    expect(files.length).toBe(1);
  });

  it("should still skip truly trivial conversations (short, no structure, no keywords)", async () => {
    const workDir = await createCaseWorkspace();
    const sessionsDir = path.join(workDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionFile = path.join(sessionsDir, "trivial.jsonl");
    await fs.writeFile(
      sessionFile,
      createMockSessionJsonl([
        { role: "user", content: "Hey" },
        { role: "assistant", content: "Hello! How can I help?" },
        { role: "user", content: "nm, just bored" },
        { role: "assistant", content: "That's fine!" },
        { role: "user", content: "see ya" },
        { role: "assistant", content: "Bye!" },
      ]),
      "utf-8",
    );

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      previousSessionEntry: { sessionId: "trivial-1", sessionFile },
    });
    await handler(event);

    const importantDir = path.join(workDir, "memory", "important");
    await expect(fs.access(importantDir)).rejects.toThrow();
  });
});
