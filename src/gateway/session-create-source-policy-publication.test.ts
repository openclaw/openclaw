import { expect, it, vi } from "vitest";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "./session-create-service.js";

const sourcePolicy: OpenClawConfig = {
  session: { sharing: { accessPolicy: { default: "creator" } } },
};

it.each(["source-authority", "sharing-default"] as const)(
  "rejects %s revocation before first save and emits no row",
  async (revocation) => {
    await withOpenClawTestState({ label: "source-policy-before-save" }, async () => {
      const key =
        revocation === "source-authority"
          ? "agent:main:telegram:group:source-policy-fixture"
          : "agent:main:dashboard:source-policy-fixture";
      let currentCfg: OpenClawConfig = sourcePolicy;
      const cfg = currentCfg;
      const scopes = revocation === "source-authority" ? ["operator.admin"] : [];
      const publications: unknown[] = [];
      const stop = sessionChanges.subscribeProjection((change) => {
        if ("sessionKey" in change && change.sessionKey === key) {
          publications.push(change);
        }
      });
      const created = vi.fn();
      let revoked = false;
      try {
        await expect(
          createGatewaySession({
            cfg,
            getCurrentConfig: () => currentCfg,
            key,
            commandSource: "test",
            operatorRoleActor: { kind: "operator", profileId: "creator" },
            requestingOperatorProfileId: "creator",
            requestingOperatorScopes: scopes,
            onPhase(phase) {
              if (phase === "writerAdmission" || phase === "commit") {
                revoked = true;
                if (revocation === "source-authority") {
                  scopes.splice(0);
                } else {
                  currentCfg = {};
                }
              }
            },
            onCreatedSessionCommitted: created,
          }),
        ).rejects.toThrow(
          revocation === "source-authority"
            ? "Channel session keys require trusted ingress"
            : "session creation sharing policy changed",
        );
        expect(revoked).toBe(true);
        expect(loadSessionEntryReadOnly({ sessionKey: key })).toBeUndefined();
        expect(publications).toEqual([]);
        expect(created).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    });
  },
);

it("observes a source-bound row only after successful creation", async () => {
  await withOpenClawTestState({ label: "source-policy-publication-control" }, async () => {
    const key = "agent:main:dashboard:source-policy-control";
    const publications: unknown[] = [];
    const stop = sessionChanges.subscribeProjection((change) => {
      if ("sessionKey" in change && change.sessionKey === key) {
        publications.push(change);
      }
    });
    try {
      const result = await createGatewaySession({
        cfg: sourcePolicy,
        key,
        commandSource: "test",
        operatorRoleActor: { kind: "operator", profileId: "creator" },
        requestingOperatorProfileId: "creator",
      });
      expect(result.ok).toBe(true);
      expect(loadSessionEntryReadOnly({ sessionKey: key })?.access).toEqual({ mode: "source" });
      expect(publications.length).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });
});
