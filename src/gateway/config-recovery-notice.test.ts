import { afterEach, describe, expect, it } from "vitest";
import {
  drainSystemEvents,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import {
  enqueueConfigRecoveryNotice,
  formatConfigRecoveryIssueSummary,
  formatConfigRecoveryNotice,
} from "./config-recovery-notice.js";

describe("config recovery notice", () => {
  afterEach(() => {
    resetSystemEventsForTest();
  });

  it("formats a prompt-facing warning for recovered configs", () => {
    expect(
      formatConfigRecoveryNotice({
        phase: "startup",
        reason: "startup-invalid-config",
        configPath: "/home/test/.openclaw/openclaw.json",
      }),
    ).toBe(
      "Config recovery warning: OpenClaw restored openclaw.json from the last-known-good backup during startup (startup-invalid-config). The rejected config was invalid and was preserved as a timestamped .clobbered.* file. Do not write openclaw.json again unless you validate the full config first.",
    );
  });

  it("formats validation details for recovered configs", () => {
    expect(
      formatConfigRecoveryIssueSummary([
        { path: "agents.defaults.execution", message: "Unrecognized key: execution" },
        { path: "gateway.auth.password.source", message: "Required" },
      ]),
    ).toBe(
      " Validation issues: agents.defaults.execution: Unrecognized key: execution; gateway.auth.password.source: Required.",
    );
  });

  it("includes validation details in prompt-facing warnings", () => {
    expect(
      formatConfigRecoveryNotice({
        phase: "startup",
        reason: "startup-invalid-config",
        configPath: "/home/test/.openclaw/openclaw.json",
        issues: [{ path: "agents.defaults.execution", message: "Unrecognized key: execution" }],
      }),
    ).toContain("Validation issues: agents.defaults.execution: Unrecognized key: execution.");
  });

  it("queues the notice for the main agent session", () => {
    expect(
      enqueueConfigRecoveryNotice({
        cfg: {},
        phase: "reload",
        reason: "reload-invalid-config",
        configPath: "/home/test/.openclaw/openclaw.json",
        issues: [{ path: "gateway.auth.password.source", message: "Required" }],
      }),
    ).toBe(true);

    expect(peekSystemEvents("agent:main:main")).toHaveLength(1);
    const notice = drainSystemEvents("agent:main:main")[0];
    expect(notice).toContain(
      "Do not write openclaw.json again unless you validate the full config first.",
    );
    expect(notice).toContain("gateway.auth.password.source: Required");
  });
});
