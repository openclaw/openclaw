// Channels status --fail-on-unhealthy tests cover terminal-disconnect exit codes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../cli/daemon-cli/diagnostic-readiness.js", () => ({
  waitForGatewayDiagnosticReadiness: vi.fn(async () => undefined),
}));

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  withProgress: vi.fn(async (_opts: unknown, run: () => Promise<unknown>) => await run()),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => mocks.callGateway(opts),
}));

vi.mock("../cli/progress.js", () => ({
  withProgress: (opts: unknown, run: () => Promise<unknown>) => mocks.withProgress(opts, run),
}));

vi.mock("./channels/status.runtime.js", () => ({
  formatGatewayChannelsStatusLines: () => ["Gateway reachable.", "WhatsApp default: stopped"],
  renderChannelsStatusFallback: vi.fn(async () => {}),
}));

import {
  collectUnhealthyChannelAccounts,
  formatUnhealthyChannelAccount,
} from "./channels/status-unhealthy.js";
import { channelsStatusCommand } from "./channels/status.js";

function createRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function payloadFor(accounts: Record<string, unknown[]>) {
  return { channelAccounts: accounts };
}

const terminalPayload = payloadFor({
  whatsapp: [
    {
      accountId: "default",
      enabled: true,
      configured: true,
      running: false,
      connected: false,
      terminalDisconnect: true,
      lifecycle: "blocked",
      healthState: "logged-out",
      lastError: "status=401",
    },
  ],
});

const healthyPayload = payloadFor({
  whatsapp: [
    {
      accountId: "default",
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      lifecycle: "running",
    },
  ],
});

describe("collectUnhealthyChannelAccounts", () => {
  const now = 100_000;

  it("reports a terminal disconnect as unhealthy", () => {
    const unhealthy = collectUnhealthyChannelAccounts(terminalPayload, now);
    expect(unhealthy).toEqual([
      {
        channel: "whatsapp",
        accountId: "default",
        reason: "terminal-disconnect",
        terminalDisconnect: true,
      },
    ]);
  });

  it("reports blocked, not-running, and disconnected as unhealthy", () => {
    const payload = payloadFor({
      telegram: [
        {
          accountId: "default",
          enabled: true,
          configured: true,
          running: false,
          lifecycle: "blocked",
        },
      ],
      discord: [
        { accountId: "alt", enabled: true, configured: true, running: false, lifecycle: "stopped" },
      ],
      slack: [
        {
          accountId: "default",
          enabled: true,
          configured: true,
          running: true,
          connected: false,
          lastStartAt: 0,
          lastDisconnect: { at: 0 },
        },
      ],
    });
    const reasons = collectUnhealthyChannelAccounts(payload, now + 200_000).map(
      (account) => `${account.channel}/${account.accountId}:${account.reason}`,
    );
    expect(reasons).toContain("telegram/default:blocked");
    expect(reasons).toContain("discord/alt:not-running");
    expect(reasons).toContain("slack/default:disconnected");
  });

  it("does not fail on transient reconnect grace, startup grace, or busy", () => {
    const payload = payloadFor({
      whatsapp: [
        {
          accountId: "reconnecting",
          enabled: true,
          configured: true,
          running: true,
          connected: false,
          lifecycle: "recovering",
          lastStartAt: 0,
          lastDisconnect: { at: now - 1_000 },
        },
      ],
      discord: [
        {
          accountId: "starting",
          enabled: true,
          configured: true,
          running: true,
          connected: false,
          lifecycle: "starting",
          lastStartAt: now - 1_000,
        },
      ],
      slack: [
        {
          accountId: "busy",
          enabled: true,
          configured: true,
          running: true,
          connected: true,
          busy: true,
          lastStartAt: 0,
          lastRunActivityAt: now - 1_000,
          activeRunStartedAt: now - 1_000,
        },
      ],
    });
    expect(collectUnhealthyChannelAccounts(payload, now)).toEqual([]);
  });

  it("ignores unmanaged and disabled accounts", () => {
    const payload = payloadFor({
      whatsapp: [
        {
          accountId: "unlinked",
          enabled: true,
          configured: true,
          running: false,
          linked: false,
        },
      ],
      discord: [
        {
          accountId: "off",
          enabled: false,
          configured: true,
          running: false,
          terminalDisconnect: true,
        },
      ],
      slack: [
        {
          accountId: "unconfigured",
          enabled: true,
          configured: false,
          running: false,
          terminalDisconnect: true,
        },
      ],
    });
    expect(collectUnhealthyChannelAccounts(payload, now)).toEqual([]);
  });

  it("still reports an unlinked account with a terminal disconnect", () => {
    // Policy checks terminalDisconnect before the unlinked exemption, so a
    // revoked session (not-linked + terminal) must keep alerting.
    const payload = payloadFor({
      whatsapp: [
        {
          accountId: "unlinked-terminal",
          enabled: true,
          configured: true,
          running: false,
          linked: false,
          terminalDisconnect: true,
          lifecycle: "blocked",
        },
      ],
    });
    const unhealthy = collectUnhealthyChannelAccounts(payload, now);
    expect(unhealthy).toContainEqual({
      channel: "whatsapp",
      accountId: "unlinked-terminal",
      reason: "terminal-disconnect",
      terminalDisconnect: true,
    });
  });

  it("ignores a running terminalDisconnect snapshot and missing running facts", () => {
    const payload = payloadFor({
      whatsapp: [
        {
          accountId: "live-terminal",
          enabled: true,
          configured: true,
          running: true,
          connected: true,
          terminalDisconnect: true,
        },
      ],
      discord: [{ accountId: "legacy", enabled: true, configured: true, lifecycle: "stopped" }],
    });
    expect(collectUnhealthyChannelAccounts(payload, now)).toEqual([]);
  });

  it("formats terminal disconnects as user-visible notifications", () => {
    expect(
      formatUnhealthyChannelAccount({
        channel: "whatsapp",
        accountId: "default",
        reason: "terminal-disconnect",
        terminalDisconnect: true,
      }),
    ).toContain("terminally disconnected");
  });
});

describe("channelsStatusCommand --fail-on-unhealthy", () => {
  beforeEach(() => {
    mocks.callGateway.mockReset();
    mocks.withProgress.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 1 and notifies on a terminal disconnect in text mode", async () => {
    const runtime = createRuntime();
    mocks.callGateway.mockResolvedValueOnce(terminalPayload);

    await channelsStatusCommand({ failOnUnhealthy: true }, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.error.mock.calls.flat().join("\n")).toContain("terminally disconnected");
    expect(runtime.error.mock.calls.flat().join("\n")).toContain("whatsapp/default");
  });

  it("does not exit when the flag is absent", async () => {
    const runtime = createRuntime();
    mocks.callGateway.mockResolvedValueOnce(terminalPayload);

    await channelsStatusCommand({}, runtime);

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("does not exit for healthy accounts even with the flag", async () => {
    const runtime = createRuntime();
    mocks.callGateway.mockResolvedValueOnce(healthyPayload);

    await channelsStatusCommand({ failOnUnhealthy: true }, runtime);

    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("adds unhealthyAccounts to JSON and exits 1 on terminal disconnect", async () => {
    const runtime = createRuntime();
    mocks.callGateway.mockResolvedValueOnce(terminalPayload);

    await channelsStatusCommand({ json: true, failOnUnhealthy: true }, runtime);

    const json = JSON.parse(runtime.log.mock.calls[0]?.[0] ?? "{}");
    expect(json.unhealthyAccounts).toEqual([
      {
        channel: "whatsapp",
        accountId: "default",
        reason: "terminal-disconnect",
        terminalDisconnect: true,
      },
    ]);
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.error.mock.calls.flat().join("\n")).toContain("terminally disconnected");
  });

  it("supports the --exit-code alias", async () => {
    const runtime = createRuntime();
    mocks.callGateway.mockResolvedValueOnce(terminalPayload);

    await channelsStatusCommand({ exitCode: true }, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("does not exit on a transient reconnect in text mode", async () => {
    const runtime = createRuntime();
    mocks.callGateway.mockResolvedValueOnce(
      payloadFor({
        whatsapp: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: true,
            connected: false,
            lifecycle: "recovering",
            lastStartAt: 0,
            lastDisconnect: { at: Date.now() - 1_000 },
            terminalDisconnect: false,
          },
        ],
      }),
    );

    await channelsStatusCommand({ failOnUnhealthy: true }, runtime);

    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
