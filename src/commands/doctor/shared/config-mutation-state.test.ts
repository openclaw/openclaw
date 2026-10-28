import { expect, it } from "vitest";
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

function emptyMutationState(cfg: OpenClawConfig = { channels: {} }): DoctorConfigMutationState {
  return { cfg, candidate: structuredClone(cfg), pendingChanges: false, fixHints: [] };
}

function enabledSignalMutation() {
  return {
    config: { channels: { signal: { enabled: true } } },
    changes: ["enabled signal"],
  };
}
const token = (botToken: string) => ({ botToken });

it.each([false, true])(
  "retains credential sources through repair preparation (repair=%s)",
  async (shouldRepair) => {
    const accounts = {
      env: token("synthetic-token"),
      literal: token("synthetic-token"),
      escaped: token("${DOCTOR_TOKEN}"),
      replaced: token("old-token"),
      removed: token("old-token"),
    };
    const cfg: OpenClawConfig = { channels: { telegram: { accounts } } };
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
    const rewrittenAccounts = rewritten.channels!.telegram!.accounts!;
    rewrittenAccounts.replaced = token("new-token");
    rewrittenAccounts.moved = token("old-token");
    delete rewrittenAccounts.removed;
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

it.each([false, true])("updates config and fix hints (repair=%s)", (shouldRepair) => {
  const state = emptyMutationState();
  expect(
    applyDoctorConfigMutation({
      state,
      mutation: { ...enabledSignalMutation(), changes: [] },
      shouldRepair,
    }),
  ).toBe(state);
  retainLegacyDefaultAgentId(state.candidate, "ops");
  const mutation = enabledSignalMutation();
  const next = applyDoctorConfigMutation({
    state,
    mutation,
    shouldRepair,
    fixHint: DOCTOR_FIX_HINT,
  });

  expect(next).toEqual({
    cfg: shouldRepair ? mutation.config : { channels: {} },
    candidate: mutation.config,
    pendingChanges: true,
    fixHints: shouldRepair ? [] : [DOCTOR_FIX_HINT],
  });
  expect(tryGetLegacyDefaultAgentId(next.candidate)).toBe("ops");
  expect(tryGetLegacyDefaultAgentId(next.cfg)).toBe(shouldRepair ? "ops" : undefined);
});
