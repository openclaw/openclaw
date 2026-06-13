import { describe, expect, it } from "vitest";
import {
  assertControlDirectorNoResponseEvidence,
  buildControlDirectorNoResponseSmokeCommand,
  detectMobileDevices,
  MOBILE_WEB_VIEWPORT_PROOF_KIND,
  mobileDeviceDetectionCommands,
  NATIVE_MOBILE_DEVICE_PROOF_KIND,
  parseAndroidDeviceLines,
  parseIosDeviceLines,
  resolveMobileProofDecision,
  validateSessionDiagnostics,
  validateVisibleBlockedText,
} from "../../scripts/dev/control-ui-control-director-no-response-smoke.ts";

describe("control-ui-control-director-no-response-smoke", () => {
  it("exposes the package command used by dashboard and remote proof runners", () => {
    expect(buildControlDirectorNoResponseSmokeCommand()).toEqual([
      "pnpm",
      "ui:smoke:control-director-no-response",
    ]);
  });

  it("declares bounded real-device detection commands", () => {
    expect(mobileDeviceDetectionCommands()).toEqual([
      { command: "xcrun", args: ["xctrace", "list", "devices"] },
      { command: "adb", args: ["devices"] },
    ]);
  });

  it("labels the mobile fallback as mobile web viewport proof when no real devices exist", () => {
    const summary = detectMobileDevices((command) => ({
      status: 0,
      stdout:
        command === "xcrun" ? "== Devices ==\nMacBook Pro (0000)\n" : "List of devices attached\n",
    }));

    expect(summary).toEqual({ iosDevices: [], androidDevices: [] });
    expect(resolveMobileProofDecision(summary)).toEqual({
      proofKind: MOBILE_WEB_VIEWPORT_PROOF_KIND,
      nativeDeviceRequired: false,
      deviceSummary: summary,
    });
  });

  it("detects real iOS and Android devices without counting simulators or emulators", () => {
    expect(
      parseIosDeviceLines(`== Devices ==
Matthew's iPhone (17.5) (00008110-0012345678901234)

== Simulators ==
iPhone 17 (26.4.1) (4AD73132-D268-4649-855C-5A9611A62E62)
iPhone 15 Pro (17.5) (Simulator)
iPad unavailable (17.5) (0000)`),
    ).toEqual(["Matthew's iPhone (17.5) (00008110-0012345678901234)"]);
    expect(
      parseAndroidDeviceLines("List of devices attached\nemulator-5554\tdevice\nZY2247B\tdevice\n"),
    ).toEqual(["ZY2247B\tdevice"]);
    const decision = resolveMobileProofDecision({
      androidDevices: ["ZY2247B\tdevice"],
      iosDevices: [],
    });
    expect(decision.proofKind).toBe(NATIVE_MOBILE_DEVICE_PROOF_KIND);
    expect(decision.nativeDeviceRequired).toBe(true);
  });

  it("requires visible blocked status text and rejects unsupported complete delivery", () => {
    const valid = [
      "Verified state: no user-visible payload was available.",
      "Next build gap: resolve liveness blocker.",
      "Completion Grade: 7/10",
      "Criticality: 10/10",
      "Status: blocked",
    ].join("\n");

    expect(validateVisibleBlockedText(valid)).toEqual({ ok: true, missing: [] });
    expect(validateVisibleBlockedText("Verified state: ok\nStatus: complete")).toEqual({
      ok: false,
      missing: expect.arrayContaining([
        "Next build gap",
        "Completion Grade:",
        "Criticality:",
        "Status: blocked",
        "no unsupported delivered Status: complete",
      ]),
    });
  });

  it("fails when ledger or liveness evidence is missing", () => {
    const visibleText = [
      "Verified state: no user-visible payload was available.",
      "Next build gap: resolve liveness blocker.",
      "Completion Grade: 7/10",
      "Criticality: 10/10",
      "Status: blocked",
    ].join("\n");
    const diagnostics = validateSessionDiagnostics({
      sessionKey: "agent:main",
      sessions: [
        {
          key: "agent:main",
          controlDirectorLivenessAudit: [{ action: "synthesized_blocked_no_visible_output" }],
        },
      ],
      visibleText,
    });

    expect(diagnostics).toMatchObject({
      livenessAuditPresent: true,
      missionLedgerPresent: false,
      unsupportedCompleteDelivered: false,
    });
    expect(() => assertControlDirectorNoResponseEvidence({ diagnostics, visibleText })).toThrow(
      /controlDirectorMissionLedger/,
    );
  });

  it("passes evidence validation when visible text, ledger, and liveness audit are present", () => {
    const visibleText = [
      "Verified state: no user-visible payload was available.",
      "Next build gap: resolve liveness blocker.",
      "Completion Grade: 7/10",
      "Criticality: 10/10",
      "Status: blocked",
    ].join("\n");
    const diagnostics = validateSessionDiagnostics({
      sessionKey: "agent:main",
      sessions: [
        {
          key: "agent:main",
          controlDirectorLivenessAudit: [{ action: "synthesized_blocked_no_visible_output" }],
          controlDirectorMissionLedger: [{ status: "blocked" }],
        },
      ],
      visibleText,
    });

    expect(() =>
      assertControlDirectorNoResponseEvidence({ diagnostics, visibleText }),
    ).not.toThrow();
  });
});
