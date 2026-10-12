/** Startup outcome coverage loaded by the post-attach startup suite. */
import { describe, expect, it } from "vitest";
import {
  createGatewayStartupOutcomeRecorder,
  formatGatewayStartupOutcomes,
} from "./server-startup-outcomes.js";

type GatewayStartupOutcomeRecorderParams = Parameters<
  typeof createGatewayStartupOutcomeRecorder
>[0];
type GatewayStartupOutcome = Parameters<typeof formatGatewayStartupOutcomes>[0][number];

const inactiveParams: GatewayStartupOutcomeRecorderParams = {
  cfg: {},
  gatewayStartHooks: false,
  env: {},
};

describe("gateway startup outcomes", () => {
  it.each([
    {
      account: "operator@example.com",
      env: { OPENCLAW_SKIP_GMAIL_WATCHER: "1" },
      reason: "disabled-by-environment",
    },
    { account: undefined, env: {}, reason: "no-gmail-account" },
  ])("records Gmail skip reason $reason", async ({ account, env, reason }) => {
    const recorder = await createGatewayStartupOutcomeRecorder({
      ...inactiveParams,
      cfg: { hooks: { enabled: true, gmail: { account } } },
      env,
    });
    expect(recorder.snapshot().find((outcome) => outcome.subsystem === "gmail-watcher")).toEqual({
      subsystem: "gmail-watcher",
      status: "skipped",
      reason,
    });
  });

  it("records awaited internal hook outcomes without logging raw error fields", async () => {
    const recorder = await createGatewayStartupOutcomeRecorder({
      ...inactiveParams,
      cfg: {
        hooks: {
          enabled: true,
          internal: { enabled: true },
          gmail: { account: "private-account", model: "private-provider/private-model" },
        },
      },
    });
    const failedOutcome: GatewayStartupOutcome & { error: string; value: string } = {
      subsystem: "internal-hooks",
      status: "failed",
      reason: "see earlier log",
      error: "secret startup error",
      value: "private config value",
    };

    recorder.record(failedOutcome);
    let summary = formatGatewayStartupOutcomes(recorder.snapshot());
    expect(summary).toContain("internal-hooks=failed (see earlier log)");
    expect(summary).not.toContain("secret startup error");
    expect(summary).not.toContain("private config value");
    expect(summary).not.toContain("private-account");
    expect(summary).not.toContain("private-provider/private-model");

    recorder.record({ subsystem: "internal-hooks", status: "loaded" });
    recorder.record({ subsystem: "internal-startup-hook", status: "scheduled" });
    summary = formatGatewayStartupOutcomes(recorder.snapshot());
    expect(summary).toContain("internal-hooks=loaded");
    expect(summary).toContain("internal-startup-hook=scheduled");
  });
});
