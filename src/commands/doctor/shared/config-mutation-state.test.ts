// Config mutation state tests cover doctor mutation tracking and final state reporting.
import { describe, expect, it } from "vitest";
import {
  retainLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
} from "../../../config/legacy.default-agent-owner.js";
import {
  createConfigResolutionFacts,
  getConfigResolutionFacts,
  getResolvedConfigEnvSecretRef,
  resolveConfigSecretRef,
  setConfigResolutionFacts,
} from "../../../config/resolution-facts.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { applyDoctorConfigMutation } from "./config-mutation-state.js";
import type { DoctorConfigMutationState } from "./config-mutation-state.js";

const DOCTOR_FIX_HINT = 'Run "openclaw doctor --fix" to apply these changes.';

function emptyMutationState(): DoctorConfigMutationState {
  return {
    cfg: { channels: {} },
    candidate: { channels: {} },
    pendingChanges: false,
    fixHints: [],
  };
}

function enabledSignalMutation() {
  return {
    config: { channels: { signal: { enabled: true } } },
    changes: ["enabled signal"],
  };
}

describe("doctor config mutation state", () => {
  it("updates candidate and fix hints in preview mode", () => {
    const next = applyDoctorConfigMutation({
      state: emptyMutationState(),
      mutation: enabledSignalMutation(),
      shouldRepair: false,
      fixHint: DOCTOR_FIX_HINT,
    });

    expect(next).toEqual({
      cfg: { channels: {} },
      candidate: { channels: { signal: { enabled: true } } },
      pendingChanges: true,
      fixHints: ['Run "openclaw doctor --fix" to apply these changes.'],
    });
  });

  it("updates cfg directly in repair mode", () => {
    const next = applyDoctorConfigMutation({
      state: emptyMutationState(),
      mutation: enabledSignalMutation(),
      shouldRepair: true,
      fixHint: DOCTOR_FIX_HINT,
    });

    expect(next).toEqual({
      cfg: { channels: { signal: { enabled: true } } },
      candidate: { channels: { signal: { enabled: true } } },
      pendingChanges: true,
      fixHints: [],
    });
  });

  it("stays unchanged when there are no changes", () => {
    const state = emptyMutationState();

    expect(
      applyDoctorConfigMutation({
        state,
        mutation: { ...enabledSignalMutation(), changes: [] },
        shouldRepair: false,
      }),
    ).toBe(state);
  });

  it("carries the upgrade-only owner across repair mutations", () => {
    const state = emptyMutationState();
    retainLegacyDefaultAgentId(state.candidate, "ops");

    const next = applyDoctorConfigMutation({
      state,
      mutation: enabledSignalMutation(),
      shouldRepair: true,
    });

    expect(tryGetLegacyDefaultAgentId(next.candidate)).toBe("ops");
    expect(tryGetLegacyDefaultAgentId(next.cfg)).toBe("ops");
  });

  it.each([false, true])(
    "preserves loaded secret facts through mutations (repair=%s)",
    (shouldRepair) => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: {
            accounts: {
              shorthand: { botToken: "synthetic-token" },
              escaped: { botToken: "${DOCTOR_TOKEN}" },
              literal: { botToken: "synthetic-token" },
            },
          },
        },
      };
      const shorthandPath = "channels.telegram.accounts.shorthand.botToken";
      setConfigResolutionFacts(
        cfg,
        createConfigResolutionFacts(
          [],
          new Map(),
          "default",
          new Map([[shorthandPath, "DOCTOR_TOKEN"]]),
        ),
      );
      const rewritten = structuredClone(cfg);
      rewritten.gateway = { port: 19432 };
      const next = applyDoctorConfigMutation({
        state: { cfg, candidate: cfg, pendingChanges: false, fixHints: [] },
        mutation: { config: rewritten, changes: ["changed Gateway port"] },
        shouldRepair,
      });

      expect(getResolvedConfigEnvSecretRef(next.candidate, shorthandPath)?.id).toBe("DOCTOR_TOKEN");
      expect(
        resolveConfigSecretRef({
          config: next.candidate,
          path: "channels.telegram.accounts.escaped.botToken",
          value: "${DOCTOR_TOKEN}",
          includeResolved: true,
        }),
      ).toBeNull();
      expect(
        resolveConfigSecretRef({
          config: next.candidate,
          path: "channels.telegram.accounts.literal.botToken",
          value: "synthetic-token",
          includeResolved: true,
        }),
      ).toBeNull();
      expect(next.cfg).toBe(shouldRepair ? rewritten : cfg);
    },
  );

  it.each(["replace", "remove"] as const)(
    "drops invalidated secret facts when mutations %s a value",
    (operation) => {
      const cfg: OpenClawConfig = { channels: { telegram: { botToken: "synthetic-token" } } };
      const secretPath = "channels.telegram.botToken";
      setConfigResolutionFacts(
        cfg,
        createConfigResolutionFacts(
          [],
          new Map(),
          "default",
          new Map([[secretPath, "DOCTOR_TOKEN"]]),
        ),
      );
      const rewritten: OpenClawConfig =
        operation === "replace"
          ? { channels: { telegram: { botToken: "replacement-literal" } } }
          : {};
      const next = applyDoctorConfigMutation({
        state: { cfg, candidate: cfg, pendingChanges: false, fixHints: [] },
        mutation: { config: rewritten, changes: ["changed credential"] },
        shouldRepair: true,
      });

      expect(getResolvedConfigEnvSecretRef(next.cfg, secretPath)).toBeNull();
      expect(getConfigResolutionFacts(next.cfg)).not.toBeNull();
      expect(getResolvedConfigEnvSecretRef(cfg, secretPath)?.id).toBe("DOCTOR_TOKEN");
    },
  );
});
