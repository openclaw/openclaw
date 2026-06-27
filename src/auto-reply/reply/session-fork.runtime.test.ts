// Tests session fork runtime behavior and copied session artifacts.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  forkSessionFromParentRuntime,
  resolveParentForkTokenCountRuntime,
} from "./session-fork.runtime.js";

const roots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("resolveParentForkTokenCountRuntime", () => {
  it("falls back to recent transcript usage when cached totals are stale", async () => {
    const root = await makeRoot("openclaw-parent-fork-token-estimate-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const sessionId = "parent-overflow-transcript";
    const sessionFile = path.join(sessionsDir, "parent.jsonl");
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      }),
    ];
    for (let index = 0; index < 40; index += 1) {
      const body = `turn-${index} ${"x".repeat(200)}`;
      lines.push(
        JSON.stringify({
          type: "message",
          id: `u${index}`,
          parentId: index === 0 ? null : `a${index - 1}`,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: body },
        }),
        JSON.stringify({
          type: "message",
          id: `a${index}`,
          parentId: `u${index}`,
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            content: body,
            usage: index === 39 ? { input: 90_000, output: 20_000 } : undefined,
          },
        }),
      );
    }
    await fs.writeFile(sessionFile, `${lines.join("\n")}\n`, "utf-8");

    const entry: SessionEntry = {
      sessionId,
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 1,
      totalTokensFresh: false,
    };

    const tokens = await resolveParentForkTokenCountRuntime({
      parentEntry: entry,
      storePath: path.join(root, "sessions.json"),
    });

    expect(tokens).toBe(110_000);
  });

  it("falls back to a conservative byte estimate when stale parent transcript has no usage", async () => {
    const root = await makeRoot("openclaw-parent-fork-byte-estimate-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const sessionId = "parent-no-usage-transcript";
    const sessionFile = path.join(sessionsDir, "parent.jsonl");
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      }),
    ];
    for (let index = 0; index < 24; index += 1) {
      lines.push(
        JSON.stringify({
          type: "message",
          id: `u${index}`,
          parentId: index === 0 ? null : `a${index - 1}`,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: `turn-${index} ${"x".repeat(24_000)}` },
        }),
      );
    }
    await fs.writeFile(sessionFile, `${lines.join("\n")}\n`, "utf-8");

    const entry: SessionEntry = {
      sessionId,
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    const tokens = await resolveParentForkTokenCountRuntime({
      parentEntry: entry,
      storePath: path.join(root, "sessions.json"),
    });

    expect(tokens).toBeGreaterThan(100_000);
  });

  it("uses the latest usage snapshot instead of tail aggregates for parent fork checks", async () => {
    const root = await makeRoot("openclaw-parent-fork-latest-usage-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const sessionId = "parent-multiple-usage-transcript";
    const sessionFile = path.join(sessionsDir, "parent.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: "older",
            usage: { input: 60_000, output: 5_000 },
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: "latest",
            usage: { input: 70_000, output: 8_000 },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const entry: SessionEntry = {
      sessionId,
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    const tokens = await resolveParentForkTokenCountRuntime({
      parentEntry: entry,
      storePath: path.join(root, "sessions.json"),
    });

    expect(tokens).toBe(78_000);
  });

  it("keeps parent fork checks conservative for content appended after latest usage", async () => {
    const root = await makeRoot("openclaw-parent-fork-post-usage-tail-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const sessionId = "parent-post-usage-tail";
    const sessionFile = path.join(sessionsDir, "parent.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: "latest model call",
            usage: { input: 40_000, output: 2_000 },
          },
        }),
        JSON.stringify({
          message: {
            role: "tool",
            content: `large appended tool result ${"x".repeat(450_000)}`,
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const entry: SessionEntry = {
      sessionId,
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    const tokens = await resolveParentForkTokenCountRuntime({
      parentEntry: entry,
      storePath: path.join(root, "sessions.json"),
    });

    expect(tokens).toBeGreaterThan(100_000);
  });
});

describe("forkSessionFromParentRuntime", () => {
  it("forks the active branch without synchronously opening the session manager", async () => {
    const root = await makeRoot("openclaw-parent-fork-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(cwd);
    const parentSessionId = "parent-session";
    const lines = [
      {
        type: "session",
        version: 3,
        id: parentSessionId,
        timestamp: "2026-05-01T00:00:00.000Z",
        cwd,
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-05-01T00:00:01.000Z",
        message: { role: "user", content: "hello" },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-05-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.4",
          stopReason: "stop",
          timestamp: 2,
        },
      },
      {
        type: "label",
        id: "label-1",
        parentId: "assistant-1",
        timestamp: "2026-05-01T00:00:03.000Z",
        targetId: "user-1",
        label: "start",
      },
      {
        type: "message",
        id: "delivery-side-branch",
        parentId: "label-1",
        timestamp: "2026-05-01T00:00:04.000Z",
        message: { role: "assistant", content: "side delivery" },
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "delivery-side-branch",
        timestamp: "2026-05-01T00:00:05.000Z",
        targetId: "label-1",
      },
    ];
    await fs.writeFile(
      parentSessionFile,
      `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf-8",
    );

    const fork = await forkSessionFromParentRuntime({
      parentEntry: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
      agentId: "main",
      sessionsDir,
    });

    if (fork === null) {
      throw new Error("Expected forked session");
    }
    expect(fork.sessionFile).toContain(sessionsDir);
    expect(fork.sessionId).not.toBe(parentSessionId);
    const raw = await fs.readFile(fork.sessionFile, "utf-8");
    const forkedEntries = raw
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const resolvedParentSessionFile = await fs.realpath(parentSessionFile);
    const forkedHeader = forkedEntries[0];
    expect(forkedHeader?.type).toBe("session");
    expect(forkedHeader?.id).toBe(fork.sessionId);
    expect(forkedHeader?.cwd).toBe(cwd);
    expect(forkedHeader?.parentSession).toBe(resolvedParentSessionFile);
    expect(forkedEntries.map((entry) => entry.type)).toEqual([
      "session",
      "message",
      "message",
      "label",
      "leaf",
    ]);
    const forkedLabel = forkedEntries.find((entry) => entry.type === "label");
    expect(forkedLabel?.type).toBe("label");
    expect(forkedLabel?.targetId).toBe("user-1");
    expect(forkedLabel?.label).toBe("start");
    expect(forkedEntries.at(-1)).toMatchObject({
      type: "leaf",
      targetId: "label-1",
      appendParentId: "label-1",
    });
    expect(raw).not.toContain("side delivery");
  });

  it("keeps opaque append-parent metadata on the active fork branch", async () => {
    const root = await makeRoot("openclaw-parent-fork-opaque-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const parentSessionId = "parent-opaque";
    const entries = [
      {
        type: "session",
        version: 3,
        id: parentSessionId,
        timestamp: "2026-06-15T00:00:00.000Z",
        cwd: root,
      },
      {
        type: "message",
        id: "active-root",
        parentId: null,
        timestamp: "2026-06-15T00:00:01.000Z",
        message: { role: "assistant", content: "active root" },
      },
      {
        type: "label",
        id: "active-label",
        parentId: "active-root",
        timestamp: "2026-06-15T00:00:01.500Z",
        targetId: "active-root",
        label: "selected",
      },
      {
        type: "message",
        id: "side-delivery",
        parentId: "active-root",
        timestamp: "2026-06-15T00:00:02.000Z",
        message: { role: "assistant", content: "side delivery" },
      },
      {
        type: "metadata",
        id: "plugin-metadata",
        parentId: "side-delivery",
        payload: { source: "plugin" },
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "side-delivery",
        timestamp: "2026-06-15T00:00:03.000Z",
        targetId: "active-root",
        appendParentId: "plugin-metadata",
        appendMode: "side",
      },
    ];
    await fs.writeFile(
      parentSessionFile,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf-8",
    );

    const fork = await forkSessionFromParentRuntime({
      parentEntry: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
      agentId: "main",
      sessionsDir,
    });

    if (!fork) {
      throw new Error("expected forked session");
    }
    const raw = await fs.readFile(fork.sessionFile, "utf-8");
    expect(raw).toContain('"id":"active-root"');
    expect(raw).toContain('"id":"plugin-metadata"');
    expect(raw).not.toContain("side delivery");
    const forkedRecords = raw
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(forkedRecords.find((entry) => entry.id === "plugin-metadata")).toMatchObject({
      parentId: "active-root",
    });
    expect(forkedRecords.find((entry) => entry.type === "label")).toMatchObject({
      targetId: "active-root",
      label: "selected",
    });
    expect(forkedRecords.at(-1)).toMatchObject({
      type: "leaf",
      targetId: "active-root",
      appendParentId: "plugin-metadata",
      appendMode: "side",
    });
    const reopened = SessionManager.open(fork.sessionFile, sessionsDir);
    reopened.appendMessage({ role: "user", content: "continued", timestamp: Date.now() });
    const records = (await fs.readFile(fork.sessionFile, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.at(-1)).toMatchObject({ type: "message", parentId: "plugin-metadata" });
    expect(records.at(-1)).not.toHaveProperty("appendMode");
    expect(reopened.buildSessionContext().messages).toMatchObject([
      { role: "assistant", content: "active root" },
      { role: "user", content: "continued" },
    ]);
  });

  it("keeps parentless visible history with a disjoint append cursor", async () => {
    const root = await makeRoot("openclaw-parent-fork-disjoint-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    await fs.writeFile(
      parentSessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "parent-disjoint",
          timestamp: "2026-06-15T00:00:00.000Z",
          cwd: root,
        },
        {
          type: "message",
          id: "visible-user",
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "user", content: "visible question" },
        },
        {
          type: "message",
          id: "visible-assistant",
          timestamp: "2026-06-15T00:00:02.000Z",
          message: { role: "assistant", content: "visible answer" },
        },
        {
          type: "metadata",
          id: "append-root",
          parentId: null,
          payload: { source: "plugin" },
        },
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "append-root",
          timestamp: "2026-06-15T00:00:03.000Z",
          targetId: "visible-assistant",
          appendParentId: "append-root",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf-8",
    );

    const fork = await forkSessionFromParentRuntime({
      parentEntry: {
        sessionId: "parent-disjoint",
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
      agentId: "main",
      sessionsDir,
    });

    if (!fork) {
      throw new Error("expected forked session");
    }
    const reopened = SessionManager.open(fork.sessionFile, sessionsDir);
    expect(reopened.buildSessionContext().messages).toHaveLength(2);
    reopened.appendMessage({ role: "user", content: "continued", timestamp: Date.now() });
    const raw = await fs.readFile(fork.sessionFile, "utf-8");
    expect(raw).toContain("visible question");
    expect(raw).toContain("visible answer");
    expect(raw).toContain('"id":"append-root"');
    const records = raw
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.at(-1)).toMatchObject({ type: "message", parentId: "append-root" });
  });

  it("keeps an explicit empty visible branch separate from its opaque append parent", async () => {
    const root = await makeRoot("openclaw-parent-fork-empty-opaque-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    await fs.writeFile(
      parentSessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "parent-empty-opaque",
          timestamp: "2026-06-15T00:00:00.000Z",
          cwd: root,
        },
        {
          type: "message",
          id: "inactive-root",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "user", content: "inactive history" },
        },
        {
          type: "leaf",
          id: "empty-leaf",
          parentId: "inactive-root",
          timestamp: "2026-06-15T00:00:02.000Z",
          targetId: null,
          appendParentId: null,
        },
        {
          type: "metadata",
          id: "plugin-metadata",
          parentId: "inactive-root",
          payload: { source: "plugin" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf-8",
    );

    const fork = await forkSessionFromParentRuntime({
      parentEntry: {
        sessionId: "parent-empty-opaque",
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
      agentId: "main",
      sessionsDir,
    });

    if (!fork) {
      throw new Error("expected forked session");
    }
    const reopened = SessionManager.open(fork.sessionFile, sessionsDir);
    expect(reopened.buildSessionContext().messages).toEqual([]);
    const continuedId = reopened.appendMessage({
      role: "user",
      content: "continued",
      timestamp: Date.now(),
    });
    reopened.appendMessage({
      role: "assistant",
      content: "done",
      api: "responses",
      provider: "openai",
      model: "gpt-test",
      timestamp: Date.now(),
    } as unknown as AssistantMessage);
    const records = (await fs.readFile(fork.sessionFile, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.some((record) => record.id === "inactive-root")).toBe(false);
    expect(records.find((record) => record.id === continuedId)).toMatchObject({
      type: "message",
      parentId: "plugin-metadata",
    });
  });

  it("keeps a reachable branch suffix when an older parent is missing", async () => {
    const root = await makeRoot("openclaw-parent-fork-missing-ancestor-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    await fs.writeFile(
      parentSessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "parent-missing-ancestor",
          timestamp: "2026-06-15T00:00:00.000Z",
          cwd: root,
        },
        {
          type: "message",
          id: "reachable-tail",
          parentId: "missing-parent",
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "reachable tail" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf-8",
    );

    const fork = await forkSessionFromParentRuntime({
      parentEntry: {
        sessionId: "parent-missing-ancestor",
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
      agentId: "main",
      sessionsDir,
    });

    if (!fork) {
      throw new Error("expected forked session");
    }
    const raw = await fs.readFile(fork.sessionFile, "utf-8");
    expect(raw).toContain("reachable tail");
    expect(raw).not.toContain("missing-parent");
  });

  it("keeps visible history when the next append explicitly starts a root branch", async () => {
    const root = await makeRoot("openclaw-parent-fork-root-append-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    await fs.writeFile(
      parentSessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "parent-root-append",
          timestamp: "2026-06-15T00:00:00.000Z",
          cwd: root,
        },
        {
          type: "message",
          id: "visible-root",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "visible history" },
        },
        {
          type: "leaf",
          id: "root-append-control",
          parentId: "inactive-tail",
          timestamp: "2026-06-15T00:00:02.000Z",
          targetId: "visible-root",
          appendParentId: null,
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf-8",
    );

    const fork = await forkSessionFromParentRuntime({
      parentEntry: {
        sessionId: "parent-root-append",
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
      agentId: "main",
      sessionsDir,
    });

    if (!fork) {
      throw new Error("expected forked session");
    }
    const reopened = SessionManager.open(fork.sessionFile, sessionsDir);
    expect(reopened.buildSessionContext().messages).toHaveLength(1);
    reopened.appendMessage({ role: "user", content: "new root", timestamp: Date.now() });
    const records = (await fs.readFile(fork.sessionFile, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.at(-1)).toMatchObject({ type: "message", parentId: null });
  });

  it("preserves supported current-version linear transcripts", async () => {
    const root = await makeRoot("openclaw-parent-fork-linear-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    await fs.writeFile(
      parentSessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "parent-linear",
          timestamp: "2026-06-15T00:00:00.000Z",
          cwd: root,
        },
        {
          type: "message",
          id: "linear-user",
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "user", content: "hello" },
        },
        {
          type: "message",
          id: "linear-assistant",
          timestamp: "2026-06-15T00:00:02.000Z",
          message: { role: "assistant", content: "hi" },
        },
        {
          type: "metadata",
          id: "linear-metadata",
          parentId: "linear-assistant",
          payload: { source: "plugin" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf-8",
    );

    const fork = await forkSessionFromParentRuntime({
      parentEntry: {
        sessionId: "parent-linear",
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
      agentId: "main",
      sessionsDir,
    });

    if (!fork) {
      throw new Error("expected forked session");
    }
    const records = (await fs.readFile(fork.sessionFile, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.slice(1)).toMatchObject([
      { id: "linear-user", parentId: null },
      { id: "linear-assistant", parentId: "linear-user" },
      { id: "linear-metadata", parentId: "linear-assistant" },
    ]);
    const reopened = SessionManager.open(fork.sessionFile, sessionsDir);
    expect(reopened.buildSessionContext().messages).toHaveLength(2);
    reopened.appendMessage({ role: "user", content: "continued", timestamp: Date.now() });
    const continuedRecords = (await fs.readFile(fork.sessionFile, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(continuedRecords.at(-1)).toMatchObject({
      type: "message",
      parentId: "linear-metadata",
    });
  });

  it("creates a header-only child when the parent has no entries", async () => {
    const root = await makeRoot("openclaw-parent-fork-empty-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const parentSessionId = "parent-empty";
    await fs.writeFile(
      parentSessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: parentSessionId,
        timestamp: "2026-05-01T00:00:00.000Z",
        cwd: root,
      })}\n`,
      "utf-8",
    );

    const fork = await forkSessionFromParentRuntime({
      parentEntry: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
      agentId: "main",
      sessionsDir,
    });

    if (!fork) {
      throw new Error("expected forked session entry");
    }
    const raw = await fs.readFile(fork.sessionFile, "utf-8");
    const lines = raw.trim().split(/\r?\n/u);
    expect(lines).toHaveLength(1);
    const resolvedParentSessionFile = await fs.realpath(parentSessionFile);
    const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(header.type).toBe("session");
    expect(header.id).toBe(fork.sessionId);
    expect(header.parentSession).toBe(resolvedParentSessionFile);
  });
});
