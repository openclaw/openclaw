import { expect, it } from "vitest";
import { patchSessionEntryCore, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { installSessionActorMemoryEntry } from "../config/sessions/session-actor-memory-entry-install.js";
import { createSessionActorMemoryState } from "../config/sessions/session-actor-memory-state.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  createInternalHookEvent,
  registerInternalHook,
  unregisterInternalHook,
} from "../hooks/internal-hooks.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { pairedOperator, recoveryFixture } from "./operator-run-recovery.test-support.js";
import { recordSessionOperatorSource } from "./session-operator-sources.js";
import { triggerSessionPatchHook } from "./session-patch-hooks.js";
import { prepareSessionPrincipalRunAuthority } from "./session-sharing-authorization-async.js";

it("records only live accepted input and retains private sources on the same logical node", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const profile = ensureProfileForEmail("recorded-source@example.test");
    const fixture = await recoveryFixture(stateDir, profile.id, {
      device: pairedOperator(),
      scopes: ["operator.write"],
    });
    await expect(
      prepareSessionPrincipalRunAuthority({
        ...fixture.target,
        context: fixture.context,
        profileId: profile.id,
      }),
    ).rejects.toThrow("no current run authority");
    const principal = captureAgentTurnPrincipal(fixture.client);
    expect(principal).toBeDefined();
    const captured = await captureGatewayOperatorRunAuthority({
      client: principal,
      context: fixture.context,
      sourceAuthority: null,
    });
    expect(captured).toBeDefined();
    if (!captured) {
      throw new Error("Missing fixture authority");
    }
    const warnings: string[] = [];
    const record = (assertCurrent?: () => void) =>
      recordSessionOperatorSource({
        ...fixture.target,
        authority: captured.authority,
        assertCurrent,
        log: { warn: (message) => warnings.push(message) },
      });
    try {
      await record(() => {
        throw new Error("Target admission retired");
      });
      expect(warnings).toHaveLength(1);
      expect(
        (await readSessionEntryReadOnlyInWorker(fixture.target))?.operatorSources,
      ).toBeUndefined();
      await record();
      const stored = await readSessionEntryReadOnlyInWorker(fixture.target);
      expect(stored?.operatorSources?.[profile.id]?.scopes).toEqual(["operator.write"]);
      const sources = stored!.operatorSources!;
      await patchSessionEntryCore(fixture.target, () => ({ sessionId: "rotated" }), {
        skipMaintenance: true,
      });
      expect((await readSessionEntryReadOnlyInWorker(fixture.target))?.operatorSources).toEqual(
        sources,
      );
      const fork = { ...fixture.target, sessionKey: "agent:main:new-node" };
      await replaceSessionEntry(fork, { ...fixture.entry, operatorSources: sources });
      expect((await readSessionEntryReadOnlyInWorker(fork))?.operatorSources).toBeUndefined();
      const target = {
        database: { kind: "memory", handle: "private-source", incarnation: "1" },
        sessionKey: "agent:main:incognito:source",
      } as const;
      const memory = createSessionActorMemoryState(target);
      installSessionActorMemoryEntry(memory, fixture.entry);
      installSessionActorMemoryEntry(memory, { ...fixture.entry, operatorSources: sources });
      expect(
        installSessionActorMemoryEntry(memory, { ...fixture.entry, sessionId: "reset" })
          .operatorSources,
      ).toEqual(sources);
      expect(
        installSessionActorMemoryEntry(
          createSessionActorMemoryState({ ...target, sessionKey: "agent:main:incognito:fork" }),
          { ...fixture.entry, operatorSources: sources },
        ).operatorSources,
      ).toBeUndefined();
    } finally {
      captured.release();
    }
  }));

it("omits source evidence from reset and patch hooks without changing the stored entry", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const profile = ensureProfileForEmail("hook-source@example.test");
    const fixture = await recoveryFixture(stateDir, profile.id, { device: pairedOperator() });
    const entry = { ...fixture.entry, operatorSources: { [profile.id]: fixture.snapshot } };
    const reset = createInternalHookEvent("command", "reset", fixture.target.sessionKey, {
      sessionEntry: entry,
      previousSessionEntry: entry,
    });
    expect(reset.context.sessionEntry).not.toHaveProperty("operatorSources");
    expect(reset.context.previousSessionEntry).not.toHaveProperty("operatorSources");
    const seen: unknown[] = [];
    const handler = (event: { context: Record<string, unknown> }) => {
      seen.push(event.context.sessionEntry);
    };
    registerInternalHook("session:patch", handler);
    try {
      triggerSessionPatchHook({
        sessionKey: fixture.target.sessionKey,
        sessionEntry: entry,
        patch: { key: fixture.target.sessionKey },
        cfg: {},
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toHaveProperty("operatorSources");
      expect(entry.operatorSources[profile.id]).toBe(fixture.snapshot);
    } finally {
      unregisterInternalHook("session:patch", handler);
    }
  }));
