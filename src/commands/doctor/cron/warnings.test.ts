import { afterEach, expect, it, vi } from "vitest";
import {
  collectLegacyWhatsAppCrontabHealthWarning,
  noteCronDeliveryTargetAdvisory,
  noteCronModelOverrides,
  noteLegacyWhatsAppCrontabHealthCheck,
} from "./warnings.js";

const mocks = vi.hoisted(() => ({
  plugins: vi.fn(),
  note: vi.fn<(message: string, title?: string) => void>(),
  runExec: vi.fn(),
}));

// mock-isolation: advisory tests use a fixed channel inventory without loading plugin runtimes.
vi.mock("../../../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: mocks.plugins,
}));
vi.mock("../../../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("../../../process/exec.js", () => ({ runExec: mocks.runExec }));

afterEach(() => vi.clearAllMocks());

function advisory(jobs: Array<Record<string, unknown>>, channels: string[] = []): string | null {
  mocks.plugins.mockReturnValue(channels.map((id) => ({ id })));
  noteCronDeliveryTargetAdvisory({ cfg: {}, jobs });
  return mocks.note.mock.calls.at(-1)?.[0] ?? null;
}

it("reports unavailable channels with id/name/unnamed examples and ignores unpinned delivery", () => {
  const message = advisory([
    { id: "needs-doctor", delivery: { channel: "slack" } },
    { id: "report", delivery: { mode: "announce", channel: "missing-channel" } },
    ...["Nightly digest", undefined].map((name) => ({
      name,
      delivery: { mode: "announce", channel: "ghost" },
    })),
  ]);
  expect(message?.split("\n")).toContain("- Channels: ghost=2, missing-channel=1");
  expect(message).toContain(
    "Examples: report -> missing-channel, Nightly digest -> ghost, <unnamed> -> ghost",
  );
});

it("treats a channel alias as active when its canonical id is available", () => {
  expect(
    advisory([{ delivery: { mode: "announce", channel: "gchat" } }], ["googlechat"]),
  ).toBeNull();
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
      stdout:
        "# ensure-whatsapp.sh\n*/5 * * * * ~/.openclaw/bin/ensure-whatsapp.sh\n0 9 * * * /usr/bin/true\n",
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
  ["gem", "google/gemini-2.5-pro"],
  ["google/gemini-2.5-pro", "gem"],
])("compares cron override %s against %s after resolving aliases", (primary, model) => {
  noteCronModelOverrides({
    cfg: {
      agents: {
        defaults: {
          model: { primary },
          models: { "google/gemini-2.5-pro": { alias: "gem" } },
        },
      },
    },
    jobs: [{ id: "job", payload: { kind: "agentTurn", message: "Brief", model } }],
  });
  const text = mocks.note.mock.calls.at(-1)?.[0];
  expect(text).toContain("1 job set `payload.model`");
  expect(text).not.toContain("different model");
});
