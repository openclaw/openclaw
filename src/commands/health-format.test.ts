import { afterEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import type { ChannelAccountHealthSummary, HealthSummary } from "../gateway/health/types.js";
import * as loggingConfig from "../logging/config.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import {
  formatDeliveryQueueHealthLine,
  formatGatewayClosedDiagnostic,
  formatHealthChannelLines,
  formatHealthCheckFailure,
} from "./health-format.js";
import {
  healthSummary as createHealthSummary,
  multiAccountHealth as createMultiAccountHealthSummary,
  pluginHealthError,
  unavailablePlugin,
} from "./health.test-fixtures.js";

it.each([
  [
    1006,
    "gateway closed (1006): no close reason",
    "Gateway connect failed: gateway closed (1006): no close reason",
  ],
  [undefined, "Gateway not reachable at ws://127.0.0.1:18789", undefined],
] as const)(
  "formatGatewayClosedDiagnostic distinguishes coded websocket closes from connect-time closes (%s)",
  (code, message, expected) => {
    const error = Object.assign(new Error(message), {
      name: "GatewayTransportError",
      kind: "closed",
      ...(code === undefined ? {} : { code }),
      connectionDetails: {},
    });
    expect(formatGatewayClosedDiagnostic(error)).toBe(expected);
  },
);

describe("health failure diagnostic redaction", () => {
  afterEach(() => {
    resetSecretRedactionRegistryForTest();
    vi.restoreAllMocks();
  });

  it.each([false, true])("keeps built-in and custom masking with rich=%s", (rich) => {
    vi.spyOn(loggingConfig, "readLoggingConfig").mockReturnValue({
      redactPatterns: ["deploymentMask9X"],
    });
    const output = stripAnsi(
      formatHealthCheckFailure(new Error("remote password=mockPass7X deploymentMask9X visible"), {
        rich,
      }),
    );
    expect(output).toContain("Health check failed:");
    expect(output).toContain("remote");
    expect(output).toContain("visible");
    expect(output).not.toContain("mockPass7X");
    expect(output).not.toContain("deploymentMask9X");
    expect(output).toContain("***");
  });

  it.each([false, true])("masks complete and normalized registered values with rich=%s", (rich) => {
    for (const [registered, message] of [
      ["proofSecr9X", "remote proofSecr9X visible"],
      ["proofSecr9X", "remote proofSe\u001b[31mcr9X visible"],
      ["lineA9\nlineB7", "remote lineA9\nlineB7 visible"],
    ] as const) {
      registerSecretValueForRedaction(registered);
      const output = stripAnsi(formatHealthCheckFailure(message, { rich }));
      expect(output).toContain("remote");
      expect(output).toContain("visible");
      for (const part of registered.split("\n")) {
        expect(output).not.toContain(part);
      }
      expect(output).toContain("***");
    }
    if (rich) {
      registerSecretValueForRedaction("joined secret");
      expect(stripAnsi(formatHealthCheckFailure(new Error("joined\nsecret"), { rich }))).toBe(
        "Health check failed: ***",
      );
    }
  });
});

const channelSummary = (id: string, label: string, account: ChannelAccountHealthSummary) =>
  createHealthSummary({
    channels: { [id]: account },
    channelOrder: [id],
    channelLabels: { [id]: label },
  });
const telegramAccount = (accountId: string, username: string, elapsedMs: number) => ({
  accountId,
  configured: true,
  probe: { ok: true, elapsedMs, bot: { username } },
});
const ingressPressure = (channelId: string, accountId: string, overrides = {}) => ({
  channelId,
  accountId,
  laneCount: 1,
  pendingCount: 56,
  claimedCount: 0,
  blockedCount: 55,
  oldestReceivedAt: 90_000,
  ...overrides,
});

describe("formatHealthChannelLines", () => {
  it("keeps the named startup error after removing terminal controls", () => {
    const error = "Legacy exec approvals exist at /tmp/synthetic/exec-approvals.json.";
    const summary = channelSummary("telegram", "Telegram", {
      accountId: "default",
      configured: true,
      running: false,
      healthState: "not-running",
      lastError: `\u001b[31m${error}\u001b[0m\n`,
    });
    expect(formatHealthChannelLines(summary)).toEqual([`Telegram: not-running (${error}\\n)`]);
  });

  it("formats per-account probe timings", () => {
    const main = telegramAccount("main", "pinguini_ugi_bot", 196);
    const summary = channelSummary("telegram", "Telegram", {
      ...main,
      accounts: {
        main,
        flurry: telegramAccount("flurry", "flurry_ugi_bot", 190),
        poe: telegramAccount("poe", "poe_ugi_bot", 188),
      },
    });

    expect(formatHealthChannelLines(summary, { accountMode: "all" })).toStrictEqual([
      "Telegram: ok (@pinguini_ugi_bot:main:196ms, @flurry_ugi_bot:flurry:190ms, @poe_ugi_bot:poe:188ms)",
    ]);
  });

  it.each([
    [
      "collection timeout remains a warning",
      { probe: { timedOut: true, error: "health collection timed out after 7000ms" } },
      "warning - health collection timed out after 7000ms",
    ],
    [
      "disabled status over stale passive healthy state",
      { healthState: "healthy", statusState: "disabled" },
      "disabled",
    ],
    [
      "negative linked state over a failed probe",
      { linked: false, probe: { ok: false, error: "session rejected" } },
      "not linked",
    ],
    ["passive healthy state without a probe", { healthState: "healthy" }, "healthy"],
  ])("formats %s", (_name, account, expected) => {
    const summary = channelSummary("test", "Test", {
      accountId: "default",
      configured: true,
      ...account,
    });

    expect(formatHealthChannelLines(summary)).toStrictEqual([`Test: ${expected}`]);
  });

  it("surfaces secondary auth stabilization in default and verbose health output", () => {
    const summary = createMultiAccountHealthSummary({
      healthState: "healthy",
      statusState: "unstable",
    });
    for (const accountMode of ["default", "all"] as const) {
      expect(formatHealthChannelLines(summary, { accountMode })).toStrictEqual([
        "Matrix: auth stabilizing",
      ]);
    }
  });

  it.each([
    [{ ok: true, elapsedMs: 12 }, "ok (12ms)", "ok (alerts:alerts:12ms)"],
    [
      { ok: false, error: "sync rejected" },
      "failed (unknown) - sync rejected",
      "failed (unknown) - sync rejected",
    ],
  ] as const)(
    "reports active probe %j when the preferred account is inactive",
    (probe, expected, expectedAll) => {
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

  it("does not promote stale failures from an intentionally disabled account", () => {
    const summary = createMultiAccountHealthSummary({
      healthState: "blocked",
      probe: { ok: false, error: "stale old failure" },
      enabled: false,
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
          pluginHealthError(
            "\u202eplug\u200b\u001b[31min9X\u2069",
            "lineA9\nlineB7 pass\u200bword=mockPass7X deploymentMark\u200ber7 vis\u{E0061}ible\u2028 context\u2029\ufeff\uD800",
            { origin: "config", activated: true },
          ),
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

  it("bounds combined plugin warnings without counting hidden errors", () => {
    const summary = createHealthSummary();
    summary.plugins = {
      loaded: [],
      errors: [
        ...Array.from({ length: 10 }, (_, index) =>
          pluginHealthError(`plugin-${index}`, "x".repeat(600), { activated: true }),
        ),
        pluginHealthError("inactive", "hidden inactive"),
        pluginHealthError("disabled", "hidden disabled", { activationSource: "disabled" }),
      ],
      unavailable: Array.from({ length: 11 }, (_, index) =>
        unavailablePlugin(`unavailable-${index}`),
      ),
    };
    const original = structuredClone(summary);

    const lines = formatHealthChannelLines(summary);

    expect(summary).toEqual(original);
    expect(lines).toHaveLength(21);
    expect(lines[0]).toBe(`Plugin plugin-0: failed - ${"x".repeat(500)}; run openclaw doctor`);
    expect(lines.filter((line) => line.startsWith("Plugin unavailable-"))).toHaveLength(10);
    expect(lines.join("\n")).not.toContain("hidden");
    expect(lines.filter((line) => line.startsWith("Plugins:"))).toEqual([
      "Plugins: warning - 1 additional plugin warnings; run openclaw doctor",
    ]);
  });
});

it.each<{ name: string; queues?: HealthSummary["deliveryQueues"]; expected: string | null }>([
  {
    name: "dead-lettered ingress entries per channel account",
    queues: {
      failed: [],
      ingressFailed: [
        { channelId: "line", accountId: "default", count: 1, oldestFailedAt: 90_000 },
        { channelId: "telegram", accountId: "ops", count: 2 },
      ],
    },
    expected:
      "Delivery queue: warning (dead-lettered entries — inbound line/default: 1, inbound telegram/ops: 2; oldest 2h ago)",
  },
  {
    name: "ingress pressure per channel account",
    queues: {
      failed: [],
      ingressPressure: [ingressPressure("telegram", "ops")],
    },
    expected:
      "Delivery queue: warning (ingress pressure — inbound telegram/ops: 1 pressured lane, 56 pending, 0 claimed, 55 blocked; oldest 2h ago)",
  },
  {
    name: "dead letters and ingress pressure together",
    queues: {
      failed: [{ queueName: "outbound", count: 2, oldestFailedAt: 90_000 }],
      ingressPressure: [
        ingressPressure("line", "default", {
          laneCount: 2,
          pendingCount: 3,
          claimedCount: 1,
          blockedCount: 2,
          oldestReceivedAt: 3_690_000,
        }),
      ],
    },
    expected:
      "Delivery queue: warning (dead-lettered entries — outbound: 2; oldest 2h ago; ingress pressure — inbound line/default: 2 pressured lanes, 3 pending, 1 claimed, 2 blocked; oldest 1h ago)",
  },
  { name: "no entries", expected: null },
])("formatDeliveryQueueHealthLine: $name", ({ queues, expected }) => {
  expect(
    formatDeliveryQueueHealthLine(createHealthSummary({ deliveryQueues: queues }), 7_290_000),
  ).toBe(expected);
});
