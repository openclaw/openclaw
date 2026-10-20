import { describe, expect, it } from "vitest";
import {
  mergeTelegramProofIntoReleaseBody,
  parseArgs,
  parseWorkflowRunIdFromOutput,
  pollRun,
  readPositiveInt,
  requireWorkflowRunIdFromOutput,
  run,
} from "../../scripts/release-beta-smoke.ts";

const telegramProof =
  "- npm Telegram beta E2E: https://github.com/openclaw/openclaw/actions/runs/123";
const releaseBody = (proof = "") =>
  `## Changes\n\n### Release verification\n\n` +
  `- npm package: https://www.npmjs.com/package/openclaw/v/2026.5.20-beta.1\n` +
  `${proof}\n\n### Assets\n\n- artifact\n`;
const workflowRun = (completed = false) => ({
  conclusion: completed ? "success" : null,
  html_url: "https://github.com/openclaw/openclaw/actions/runs/123",
  status: completed ? "completed" : "queued",
  updated_at: "2026-05-28T12:00:00Z",
});

describe("release-beta-smoke", () => {
  it("rejects runs with both validation lanes skipped", () => {
    expect(() => parseArgs(["--skip-parallels", "--skip-telegram"])).toThrow(
      "--skip-parallels and --skip-telegram cannot be used together",
    );
  });

  it.each([
    [["--beta", "beta-a", "--", "--skip-parallels", "--skip-telegram"], false],
    [["--", "--beta", "beta-a", "--skip-parallels"], true],
  ] as const)("respects the argument separator in %j", (args, skipParallels) => {
    expect(parseArgs([...args])).toMatchObject({
      beta: "beta-a",
      skipParallels,
      skipTelegram: false,
    });
  });

  it("rejects malformed positive integer environment limits", () => {
    const readLimit = (raw?: string) =>
      readPositiveInt(raw, 60, "OPENCLAW_RELEASE_BETA_SMOKE_COMMAND_MS");
    expect(readLimit()).toBe(60);
    expect(readLimit("")).toBe(60);
    expect(readLimit("25")).toBe(25);

    for (const raw of ["1e3", "25ms", "1.5", "0", "-1", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(() => readLimit(raw)).toThrow(
        "OPENCLAW_RELEASE_BETA_SMOKE_COMMAND_MS must be a positive integer",
      );
    }
  });

  it("parses workflow run urls when gh includes them in dispatch output", () => {
    expect(
      parseWorkflowRunIdFromOutput(
        "Dispatched: https://github.com/openclaw/openclaw/actions/runs/1234567890",
      ),
    ).toBe("1234567890");
  });

  it("fails closed when gh dispatch output does not include the run url", () => {
    expect(() =>
      requireWorkflowRunIdFromOutput("✓ Created workflow_dispatch event", "npm-telegram.yml"),
    ).toThrow("refusing to guess from recent workflow_dispatch runs");
  });

  it("replaces stale Telegram proof placeholders", () => {
    const merged = mergeTelegramProofIntoReleaseBody(
      releaseBody("- npm Telegram beta E2E: not supplied"),
      telegramProof,
    );

    expect(merged).toContain("actions/runs/123");
    expect(merged).not.toContain("not supplied");
    expect(merged).toContain("### Assets");
  });

  it("inserts Telegram proof before the next release notes subsection", () => {
    const merged = mergeTelegramProofIntoReleaseBody(releaseBody(), telegramProof);
    expect(merged.indexOf("actions/runs/123")).toBeLessThan(merged.indexOf("### Assets"));
  });

  it("uses a non-ignorable timeout signal for trapped children", () => {
    expect(() =>
      run(
        process.execPath,
        ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        { capture: true, timeoutMs: 50 },
      ),
    ).toThrow(/timed out after 50ms/u);
  });

  it("stops polling Telegram workflow runs after the timeout budget", async () => {
    let now = 0;
    const sleeps: number[] = [];

    await expect(
      pollRun("openclaw/openclaw", "123", {
        now: () => now,
        pollIntervalMs: 400,
        readRun: () => workflowRun(),
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("Telegram workflow 123 did not complete within 1000ms");
    expect(sleeps).toEqual([400, 400, 200]);
  });

  it("returns when the Telegram workflow succeeds", async () => {
    await expect(
      pollRun("openclaw/openclaw", "123", {
        readRun: () => workflowRun(true),
        sleep: async () => {
          throw new Error("sleep should not run after completion");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
