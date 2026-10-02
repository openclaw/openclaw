import { describe, expect, it, vi } from "vitest";
import type { ChannelAccountHealthSummary, HealthSummary } from "../gateway/health/types.js";
import * as loggingConfig from "../logging/config.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import {
  formatDeliveryQueueHealthLine,
  formatGatewayClosedDiagnostic,
  formatHealthChannelLines,
} from "./health-format.js";

describe("formatGatewayClosedDiagnostic", () => {
  it("formats a coded gateway transport close", () => {
    const error = Object.assign(new Error("gateway closed (1006): no close reason"), {
      name: "GatewayTransportError",
      kind: "closed",
      code: 1006,
      connectionDetails: {},
    });

    expect(formatGatewayClosedDiagnostic(error)).toBe(
      "Gateway connect failed: gateway closed (1006): no close reason",
    );
  });

  it("does not equate an uncoded connect-time close with a websocket close", () => {
    const error = Object.assign(new Error("Gateway not reachable at ws://127.0.0.1:18789"), {
      name: "GatewayTransportError",
      kind: "closed",
      connectionDetails: {},
    });

    expect(formatGatewayClosedDiagnostic(error)).toBeUndefined();
  });
});

const createHealthSummary = (
  params: Pick<HealthSummary, "channels" | "channelOrder" | "channelLabels"> = {
    channels: {},
    channelOrder: [],
    channelLabels: {},
  },
): HealthSummary => ({
  ok: true,
  ts: 0,
  durationMs: 0,
  heartbeatSeconds: 60,
  defaultAgentId: "main",
  agents: [],
  sessions: { path: "/tmp/sessions.json", count: 0, recent: [] },
  ...params,
});

function createMultiAccountHealthSummary(
  secondary: Partial<ChannelAccountHealthSummary>,
  primaryOverrides: Partial<ChannelAccountHealthSummary> = {},
): HealthSummary {
  const primary = {
    accountId: "main",
    enabled: true,
    configured: true,
    linked: true,
    healthState: "healthy",
    probe: { ok: true, elapsedMs: 12 },
    ...primaryOverrides,
  };
  const secondaryAccount = {
    accountId: "alerts",
    enabled: true,
    configured: true,
    linked: true,
    ...secondary,
  };
  return createHealthSummary({
    channels: {
      matrix: {
        ...primary,
        accounts: {
          [primary.accountId]: primary,
          [secondaryAccount.accountId]: secondaryAccount,
        },
      },
    },
    channelOrder: ["matrix"],
    channelLabels: { matrix: "Matrix" },
  });
}

describe("formatHealthChannelLines", () => {
  it.each([false, true])("keeps the named startup error with terminal controls=%s", (controls) => {
    const error = "Legacy exec approvals exist at /tmp/synthetic/exec-approvals.json.";
    const summary = createHealthSummary({
      channels: {
        telegram: {
          accountId: "default",
          configured: true,
          running: false,
          healthState: "not-running",
          lastError: controls ? `\u001b[31m${error}\u001b[0m\n` : error,
        },
      },
      channelOrder: ["telegram"],
      channelLabels: { telegram: "Telegram" },
    });
    expect(formatHealthChannelLines(summary)).toEqual([
      `Telegram: not-running (${error}${controls ? "\\n" : ""})`,
    ]);
  });

  it("formats per-account probe timings", () => {
    const summary = createHealthSummary({
      channels: {
        telegram: {
          accountId: "main",
          configured: true,
          probe: { ok: true, elapsedMs: 196, bot: { username: "pinguini_ugi_bot" } },
          accounts: {
            main: {
              accountId: "main",
              configured: true,
              probe: { ok: true, elapsedMs: 196, bot: { username: "pinguini_ugi_bot" } },
            },
            flurry: {
              accountId: "flurry",
              configured: true,
              probe: { ok: true, elapsedMs: 190, bot: { username: "flurry_ugi_bot" } },
            },
            poe: {
              accountId: "poe",
              configured: true,
              probe: { ok: true, elapsedMs: 188, bot: { username: "poe_ugi_bot" } },
            },
          },
        },
      },
      channelOrder: ["telegram"],
      channelLabels: { telegram: "Telegram" },
    });

    expect(formatHealthChannelLines(summary, { accountMode: "all" })).toStrictEqual([
      "Telegram: ok (@pinguini_ugi_bot:main:196ms, @flurry_ugi_bot:flurry:190ms, @poe_ugi_bot:poe:188ms)",
    ]);
  });

  it.each([
    [
      "fresh probe failure over passive healthy state",
      { healthState: "healthy", probe: { ok: false, error: "sync rejected" } },
      "failed (unknown) - sync rejected",
    ],
    [
      "fresh probe success over passive healthy state",
      { healthState: "healthy", probe: { ok: true, elapsedMs: 12 } },
      "ok (12ms)",
    ],
    [
      "blocked lifecycle over a failed probe",
      { linked: true, healthState: "blocked", probe: { ok: false, error: "sync rejected" } },
      "blocked",
    ],
    [
      "unknown degraded lifecycle over a successful probe",
      { healthState: "degraded", probe: { ok: true, elapsedMs: 12 } },
      "degraded",
    ],
    [
      "unstable authentication over passive healthy state and a failed probe",
      {
        healthState: "healthy",
        statusState: "unstable",
        probe: { ok: false, error: "sync rejected" },
      },
      "auth stabilizing",
    ],
    [
      "disabled account over stale failure metadata",
      { enabled: false, healthState: "blocked", probe: { ok: false, error: "old failure" } },
      "disabled",
    ],
    [
      "disabled status over stale passive healthy state",
      { healthState: "healthy", statusState: "disabled" },
      "disabled",
    ],
    [
      "unconfigured account over stale lifecycle and authentication state",
      { configured: false, healthState: "blocked", statusState: "unstable" },
      "not configured",
    ],
    [
      "fresh probe failure over configured status",
      { statusState: "configured", probe: { ok: false, error: "credentials rejected" } },
      "failed (unknown) - credentials rejected",
    ],
    [
      "fresh probe failure over affirmative linked state",
      { linked: true, probe: { ok: false, error: "session rejected" } },
      "failed (unknown) - session rejected",
    ],
    [
      "negative linked state over a failed probe",
      { linked: false, probe: { ok: false, error: "session rejected" } },
      "not linked",
    ],
    ["passive healthy state without a probe", { healthState: "healthy" }, "healthy"],
  ])("formats %s", (_name, account, expected) => {
    const summary = createHealthSummary({
      channels: {
        test: {
          accountId: "default",
          configured: true,
          ...account,
        },
      },
      channelOrder: ["test"],
      channelLabels: { test: "Test" },
    });

    expect(formatHealthChannelLines(summary)).toStrictEqual([`Test: ${expected}`]);
  });

  it.each(["default", "all"] as const)(
    "renders a sole disabled configured account in %s health output",
    (accountMode) => {
      const account = {
        accountId: "main",
        enabled: false,
        configured: true,
        running: false,
        stateReason: "disabled",
        lastError: null,
      };
      const summary = createHealthSummary({
        channels: { matrix: { ...account, accounts: { main: account } } },
        channelOrder: ["matrix"],
        channelLabels: { matrix: "Matrix" },
      });

      expect(formatHealthChannelLines(summary, { accountMode })).toStrictEqual([
        "Matrix: disabled",
      ]);
    },
  );

  it.each([
    ["blocked", { healthState: "blocked" }],
    ["auth stabilizing", { healthState: "healthy", statusState: "unstable" }],
  ])(
    "surfaces secondary account state %s in default and verbose health output",
    (expected, state) => {
      const summary = createMultiAccountHealthSummary(state);

      for (const accountMode of ["default", "all"] as const) {
        expect(formatHealthChannelLines(summary, { accountMode })).toStrictEqual([
          `Matrix: ${expected}`,
        ]);
      }
    },
  );

  it("preserves explicitly scoped account health outside verbose output", () => {
    const summary = createMultiAccountHealthSummary({ healthState: "blocked" });
    const accountIdsByChannel = { matrix: ["main"] };

    expect(
      formatHealthChannelLines(summary, { accountMode: "default", accountIdsByChannel }),
    ).toStrictEqual(["Matrix: ok (12ms)"]);
    expect(
      formatHealthChannelLines(summary, { accountMode: "all", accountIdsByChannel }),
    ).toStrictEqual(["Matrix: blocked"]);
  });

  it.each([
    {
      name: "successful",
      probe: { ok: true, elapsedMs: 12 },
      expected: "ok (12ms)",
      expectedAll: "ok (alerts:alerts:12ms)",
    },
    {
      name: "failed",
      probe: { ok: false, error: "sync rejected" },
      expected: "failed (unknown) - sync rejected",
      expectedAll: "failed (unknown) - sync rejected",
    },
  ])(
    "reports the $name active probe when the preferred account is inactive",
    ({ probe, expected, expectedAll }) => {
      for (const [inactive, scopedState] of [
        [{ configured: false }, "not configured"],
        [{ enabled: false }, "disabled"],
      ] as const) {
        const summary = createMultiAccountHealthSummary(
          { healthState: "healthy", probe },
          { ...inactive, linked: undefined, healthState: undefined, probe: undefined },
        );
        const accountIdsByChannel = { matrix: ["main"] };

        expect(formatHealthChannelLines(summary)).toStrictEqual([`Matrix: ${expected}`]);
        expect(
          formatHealthChannelLines(summary, { accountMode: "all", accountIdsByChannel }),
        ).toStrictEqual([`Matrix: ${expectedAll}`]);
        expect(
          formatHealthChannelLines(summary, { accountMode: "default", accountIdsByChannel }),
        ).toStrictEqual([`Matrix: ${scopedState}`]);
        expect(
          formatHealthChannelLines(summary, {
            accountIdsByChannel: { matrix: ["alerts"] },
          }),
        ).toStrictEqual([`Matrix: ${expected}`]);
      }
    },
  );

  it("keeps the healthy preferred account ahead of numeric account-key order", () => {
    const summary = createMultiAccountHealthSummary(
      { accountId: "1", probe: { ok: true, elapsedMs: 1 } },
      { accountId: "9", probe: { ok: true, elapsedMs: 9 } },
    );

    expect(formatHealthChannelLines(summary)).toStrictEqual(["Matrix: ok (9ms)"]);
    expect(
      formatHealthChannelLines(summary, { accountIdsByChannel: { matrix: ["1", "9"] } }),
    ).toStrictEqual(["Matrix: ok (1ms)"]);
  });

  it("keeps the selected username first, deduplicates it, and preserves webhook text", () => {
    const summary = createMultiAccountHealthSummary(
      { accountId: "1", probe: { ok: true, bot: { username: "sibling" } } },
      {
        accountId: "9",
        probe: {
          ok: true,
          elapsedMs: 12,
          bot: { username: "selected" },
          webhook: { url: "https://example.test/hook" },
        },
      },
    );

    expect(formatHealthChannelLines(summary)).toStrictEqual([
      "Matrix: ok (@selected, @sibling) (12ms) - webhook https://example.test/hook",
    ]);
  });

  it.each([undefined, {}])("preserves the channel snapshot when accounts are %j", (accounts) => {
    const summary = createHealthSummary({
      channels: {
        matrix: {
          accountId: "main",
          configured: true,
          probe: { ok: true, elapsedMs: 12 },
          accounts,
        },
      },
      channelOrder: ["matrix"],
      channelLabels: { matrix: "Matrix" },
    });

    expect(formatHealthChannelLines(summary)).toStrictEqual(["Matrix: ok (12ms)"]);
    expect(formatHealthChannelLines(summary, { accountMode: "all" })).toStrictEqual([
      "Matrix: ok (12ms)",
    ]);
  });

  it.each([
    ["disabled", { enabled: false }],
    ["unconfigured", { configured: false }],
    ["unlinked", { linked: false }],
    ["disabled by status", { statusState: "disabled" }],
    ["unconfigured by status", { statusState: "unconfigured" }],
  ])("does not promote stale failures from an intentionally %s account", (_reason, inactive) => {
    const summary = createMultiAccountHealthSummary({
      healthState: "blocked",
      probe: { ok: false, error: "stale old failure" },
      ...inactive,
    });

    expect(formatHealthChannelLines(summary)).toStrictEqual(["Matrix: ok (12ms)"]);
    expect(formatHealthChannelLines(summary, { accountMode: "all" })).toStrictEqual([
      "Matrix: ok (main:main:12ms)",
    ]);
  });

  it("surfaces a failed sibling probe over the selected account's passive healthy state", () => {
    const summary = createMultiAccountHealthSummary({
      healthState: "healthy",
      probe: { ok: false, error: "sync rejected" },
    });

    expect(formatHealthChannelLines(summary, { accountMode: "all" })).toStrictEqual([
      "Matrix: failed (unknown) - sync rejected",
    ]);
  });

  it("surfaces activated and configured plugin failures without promoting inactive errors", () => {
    const summary = createHealthSummary({ channels: {}, channelOrder: [], channelLabels: {} });
    summary.plugins = {
      loaded: ["calendar"],
      errors: [
        {
          id: "calendar",
          origin: "workspace",
          activated: true,
          failurePhase: "service",
          error: "service scheduler: address already in use",
        },
        {
          id: "inactive",
          origin: "workspace",
          activated: false,
          failurePhase: "load",
          error: "inactive plugin load failed",
        },
        ...(["explicit", "auto", "default"] as const).map((activationSource) => ({
          id: activationSource,
          origin: "config" as const,
          activated: false,
          activationSource,
          failurePhase: "load" as const,
          error: "runtime entry missing",
        })),
        {
          id: "disabled",
          origin: "workspace",
          activated: false,
          activationSource: "disabled",
          error: "disabled plugin ignored",
        },
      ],
    };

    expect(formatHealthChannelLines(summary)).toStrictEqual([
      "Plugin calendar: failed - service scheduler: address already in use; run openclaw doctor",
      "Plugin explicit: failed - runtime entry missing; run openclaw doctor",
      "Plugin auto: failed - runtime entry missing; run openclaw doctor",
      "Plugin default: failed - runtime entry missing; run openclaw doctor",
    ]);
  });

  it("masks raw and terminal-normalized plugin diagnostics with built-in and custom patterns", () => {
    const configSpy = vi.spyOn(loggingConfig, "readLoggingConfig").mockReturnValue({
      redactPatterns: ["deploymentMarker7"],
    });
    try {
      registerSecretValueForRedaction("plugin9X");
      registerSecretValueForRedaction("lineA9\nlineB7");
      const summary = createHealthSummary();
      summary.plugins = {
        loaded: [],
        errors: [
          {
            id: "\u202eplug\u200b\u001b[31min9X\u2069",
            origin: "config",
            activated: true,
            error:
              "lineA9\nlineB7 pass\u200bword=mockPass7X deploymentMark\u200ber7 vis\u{E0061}ible\u2028 context\u2029\ufeff\uD800",
          },
        ],
      };

      expect(formatHealthChannelLines(summary)).toEqual([
        "Plugin ***: failed - *** password=*** *** visible context; run openclaw doctor",
      ]);
    } finally {
      resetSecretRedactionRegistryForTest();
      configSpy.mockRestore();
    }
  });

  it("bounds plugin diagnostics without splitting Unicode characters", () => {
    const summary = createHealthSummary();
    summary.plugins = {
      loaded: [],
      errors: [
        {
          id: `x${"📦".repeat(60)}`,
          origin: "config",
          activated: true,
          error: `y${"🦀".repeat(250)}`,
        },
      ],
    };

    expect(formatHealthChannelLines(summary)).toEqual([
      `Plugin x${"📦".repeat(59)}: failed - y${"🦀".repeat(249)}; run openclaw doctor`,
    ]);
  });

  it.each([20, 21])(
    "bounds %s combined plugin warnings without counting hidden errors",
    (count) => {
      const summary = createHealthSummary({ channels: {}, channelOrder: [], channelLabels: {} });
      summary.plugins = {
        loaded: [],
        errors: [
          ...Array.from({ length: 10 }, (_, index) => ({
            id: `plugin-${index}`,
            origin: "workspace" as const,
            activated: true,
            error: "x".repeat(600),
          })),
          { id: "inactive", origin: "workspace", activated: false, error: "hidden inactive" },
          {
            id: "disabled",
            origin: "workspace",
            activated: false,
            activationSource: "disabled",
            error: "hidden disabled",
          },
        ],
        unavailable: Array.from({ length: count - 10 }, (_, index) => ({
          id: `unavailable-${index}`,
          state: "configured-unavailable",
          diagnostic: {
            kind: "plugin-verification",
            reason: "unreadable-package-json",
            detail: "manifest unreadable",
          },
        })),
      };
      const original = structuredClone(summary);

      const lines = formatHealthChannelLines(summary);

      expect(summary).toEqual(original);
      expect(lines).toHaveLength(count);
      expect(lines[0]).toBe(`Plugin plugin-0: failed - ${"x".repeat(500)}; run openclaw doctor`);
      expect(lines.filter((line) => line.startsWith("Plugin unavailable-"))).toHaveLength(10);
      expect(lines.join("\n")).not.toContain("hidden");
      expect(lines.filter((line) => line.startsWith("Plugins:"))).toEqual(
        count === 21
          ? ["Plugins: warning - 1 additional plugin warnings; run openclaw doctor"]
          : [],
      );
    },
  );
});

describe("formatDeliveryQueueHealthLine", () => {
  it("summarizes dead-lettered delivery queue entries with the oldest age", () => {
    const summary = createHealthSummary();
    summary.deliveryQueues = {
      failed: [
        { queueName: "outbound", count: 3, oldestFailedAt: 90_000 },
        { queueName: "session", count: 1 },
      ],
    };

    expect(formatDeliveryQueueHealthLine(summary, 7_290_000)).toBe(
      "Delivery queue: warning (dead-lettered entries — outbound: 3, session: 1; oldest 2h ago)",
    );
  });

  it("summarizes dead-lettered ingress entries per channel account", () => {
    const summary = createHealthSummary();
    summary.deliveryQueues = {
      failed: [],
      ingressFailed: [
        { channelId: "line", accountId: "default", count: 1, oldestFailedAt: 90_000 },
        { channelId: "telegram", accountId: "ops", count: 2 },
      ],
    };

    expect(formatDeliveryQueueHealthLine(summary, 7_290_000)).toBe(
      "Delivery queue: warning (dead-lettered entries — inbound line/default: 1, inbound telegram/ops: 2; oldest 2h ago)",
    );
  });

  it("summarizes ingress pressure per channel account", () => {
    const summary = createHealthSummary();
    summary.deliveryQueues = {
      failed: [],
      ingressPressure: [
        {
          channelId: "telegram",
          accountId: "ops",
          laneCount: 1,
          pendingCount: 56,
          claimedCount: 0,
          blockedCount: 55,
          oldestReceivedAt: 90_000,
        },
      ],
    };

    expect(formatDeliveryQueueHealthLine(summary, 7_290_000)).toBe(
      "Delivery queue: warning (ingress pressure — inbound telegram/ops: 1 pressured lane, 56 pending, 0 claimed, 55 blocked; oldest 2h ago)",
    );
  });

  it("summarizes dead letters and ingress pressure together", () => {
    const summary = createHealthSummary();
    summary.deliveryQueues = {
      failed: [{ queueName: "outbound", count: 2, oldestFailedAt: 90_000 }],
      ingressPressure: [
        {
          channelId: "line",
          accountId: "default",
          laneCount: 2,
          pendingCount: 3,
          claimedCount: 1,
          blockedCount: 2,
          oldestReceivedAt: 3_690_000,
        },
      ],
    };

    expect(formatDeliveryQueueHealthLine(summary, 7_290_000)).toBe(
      "Delivery queue: warning (dead-lettered entries — outbound: 2; oldest 2h ago; ingress pressure — inbound line/default: 2 pressured lanes, 3 pending, 1 claimed, 2 blocked; oldest 1h ago)",
    );
  });

  it("returns null when no dead-lettered entries are reported", () => {
    const summary = createHealthSummary();

    expect(formatDeliveryQueueHealthLine(summary)).toBeNull();
  });
});
