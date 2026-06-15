import { describe, expect, it } from "vitest";
import {
  assertControlDirectorNoResponseEvidence,
  buildControlDirectorNoResponseSmokeCommand,
  collectControlDirectorSmokeVisibleText,
  detectMobileDevices,
  MOBILE_WEB_VIEWPORT_PROOF_KIND,
  mobileDeviceDetectionCommands,
  NATIVE_MOBILE_DEVICE_PROOF_KIND,
  parseAndroidDeviceLines,
  parseIosDeviceLines,
  resolveMobileProofDecision,
  extractControlDirectorSmokeHistoryMessages,
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

  it("requires visible recovery status text and rejects unsupported complete delivery", () => {
    const valid = [
      "Verified state: no user-visible payload was available.",
      "Next build gap: resolve liveness blocker.",
      "Completion Grade: 7/10",
      "Criticality: 10/10",
      "Status: continuing",
    ].join("\n");

    expect(validateVisibleBlockedText(valid)).toEqual({ ok: true, missing: [] });
    expect(validateVisibleBlockedText("Verified state: ok\nStatus: complete")).toEqual({
      ok: false,
      missing: expect.arrayContaining([
        "Next build gap",
        "Completion Grade:",
        "Criticality:",
        "Status: continuing",
        "no unsupported delivered Status: complete",
      ]),
    });
  });

  it("extracts persisted history text for the no-response fallback", () => {
    const history = {
      messages: [
        { role: "user", content: "empty response exhaustion qa check" },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "Verified state: no user-visible payload was available.",
                "Next build gap: resolve liveness blocker.",
                "Completion Grade: 7/10",
                "Criticality: 10/10",
                "Status: continuing",
              ].join("\n"),
            },
          ],
        },
      ],
    };

    const messages = extractControlDirectorSmokeHistoryMessages(history);
    const visibleText = collectControlDirectorSmokeVisibleText(messages);

    expect(messages).toHaveLength(2);
    expect(validateVisibleBlockedText(visibleText)).toEqual({ ok: true, missing: [] });
  });

  it("fails when ledger or liveness evidence is missing", () => {
    const visibleText = [
      "Verified state: no user-visible payload was available.",
      "Next build gap: resolve liveness blocker.",
      "Completion Grade: 7/10",
      "Criticality: 10/10",
      "Status: continuing",
    ].join("\n");
    const diagnostics = validateSessionDiagnostics({
      sessionKey: "agent:main",
      sessions: [
        {
          key: "agent:main",
          controlDirectorLivenessAudit: [{ action: "queued_safe_continuation" }],
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
      "Status: continuing",
    ].join("\n");
    const diagnostics = validateSessionDiagnostics({
      sessionKey: "agent:main",
      sessions: [
        {
          key: "agent:main",
          controlDirectorLivenessAudit: [{ action: "queued_safe_continuation" }],
          controlDirectorMissionLedger: [{ status: "continuation_queued" }],
        },
      ],
      visibleText,
    });

    expect(() =>
      assertControlDirectorNoResponseEvidence({ diagnostics, visibleText }),
    ).not.toThrow();
  });
});
