import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeRuntime,
  mockSessionsConfig,
  runSessionsJson,
  writeStore,
} from "./sessions.test-helpers.js";

// Disable colors for deterministic snapshots.
process.env.FORCE_COLOR = "0";

mockSessionsConfig();

vi.mock("../agents/tools-effective-inventory.js", () => ({
  resolveEffectiveToolInventory: vi.fn(() => ({
    agentId: "main",
    profile: "coding",
    groups: [
      {
        id: "core",
        label: "Built-in tools",
        source: "core",
        tools: [
          { id: "exec", label: "Exec", description: "Run shell commands", rawDescription: "Run shell commands", source: "core" },
          { id: "read", label: "Read", description: "Read files", rawDescription: "Read files", source: "core" },
        ],
      },
    ],
  })),
}));

import { sessionsCommand } from "./sessions.js";

describe("sessionsCommand", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-06T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a tabular view with token percentages", async () => {
    const store = writeStore({
      "+15555550123": {
        sessionId: "abc123",
        updatedAt: Date.now() - 45 * 60_000,
        inputTokens: 1200,
        outputTokens: 800,
        totalTokens: 2000,
        totalTokensFresh: true,
        model: "pi:opus",
      },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCommand({ store }, runtime);

    fs.rmSync(store);

    const tableHeader = logs.find((line) => line.includes("Tokens (ctx %"));
    expect(tableHeader).toBeTruthy();

    const row = logs.find((line) => line.includes("+15555550123")) ?? "";
    expect(row).toContain("2.0k/32k (6%)");
    expect(row).toContain("45m ago");
    expect(row).toContain("pi:opus");
  });

  it("shows placeholder rows when tokens are missing", async () => {
    const store = writeStore({
      "discord:group:demo": {
        sessionId: "xyz",
        updatedAt: Date.now() - 5 * 60_000,
        thinkingLevel: "high",
      },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCommand({ store }, runtime);

    fs.rmSync(store);

    const row = logs.find((line) => line.includes("discord:group:demo")) ?? "";
    expect(row).toContain("unknown/32k (?%)");
    expect(row).toContain("think:high");
    expect(row).toContain("5m ago");
  });

  it("exports freshness metadata in JSON output", async () => {
    const store = writeStore({
      main: {
        sessionId: "abc123",
        updatedAt: Date.now() - 10 * 60_000,
        inputTokens: 1200,
        outputTokens: 800,
        totalTokens: 2000,
        totalTokensFresh: true,
        model: "pi:opus",
      },
      "discord:group:demo": {
        sessionId: "xyz",
        updatedAt: Date.now() - 5 * 60_000,
        inputTokens: 20,
        outputTokens: 10,
        model: "pi:opus",
      },
    });

    const payload = await runSessionsJson<{
      sessions?: Array<{
        key: string;
        totalTokens: number | null;
        totalTokensFresh: boolean;
      }>;
    }>(sessionsCommand, store);
    const main = payload.sessions?.find((row) => row.key === "main");
    const group = payload.sessions?.find((row) => row.key === "discord:group:demo");
    expect(main?.totalTokens).toBe(2000);
    expect(main?.totalTokensFresh).toBe(true);
    expect(group?.totalTokens).toBeNull();
    expect(group?.totalTokensFresh).toBe(false);
  });

  it("applies --active filtering in JSON output", async () => {
    const store = writeStore(
      {
        recent: {
          sessionId: "recent",
          updatedAt: Date.now() - 5 * 60_000,
          model: "pi:opus",
        },
        stale: {
          sessionId: "stale",
          updatedAt: Date.now() - 45 * 60_000,
          model: "pi:opus",
        },
      },
      "sessions-active",
    );

    const payload = await runSessionsJson<{
      sessions?: Array<{
        key: string;
      }>;
    }>(sessionsCommand, store, { active: "10" });
    expect(payload.sessions?.map((row) => row.key)).toEqual(["recent"]);
  });

  it("rejects invalid --active values", async () => {
    const store = writeStore(
      {
        demo: {
          sessionId: "demo",
          updatedAt: Date.now() - 5 * 60_000,
        },
      },
      "sessions-active-invalid",
    );
    const { runtime, errors } = makeRuntime();

    await expect(sessionsCommand({ store, active: "0" }, runtime)).rejects.toThrow("exit 1");
    expect(errors[0]).toContain("--active must be a positive integer");

    fs.rmSync(store);
  });

  it("explains effective resolution for a stored session in JSON", async () => {
    const store = writeStore(
      {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now() - 5 * 60_000,
          modelProvider: "openai-codex",
          model: "gpt-5.4",
          modelOverride: "gpt-5.4",
          spawnedWorkspaceDir: "/tmp/subagent-workspace",
        },
      },
      "sessions-explain",
    );

    const payload = await runSessionsJson<{
      key: string;
      agentId: string;
      defaults: { provider: string; model: string };
      input: { runtimeProvider: string | null; spawnedWorkspaceDir: string | null };
      resolved: { model: string; workspaceDir: string };
      resolution: { usesPersistedWorkspace: boolean };
      tools: { profile: string; groups: Array<{ id: string; count: number; tools: string[] }> };
    }>(sessionsCommand, store, { explain: "agent:main:main" });

    expect(payload.key).toBe("agent:main:main");
    expect(payload.agentId).toBe("main");
    expect(payload.input.runtimeProvider).toBe("openai-codex");
    expect(payload.input.spawnedWorkspaceDir).toBe("/tmp/subagent-workspace");
    expect(payload.resolved.model).toBe("gpt-5.4");
    expect(payload.resolved.workspaceDir).toBe("/tmp/subagent-workspace");
    expect(payload.resolution.usesPersistedWorkspace).toBe(true);
    expect(payload.tools.profile).toBe("coding");
    expect(payload.tools.groups).toMatchObject([{ id: "core", count: 2, tools: ["exec", "read"] }]);
  });

  it("renders a readable text explanation for one session", async () => {
    const store = writeStore(
      {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now() - 5 * 60_000,
          modelProvider: "openai-codex",
          model: "gpt-5.4",
          modelOverride: "gpt-5.4",
          spawnedWorkspaceDir: "/tmp/subagent-workspace",
        },
      },
      "sessions-explain-text",
    );

    const { runtime, logs } = makeRuntime();
    await sessionsCommand({ store, explain: "agent:main:main" }, runtime);
    fs.rmSync(store);

    expect(logs.find((line) => line.includes("Session key"))).toBeTruthy();
    expect(logs.find((line) => line.includes("Final model"))).toBeTruthy();
    expect(logs.find((line) => line.includes("Final workspace"))).toBeTruthy();
    expect(logs.find((line) => line.includes("Tools profile"))).toBeTruthy();
    expect(logs.find((line) => line.includes("Tools core"))).toBeTruthy();
  });
});
