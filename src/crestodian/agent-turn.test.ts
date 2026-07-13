import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupCrestodianAgentSession,
  createCrestodianAgentSession,
  runCrestodianAgentTurn,
} from "./agent-turn.js";

const mocks = vi.hoisted(() => ({
  runEmbeddedAgent: vi.fn(async (_params: { sessionFile: string }) => ({
    meta: { finalAssistantVisibleText: "ready" },
  })),
}));

vi.mock("../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: mocks.runEmbeddedAgent,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: vi.fn(async () => ({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "hash",
    config: {},
    runtimeConfig: {},
    sourceConfig: {},
    issues: [],
  })),
}));

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runCrestodianAgentTurn", () => {
  it("uses a distinct transcript for each chat session", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "crestodian-turn-"));
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const overview = { defaultModel: "openai/gpt-5.5" } as never;
    const first = createCrestodianAgentSession();
    const second = createCrestodianAgentSession();

    await runCrestodianAgentTurn({
      input: "hello",
      overview,
      surface: "gateway",
      approvalArmed: false,
      session: first,
    });
    await runCrestodianAgentTurn({
      input: "hello",
      overview,
      surface: "gateway",
      approvalArmed: false,
      session: second,
    });

    const firstPath = mocks.runEmbeddedAgent.mock.calls[0]?.[0]?.sessionFile;
    const secondPath = mocks.runEmbeddedAgent.mock.calls[1]?.[0]?.sessionFile;
    expect(firstPath).toContain(`${first.sessionId}.jsonl`);
    expect(secondPath).toContain(`${second.sessionId}.jsonl`);
    expect(firstPath).not.toBe(secondPath);

    await fs.promises.writeFile(firstPath, "transcript");
    await cleanupCrestodianAgentSession(first);
    await expect(fs.promises.access(firstPath)).rejects.toThrow();
  });
});
