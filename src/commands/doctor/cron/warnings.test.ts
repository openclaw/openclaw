// Doctor cron delivery-target advisory tests cover concrete-vs-pseudo channel detection.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectLegacyWhatsAppCrontabHealthWarning,
  noteCronDeliveryTargetAdvisory,
  noteLegacyWhatsAppCrontabHealthCheck,
} from "./warnings.js";

const mocks = vi.hoisted(() => ({
  listReadOnlyChannelPluginsForConfig: vi.fn(),
  note: vi.fn(),
  runExec: vi.fn(),
}));

vi.mock("../../../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: mocks.listReadOnlyChannelPluginsForConfig,
}));
vi.mock("../../../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("../../../process/exec.js", () => ({ runExec: mocks.runExec }));

afterEach(() => {
  vi.clearAllMocks();
});

function job(overrides: Record<string, unknown>): Record<string, unknown> {
  return { id: "job", schedule: "0 * * * *", ...overrides };
}

/** Resolver thunk returning a fixed channel set; tracks whether it was invoked. */
function availableChannels(...ids: string[]) {
  return vi.fn(() => ids);
}

function collectCronDeliveryTargetAdvisory(params: {
  jobs: Array<Record<string, unknown>>;
  resolveAvailableChannelIds: () => string[];
}): string | null {
  mocks.note.mockClear();
  mocks.listReadOnlyChannelPluginsForConfig.mockImplementation(() =>
    params.resolveAvailableChannelIds().map((id) => ({ id })),
  );
  noteCronDeliveryTargetAdvisory({
    cfg: {},
    jobs: params.jobs,
  });
  const body = mocks.note.mock.calls.at(-1)?.[0];
  return typeof body === "string" ? body : null;
}

describe("collectCronDeliveryTargetAdvisory", () => {
  it("advises when a concrete delivery channel has no active plugin", () => {
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [
        job({ id: "needs-doctor", delivery: { channel: "slack" } }),
        job({ id: "report", delivery: { mode: "announce", channel: "missing-channel" } }),
      ],
      resolveAvailableChannelIds: availableChannels(),
    });
    expect(advisory).not.toBeNull();
    expect(advisory).toContain("Automation delivery targets unavailable channels");
    expect(advisory).toContain("1 job announces");
    expect(advisory).toContain("Channels: missing-channel=1");
    expect(advisory).toContain("Examples: report -> missing-channel");
  });

  it("treats a channel alias as active when its canonical id is available", () => {
    // "gchat" canonicalizes to "googlechat"; an alias target must not look unavailable.
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [job({ delivery: { mode: "announce", channel: "gchat" } })],
      resolveAvailableChannelIds: availableChannels("googlechat"),
    });
    expect(advisory).toBeNull();
  });

  it("falls back to job name then <unnamed> in examples", () => {
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [
        job({
          id: undefined,
          name: "Nightly digest",
          delivery: { mode: "announce", channel: "ghost" },
        }),
        job({ id: undefined, name: undefined, delivery: { mode: "announce", channel: "ghost" } }),
      ],
      resolveAvailableChannelIds: availableChannels("slack"),
    });
    expect(advisory).toContain("Nightly digest -> ghost");
    expect(advisory).toContain("<unnamed> -> ghost");
  });
});

describe("collectLegacyWhatsAppCrontabHealthWarning", () => {
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

  expect(mocks.note).toHaveBeenCalledWith(
    expect.stringContaining("Legacy WhatsApp crontab health check detected"),
    "Cron",
  );
  expect(mocks.note).toHaveBeenCalledWith(
    expect.stringContaining("systemd user bus environment is missing"),
    "Cron",
  );
  expect(mocks.note).toHaveBeenCalledWith(expect.stringContaining("Matched 1 entry"), "Cron");
});
