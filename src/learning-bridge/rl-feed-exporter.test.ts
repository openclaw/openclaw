import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchEventV1 } from "../research/events/types.js";
import * as utils from "../utils.js";
import { exportLearningBridgeRun } from "./index.js";
import { classifyResearchEvents } from "./reward-classifier.js";
import { resolveRlFeedRoot, writeRlFeedPackage } from "./rl-feed-exporter.js";
import { buildTrajectoryPackage } from "./trajectory-packager.js";

let tmpRoot = "";

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lb-"));
  vi.spyOn(utils, "resolveConfigDir").mockReturnValue(tmpRoot);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function baseEvent(
  partial: Omit<ResearchEventV1, "v" | "ts" | "runId" | "sessionId" | "agentId"> &
    Pick<ResearchEventV1, "kind" | "payload">,
): ResearchEventV1 {
  return {
    v: 1,
    ts: 1,
    runId: "r1",
    sessionId: "s1",
    agentId: "a1",
    ...partial,
  } as ResearchEventV1;
}

describe("writeRlFeedPackage", () => {
  it("writes three artifacts under rl-feed/", async () => {
    const raw = [
      baseEvent({ kind: "run.start", payload: {} }),
      baseEvent({
        kind: "tool.end",
        payload: { toolName: "exec", toolCallId: "c1", ok: false },
      }),
      baseEvent({ kind: "run.end", payload: {} }),
    ];
    const enriched = classifyResearchEvents(raw);
    const pkg = buildTrajectoryPackage({
      packageId: "test-pkg",
      agentId: "a1",
      runId: "r1",
      sessionId: "s1",
      createdAtMs: 1000,
      enrichedEvents: enriched,
    });
    await writeRlFeedPackage({
      cfg: { research: { enabled: true, learningBridge: { enabled: true } } } as never,
      pkg,
    });
    const root = await resolveRlFeedRoot({
      research: { enabled: true, learningBridge: { enabled: true } },
    } as never);
    const traj = await fs.readFile(path.join(root, "trajectories", "test-pkg.jsonl"), "utf8");
    expect(traj).toContain('"role":"tool"');
    const rewards = JSON.parse(
      await fs.readFile(path.join(root, "rewards", "test-pkg.json"), "utf8"),
    ) as { signals: unknown[] };
    expect(rewards.signals.length).toBeGreaterThan(0);
    const meta = JSON.parse(
      await fs.readFile(path.join(root, "metadata", "test-pkg.meta.json"), "utf8"),
    ) as { packageId: string; turnCount: number };
    expect(meta.packageId).toBe("test-pkg");
    expect(meta.turnCount).toBeGreaterThan(0);
  });

  it("rejects outputDir outside state directory", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-out-"));
    await expect(
      resolveRlFeedRoot({
        research: {
          enabled: true,
          learningBridge: { enabled: true, outputDir: outside },
        },
      } as never),
    ).rejects.toThrow();
    await fs.rm(outside, { recursive: true, force: true });
  });
});

describe("exportLearningBridgeRun", () => {
  it("is a no-op when learning bridge is disabled", async () => {
    await exportLearningBridgeRun({
      cfg: { research: { enabled: true, learningBridge: { enabled: false } } } as never,
      runId: "r1",
      sessionId: "s1",
      agentId: "a1",
      events: [
        baseEvent({
          kind: "tool.end",
          payload: { toolName: "exec", toolCallId: "c1", ok: false },
        }),
      ],
      packageId: "noop-pkg",
    });
    const rlPath = path.join(tmpRoot, "rl-feed");
    await expect(fs.stat(rlPath)).rejects.toThrow();
  });

  it("writes contentScrubbed in trajectories when exportScrubbedContent is enabled", async () => {
    const pkgId = "scrubbed-pkg";
    await exportLearningBridgeRun({
      cfg: {
        research: { enabled: true, learningBridge: { enabled: true, exportScrubbedContent: true } },
      } as never,
      runId: "r1",
      sessionId: "s1",
      agentId: "a1",
      packageId: pkgId,
      events: [
        baseEvent({
          kind: "llm.request",
          payload: { promptScrubbed: "PROMPT_SCRUBBED" },
        }),
        baseEvent({
          kind: "llm.response",
          payload: { responseScrubbed: "RESPONSE_SCRUBBED" },
        }),
      ],
    });

    const trajPath = path.join(tmpRoot, "rl-feed", "trajectories", `${pkgId}.jsonl`);
    const traj = await fs.readFile(trajPath, "utf8");
    const lines = traj
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { role: string; contentScrubbed?: string });

    const user = lines.find((l) => l.role === "user");
    const assistant = lines.find((l) => l.role === "assistant");
    expect(user).toBeDefined();
    expect(assistant).toBeDefined();
    expect(user?.contentScrubbed).toBe("PROMPT_SCRUBBED");
    expect(assistant?.contentScrubbed).toBe("RESPONSE_SCRUBBED");
  });
});
