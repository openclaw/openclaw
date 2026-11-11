import { expect, it } from "vitest";
import {
  mergeTelegramProofIntoReleaseBody,
  parseArgs,
  pollRun,
  readPositiveInt,
  requireWorkflowRunIdFromOutput,
  run,
} from "../../scripts/release-beta-smoke.ts";

const telegramProof =
  "- npm Telegram beta E2E: https://github.com/openclaw/openclaw/actions/runs/123";
const releaseBody = (proof = "") =>
  `## Changes\n\n### Release verification\n\n${proof}\n\n### Assets\n\n- artifact\n`;

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
  expect(readLimit("25")).toBe(25);

  for (const raw of ["25ms", "0", String(Number.MAX_SAFE_INTEGER + 1)]) {
    expect(() => readLimit(raw)).toThrow(
      "OPENCLAW_RELEASE_BETA_SMOKE_COMMAND_MS must be a positive integer",
    );
  }
});

it("parses workflow run urls when gh includes them in dispatch output", () => {
  expect(
    requireWorkflowRunIdFromOutput(
      "Dispatched: https://github.com/openclaw/openclaw/actions/runs/1234567890",
      "npm-telegram.yml",
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
    run(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      capture: true,
      timeoutMs: 50,
    }),
  ).toThrow(/timed out after 50ms/u);
});

it.each([false, true])("polls until timeout or completion (completed=%s)", async (completed) => {
  let now = 0;
  const sleeps: number[] = [];

  const polling = pollRun("openclaw/openclaw", "123", {
    now: () => now,
    pollIntervalMs: 400,
    readRun: () => ({
      conclusion: completed ? "success" : null,
      html_url: "https://github.com/openclaw/openclaw/actions/runs/123",
      status: completed ? "completed" : "queued",
      updated_at: "2026-05-28T12:00:00Z",
    }),
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    timeoutMs: 1000,
  });
  if (completed) {
    await expect(polling).resolves.toBeUndefined();
  } else {
    await expect(polling).rejects.toThrow("Telegram workflow 123 did not complete within 1000ms");
  }
  expect(sleeps).toEqual(completed ? [] : [400, 400, 200]);
});
