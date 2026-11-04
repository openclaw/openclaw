import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  projectExecutionSessionEntry,
  projectPublicSessionEntry,
} from "../config/sessions/session-entry-projection.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { invalidateGatewayDeviceRevocation } from "./device-revocation.js";
import {
  pairedOperator,
  persistDevices,
  recoveryFixture,
} from "./operator-run-recovery.test-support.js";
import { prepareSessionPrincipalRunAuthority } from "./session-sharing-authorization-async.js";

it("restores persisted untiered session authority but keeps configured roles and device revocation authoritative", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    setRuntimeConfigSnapshot({});
    const profile = ensureProfileForEmail("untiered-person@example.test");
    const fixture = await recoveryFixture(stateDir, profile.id, {
      device: pairedOperator(),
      scopes: ["operator.write"],
    });
    // Persisted source, not the live socket or the previously released run grant.
    await replaceSessionEntry(fixture.target, {
      ...fixture.entry,
      operatorSources: { [profile.id]: fixture.snapshot },
    });
    const admit = () =>
      prepareSessionPrincipalRunAuthority({
        context: fixture.context,
        profileId: profile.id,
        ...fixture.target,
        sessionPrincipal: true,
      });
    const admitted = await admit();
    try {
      expect(admitted.authority.scopes).toEqual(["operator.write"]);
      expect(admitted.authority.assertCurrent).not.toThrow();
      invalidateGatewayDeviceRevocation(fixture.context, "recovery-device", "operator");
      persistDevices(stateDir, [], "both");
      expect(admitted.authority.assertCurrent).toThrow();
    } finally {
      admitted.release();
    }
    await expect(admit()).rejects.toThrow();
    fixture.setConfig({
      gateway: {
        roles: {
          default: "reader",
          definitions: {
            reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "none" } },
          },
        },
      },
    });
    await expect(admit()).rejects.toThrow("no current run authority");
  }));

it("never exposes persisted operator sources in public or execution projections", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    setRuntimeConfigSnapshot({});
    const profile = ensureProfileForEmail("private-source@example.test");
    const fixture = await recoveryFixture(stateDir, profile.id, { device: pairedOperator() });
    const entry = { ...fixture.entry, operatorSources: { [profile.id]: fixture.snapshot } };
    await replaceSessionEntry(fixture.target, entry);
    const stored = await readSessionEntryReadOnlyInWorker(fixture.target);
    expect(stored).toMatchObject({ operatorSources: entry.operatorSources });
    expect(projectPublicSessionEntry(entry)).not.toHaveProperty("operatorSources");
    expect(projectExecutionSessionEntry(entry)).not.toHaveProperty("operatorSources");
  }));
