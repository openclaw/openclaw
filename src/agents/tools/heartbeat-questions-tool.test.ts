import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseHeartbeatQuestionDocument } from "../../infra/heartbeat-questions.js";
import { resolveCoreToolFactoryFamily } from "../core-tool-factory-descriptors.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createHeartbeatTools } from "./heartbeat-questions-tool.js";

const QUESTION_CONFIG = vi.hoisted((): OpenClawConfig => ({
  agents: {
    defaults: {
      decisionModel: "typesafe/jev-1.13.0",
      experimental: { decisionAssistance: true },
      heartbeat: { mode: "questions" },
    },
  },
}));
const mocks = vi.hoisted(() => ({
  config: QUESTION_CONFIG,
  read: vi.fn(),
  write: vi.fn(),
}));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: () => mocks.config }));
vi.mock("../../cron/scratch-store.js", () => ({
  readHeartbeatMonitorScratch: mocks.read,
  writeCronJobScratch: mocks.write,
}));
vi.mock("../../cron/store.js", () => ({
  resolveCronJobsStorePathFromConfig: () => "/isolated/cron",
}));

function run(
  args: Record<string, unknown>,
  options: { active?: () => boolean; agentId?: string; signal?: AbortSignal; exec?: boolean } = {},
) {
  return withGatewayToolCallerIdentity(
    {
      agentId: options.agentId ?? "main",
      sessionKey: "agent:main:test",
      operationalRunInstance: { instanceId: "heartbeat-test", runId: "heartbeat-test" },
      turnSourceLocal: true,
      receiptAuthority: options.active ?? (() => true),
    },
    () => {
      const [tool] = createHeartbeatTools(
        "main",
        QUESTION_CONFIG,
        {
          cronCreatorToolAllowlist:
            options.exec === false
              ? []
              : [{ name: "exec", execTarget: { host: "gateway", ask: "always" } }],
          cronCreatorToolAllowlistCaptureRef: {
            value: { version: 1, source: "final-executable-surface" },
          },
        },
        false,
      );
      if (!tool) {
        throw new Error("Missing heartbeat question tool");
      }
      return tool.execute("call", args, options.signal);
    },
  );
}

describe("heartbeat_questions tool", () => {
  beforeEach(() => {
    mocks.config = QUESTION_CONFIG;
    mocks.read.mockReset().mockReturnValue({
      jobId: "monitor-main",
      state: { currentRevision: 4, scratch: { content: "Private monitor notes" } },
    });
    mocks.write.mockReset().mockReturnValue({ ok: true, currentRevision: 5 });
  });

  it.each([
    [undefined, "typesafe/jev-1.13.0", true, false],
    ["questions", undefined, true, false],
    ["questions", "typesafe/jev-1.13.0", undefined, false],
    ["questions", "typesafe/jev-1.13.0", true, true],
  ] as const)(
    "exposes the tool only when mode=%s, decisionModel=%s, and Labs=%s",
    (mode, decisionModel, decisionAssistance, exposed) => {
      const config = {
        agents: {
          defaults: { heartbeat: { mode }, decisionModel, experimental: { decisionAssistance } },
        },
      };
      const names = createHeartbeatTools("main", config, undefined, false).map((tool) => tool.name);
      expect(names).toEqual(exposed ? ["heartbeat_questions"] : []);
      expect(resolveCoreToolFactoryFamily("heartbeat_questions")).toBe("openclaw");
    },
  );

  it("adds a question to its own monitor using CAS and preserves private notes", async () => {
    const result = await run({
      action: "upsert",
      id: "deploy",
      commands: ["deployment-status"],
      questions: [{ id: "blocked", question: "Is deployment blocked?" }],
    });
    expect(mocks.read).toHaveBeenCalledWith("/isolated/cron", "main");
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "monitor-main", expectedRevision: 4 }),
    );
    const parsed = parseHeartbeatQuestionDocument(mocks.write.mock.calls[0]?.[0]?.content);
    expect(parsed).toMatchObject({
      status: "valid",
      document: {
        notes: "Private monitor notes",
        groups: [
          {
            id: "deploy",
            commands: ["deployment-status"],
            questions: [{ id: "blocked", question: "Is deployment blocked?" }],
          },
        ],
      },
    });
    if (parsed.status === "invalid") {
      throw new Error(parsed.error);
    }
    expect(parsed.document.groups[0]?.execution.scheduledToolPolicy.execTarget).toEqual({
      host: "gateway",
      ask: "always",
    });
    expect(result.details).toEqual({
      groups: [
        {
          id: "deploy",
          commands: ["deployment-status"],
          questions: [{ id: "blocked", question: "Is deployment blocked?" }],
        },
      ],
      revision: 5,
    });
    expect(JSON.stringify(result)).not.toContain("Private monitor notes");
  });

  it("lists without writing and reports conflicting writes for retry", async () => {
    expect((await run({ action: "list" })).details).toEqual({ groups: [], revision: 4 });
    expect(mocks.write).not.toHaveBeenCalled();
    mocks.write.mockReturnValue({ ok: false, currentRevision: 6, reason: "revision-conflict" });
    await expect(run({ action: "remove", id: "deploy" })).rejects.toThrow("changed concurrently");
  });

  it("rejects disabled mode, missing monitors, and malformed documents without changing scratch", async () => {
    mocks.config = {};
    await expect(run({ action: "remove", id: "deploy" })).rejects.toThrow("decisionModel");
    mocks.config = {
      agents: { defaults: { ...QUESTION_CONFIG.agents?.defaults, decisionModel: undefined } },
    };
    await expect(run({ action: "remove", id: "deploy" })).rejects.toThrow("decisionModel");
    mocks.config = QUESTION_CONFIG;
    mocks.read.mockReturnValue(undefined);
    await expect(run({ action: "remove", id: "deploy" })).rejects.toThrow("monitor is missing");
    mocks.read.mockReturnValue({
      jobId: "monitor-main",
      state: {
        currentRevision: 4,
        scratch: { content: '{"kind":"openclaw-heartbeat-questions","version":2}' },
      },
    });
    await expect(run({ action: "remove", id: "deploy" })).rejects.toThrow(
      "Invalid heartbeat question document",
    );
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("fences mismatched agents, cancellation, and authority lost during preparation", async () => {
    const args = {
      action: "upsert",
      id: "deploy",
      commands: ["status"],
      questions: [{ id: "blocked", question: "Blocked?" }],
    };
    await expect(run(args, { agentId: "other" })).rejects.toThrow("owning agent");
    await expect(run(args, { signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(run(args, { exec: false })).rejects.toThrow("authorized tool surface");
    let checks = 0;
    await expect(run(args, { active: () => ++checks === 1 })).rejects.toThrow(
      "authority is no longer active",
    );
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
