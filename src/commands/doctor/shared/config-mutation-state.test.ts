// Config mutation state tests cover doctor mutation tracking and final state reporting.
import { describe, expect, it } from "vitest";
import {
  retainLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
} from "../../../config/legacy.default-agent-owner.js";
import {
  createConfigResolutionFacts,
  getResolvedConfigEnvSecretRef,
  resolveConfigSecretRef,
  setConfigResolutionFacts,
} from "../../../config/resolution-facts.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { retainHeartbeatMigrationInput } from "./config-migration-result.js";
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
  it.each([false, true])(
    "retains credential sources through repair preparation (repair=%s)",
    async (shouldRepair) => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: {
            accounts: {
              env: { botToken: "synthetic-token" },
              literal: { botToken: "synthetic-token" },
              escaped: { botToken: "${DOCTOR_TOKEN}" },
              replaced: { botToken: "old-token" },
              removed: { botToken: "old-token" },
            },
          },
        },
      };
      const path = (account: string) => `channels.telegram.accounts.${account}.botToken`;
      setConfigResolutionFacts(
        cfg,
        createConfigResolutionFacts(
          [],
          new Map(),
          "default",
          new Map(["env", "replaced", "removed"].map((account) => [path(account), "DOCTOR_TOKEN"])),
        ),
      );
      const candidate = await retainHeartbeatMigrationInput(cfg, undefined);
      expect(getResolvedConfigEnvSecretRef(candidate, path("env"))?.id).toBe("DOCTOR_TOKEN");
      const rewritten = structuredClone(candidate);
      rewritten.channels!.telegram!.accounts!.replaced = { botToken: "new-token" };
      rewritten.channels!.telegram!.accounts!.moved = { botToken: "old-token" };
      delete rewritten.channels!.telegram!.accounts!.removed;
      const next = applyDoctorConfigMutation({
        state: { cfg, candidate, pendingChanges: false, fixHints: [] },
        mutation: { config: rewritten, changes: ["repair credentials"] },
        shouldRepair,
      });
      const refs = ["env", "literal", "escaped", "replaced", "removed", "moved"].map(
        (account) =>
          resolveConfigSecretRef({
            config: next.candidate,
            path: path(account),
            value: next.candidate.channels?.telegram?.accounts?.[account]?.botToken,
            includeResolved: true,
          })?.id ?? null,
      );
      expect(refs).toEqual(["DOCTOR_TOKEN", null, null, null, null, null]);
      expect(next.cfg).toBe(shouldRepair ? rewritten : cfg);
      expect(getResolvedConfigEnvSecretRef(cfg, path("replaced"))?.id).toBe("DOCTOR_TOKEN");
    },
  );

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
});
