import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildCommitmentExtractionPrompt,
  parseCommitmentExtractionOutput,
  persistCommitmentExtractionResult,
  validateCommitmentCandidates,
  validateCommitmentResolutions,
} from "./extraction.js";
import { loadCommitmentStore } from "./store.js";
import type { CommitmentCandidate, CommitmentExtractionItem } from "./types.js";

describe("commitment extraction", () => {
  const tmpDirs: string[] = [];
  const nowMs = Date.parse("2026-04-29T16:00:00.000Z");

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tmpDirs.length = 0;
  });

  async function createConfig(): Promise<OpenClawConfig> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commitments-"));
    tmpDirs.push(tmpDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
    return {
      commitments: {
        enabled: true,
      },
    };
  }

  function item(overrides?: Partial<CommitmentExtractionItem>): CommitmentExtractionItem {
    return {
      itemId: "turn-1",
      nowMs,
      timezone: "America/Los_Angeles",
      agentId: "main",
      sessionKey: "agent:main:telegram:user-1",
      channel: "telegram",
      to: "15551234567",
      userText: "I have an interview tomorrow.",
      assistantText: "Good luck. I hope it goes well.",
      existingPending: [],
      ...overrides,
    };
  }

  function candidate(overrides?: Partial<CommitmentCandidate>): CommitmentCandidate {
    return {
      itemId: "turn-1",
      kind: "event_check_in",
      sensitivity: "routine",
      source: "inferred_user_context",
      reason: "The user said they had an interview tomorrow.",
      suggestedText: "How did the interview go?",
      dedupeKey: "interview:2026-04-30",
      confidence: 0.91,
      dueWindow: {
        earliest: "2026-04-30T17:00:00.000Z",
        latest: "2026-04-30T23:00:00.000Z",
        timezone: "America/Los_Angeles",
      },
      ...overrides,
    };
  }

  function expectSingleValidCandidate(
    valid: ReturnType<typeof validateCommitmentCandidates>,
  ): ReturnType<typeof validateCommitmentCandidates>[number] {
    expect(valid).toHaveLength(1);
    const [entry] = valid;
    if (!entry) {
      throw new Error("Expected one valid commitment candidate");
    }
    return entry;
  }

  it("parses valid candidates from JSON output with surrounding text", () => {
    const parsed = parseCommitmentExtractionOutput(
      `noise {"candidates":[${JSON.stringify(candidate())}]} trailing`,
    );

    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]?.kind).toBe("event_check_in");
    expect(parsed.candidates[0]?.suggestedText).toBe("How did the interview go?");
  });

  it("parses valid resolved pending commitments from JSON output", () => {
    const parsed = parseCommitmentExtractionOutput(
      JSON.stringify({
        candidates: [],
        resolved: [
          {
            itemId: "turn-1",
            dedupeKey: "gmail-reauth:sprichert",
            reason: "The assistant reported the Gmail reauth was completed and verified.",
            confidence: 0.95,
          },
        ],
      }),
    );

    expect(parsed.resolved).toEqual([
      {
        itemId: "turn-1",
        dedupeKey: "gmail-reauth:sprichert",
        reason: "The assistant reported the Gmail reauth was completed and verified.",
        confidence: 0.95,
      },
    ]);
  });

  it("omits routing scope identifiers from extractor prompts", () => {
    const prompt = buildCommitmentExtractionPrompt({
      items: [
        item({
          itemId: "public-item-1",
          agentId: "agent-secret",
          sessionKey: "session-secret",
          channel: "channel-secret",
          accountId: "account-secret",
          to: "+15551234567",
          threadId: "thread-secret",
        }),
      ],
    });

    expect(prompt).toContain("public-item-1");
    expect(prompt).not.toContain("agent-secret");
    expect(prompt).not.toContain("session-secret");
    expect(prompt).not.toContain("channel-secret");
    expect(prompt).not.toContain("account-secret");
    expect(prompt).not.toContain("+15551234567");
    expect(prompt).not.toContain("thread-secret");
  });

  it("asks the extractor to resolve pending commitments closed by later verified turns", () => {
    const prompt = buildCommitmentExtractionPrompt({
      items: [
        item({
          assistantText: "The Gmail reauth completed and I verified the account is working.",
          existingPending: [
            {
              kind: "open_loop",
              reason: "User requested a Gmail reauth link.",
              dedupeKey: "gmail-reauth:sprichert",
              earliestMs: Date.parse("2026-04-30T17:00:00.000Z"),
              latestMs: Date.parse("2026-04-30T23:00:00.000Z"),
            },
          ],
        }),
      ],
    });

    expect(prompt).toContain('"resolved"');
    expect(prompt).toContain("tool-verified completion");
    expect(prompt).toContain("gmail-reauth:sprichert");
  });

  it("rejects disabled, low-confidence, and non-future candidates", () => {
    const cfg: OpenClawConfig = { commitments: { enabled: true } };
    const valid = validateCommitmentCandidates({
      cfg,
      items: [item()],
      result: {
        candidates: [
          candidate(),
          candidate({ dedupeKey: "low-confidence", confidence: 0.5 }),
          candidate({
            dedupeKey: "past",
            dueWindow: { earliest: "2026-04-29T15:00:00.000Z" },
          }),
        ],
      },
    });

    expect(valid.map((entry) => entry.candidate.dedupeKey)).toEqual(["interview:2026-04-30"]);
  });

  it("validates only high-confidence resolutions for existing pending commitments", () => {
    const valid = validateCommitmentResolutions({
      cfg: { commitments: { enabled: true } },
      items: [
        item({
          existingPending: [
            {
              kind: "open_loop",
              reason: "User requested a Gmail reauth link.",
              dedupeKey: "gmail-reauth:sprichert",
              earliestMs: Date.parse("2026-04-30T17:00:00.000Z"),
              latestMs: Date.parse("2026-04-30T23:00:00.000Z"),
            },
          ],
        }),
      ],
      result: {
        candidates: [],
        resolved: [
          {
            itemId: "turn-1",
            dedupeKey: "gmail-reauth:sprichert",
            reason: "The assistant verified reauth completed.",
            confidence: 0.91,
          },
          {
            itemId: "turn-1",
            dedupeKey: "gmail-reauth:other",
            reason: "Not in existing pending list.",
            confidence: 0.99,
          },
          {
            itemId: "turn-1",
            dedupeKey: "gmail-reauth:sprichert",
            reason: "Too uncertain.",
            confidence: 0.5,
          },
        ],
      },
    });

    expect(valid.map((entry) => entry.resolution.dedupeKey)).toEqual(["gmail-reauth:sprichert"]);
  });

  it("clamps inferred due time to at least one heartbeat interval after write time", () => {
    const writeMs = nowMs + 5_000;
    const valid = validateCommitmentCandidates({
      cfg: {
        agents: {
          defaults: {
            heartbeat: { every: "10m" },
          },
        },
      },
      items: [item()],
      result: {
        candidates: [
          candidate({
            dedupeKey: "too-soon",
            dueWindow: {
              earliest: new Date(nowMs + 60_000).toISOString(),
              latest: new Date(nowMs + 120_000).toISOString(),
            },
          }),
        ],
      },
      nowMs: writeMs,
    });

    const validCandidate = expectSingleValidCandidate(valid);
    expect(validCandidate.earliestMs).toBe(writeMs + 10 * 60_000);
    expect(validCandidate.latestMs).toBe(writeMs + 10 * 60_000 + 12 * 60 * 60_000);
  });

  it("persists inferred commitments and dedupes by scope and dedupe key", async () => {
    const cfg = await createConfig();
    const created = await persistCommitmentExtractionResult({
      cfg,
      items: [item()],
      result: { candidates: [candidate()] },
      nowMs,
    });
    const deduped = await persistCommitmentExtractionResult({
      cfg,
      items: [item()],
      result: {
        candidates: [
          candidate({
            reason: "Updated reason",
            confidence: 0.97,
            dueWindow: { earliest: "2026-04-30T18:00:00.000Z" },
          }),
        ],
      },
      nowMs: nowMs + 1_000,
    });
    const store = await loadCommitmentStore();

    expect(created).toHaveLength(1);
    expect(deduped).toHaveLength(0);
    expect(store.commitments).toHaveLength(1);
    expect(store.commitments[0]?.reason).toBe("Updated reason");
    expect(store.commitments[0]?.confidence).toBe(0.97);
    expect(store.commitments[0]?.status).toBe("pending");
  });

  it("dismisses existing pending commitments resolved by later extraction", async () => {
    const cfg = await createConfig();
    await persistCommitmentExtractionResult({
      cfg,
      items: [item()],
      result: {
        candidates: [
          candidate({
            dedupeKey: "gmail-reauth:sprichert",
            reason: "User requested a Gmail reauth link.",
            suggestedText: "Did the gog Gmail reauth go through for sprichert@gmail.com?",
          }),
        ],
      },
      nowMs,
    });
    await persistCommitmentExtractionResult({
      cfg,
      items: [
        item({
          nowMs: nowMs + 60_000,
          userText: "It went through.",
          assistantText: "Confirmed: the Gmail reauth completed and the account is working.",
          existingPending: [
            {
              kind: "open_loop",
              reason: "User requested a Gmail reauth link.",
              dedupeKey: "gmail-reauth:sprichert",
              earliestMs: Date.parse("2026-04-30T17:00:00.000Z"),
              latestMs: Date.parse("2026-04-30T23:00:00.000Z"),
            },
          ],
        }),
      ],
      result: {
        candidates: [],
        resolved: [
          {
            itemId: "turn-1",
            dedupeKey: "gmail-reauth:sprichert",
            reason: "The assistant confirmed the reauth completed and was verified.",
            confidence: 0.96,
          },
        ],
      },
      nowMs: nowMs + 60_000,
    });

    const store = await loadCommitmentStore();
    expect(store.commitments).toHaveLength(1);
    expect(store.commitments[0]).toMatchObject({
      dedupeKey: "gmail-reauth:sprichert",
      status: "dismissed",
      dismissedAtMs: nowMs + 60_000,
    });
  });
});
