import { afterEach, expect, it, vi } from "vitest";
import {
  collectLegacyWhatsAppCrontabHealthWarning,
  noteCronDeliveryTargetAdvisory,
  noteCronModelOverrides,
  noteLegacyWhatsAppCrontabHealthCheck,
} from "./warnings.js";

const mocks = vi.hoisted(() => ({
  plugins: vi.fn(),
  note: vi.fn(),
  runExec: vi.fn(),
}));

// mock-isolation: advisory tests use a fixed channel inventory without loading plugin runtimes.
vi.mock("../../../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: mocks.plugins,
}));
vi.mock("../../../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("../../../process/exec.js", () => ({ runExec: mocks.runExec }));

afterEach(() => vi.clearAllMocks());

function job(overrides: Record<string, unknown>): Record<string, unknown> {
  return { id: "job", ...overrides };
}

function advisory(jobs: Array<Record<string, unknown>>, channels: string[] = []): string | null {
  mocks.plugins.mockReturnValue(channels.map((id) => ({ id })));
  noteCronDeliveryTargetAdvisory({ cfg: {}, jobs });
  const body = mocks.note.mock.calls.at(-1)?.[0];
  return typeof body === "string" ? body : null;
}

it("advises when a concrete delivery channel has no active plugin", () => {
  const message = advisory([
    job({ id: "needs-doctor", delivery: { channel: "slack" } }),
    job({ id: "report", delivery: { mode: "announce", channel: "missing-channel" } }),
  ]);
  expect(message).toContain("Automation delivery targets unavailable channels");
  expect(message).toContain("1 job announces");
  expect(message).toContain("Channels: missing-channel=1");
  expect(message).toContain("Examples: report -> missing-channel");
});

it("treats a channel alias as active when its canonical id is available", () => {
  expect(
    advisory([job({ delivery: { mode: "announce", channel: "gchat" } })], ["googlechat"]),
  ).toBeNull();
});

it("falls back to job name then <unnamed> in examples", () => {
  const message = advisory(
    ["Nightly digest", undefined].map((name) =>
      job({ id: undefined, name, delivery: { mode: "announce", channel: "ghost" } }),
    ),
    ["slack"],
  );
  expect(message).toContain("Nightly digest -> ghost");
  expect(message).toContain("<unnamed> -> ghost");
});
it("bounds the best-effort crontab read", async () => {
  mocks.runExec.mockRejectedValueOnce(new Error("crontab timed out"));

  await expect(
    collectLegacyWhatsAppCrontabHealthWarning({ platform: "linux" }),
  ).resolves.toBeNull();
  expect(mocks.runExec).toHaveBeenCalledWith("crontab", ["-l"], {
    logOutput: false,
    timeoutMs: 5_000,
  });
});

it("warns about legacy ensure-whatsapp crontab entries on Linux", async () => {
  await noteLegacyWhatsAppCrontabHealthCheck({
    platform: "linux",
    readCrontab: async () => ({
      stdout: [
        "# keep comments ignored",
        "*/5 * * * * ~/.openclaw/bin/ensure-whatsapp.sh >> ~/.openclaw/logs/whatsapp-health.log 2>&1",
        "0 9 * * * /usr/bin/true",
        "",
      ].join("\n"),
    }),
  });

  for (const text of [
    "Legacy WhatsApp crontab health check detected",
    "systemd user bus environment is missing",
    "Matched 1 entry",
  ]) {
    expect(mocks.note).toHaveBeenCalledWith(expect.stringContaining(text), "Cron");
  }
});

it.each([
  ["gem", "google/gemini-2.5-pro", false],
  ["google/gemini-2.5-pro", "gem", false],
  ["gem", "google/gemini-2.5-flash", true],
])("compares cron override %s against %s after resolving aliases", (primary, model, mismatch) => {
  noteCronModelOverrides({
    cfg: {
      agents: {
        defaults: {
          model: { primary },
          models: { "google/gemini-2.5-pro": { alias: "gem" } },
        },
      },
    },
    jobs: [job({ payload: { kind: "agentTurn", message: "Brief", model } })],
  });
  const text = mocks.note.mock.calls.at(-1)?.[0];
  expect(text).toContain("1 job set `payload.model`");
  if (mismatch) {
    expect(text).toContain("1 job uses a different model");
  } else {
    expect(text).not.toContain("different model");
  }
});
