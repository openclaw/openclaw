import { expect, it, vi } from "vitest";
import { emitResetCommandHooks } from "../auto-reply/reply/commands-reset-hooks.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { installSessionActorMemoryEntry } from "../config/sessions/session-actor-memory-entry-install.js";
import { createSessionActorMemoryState } from "../config/sessions/session-actor-memory-state.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  pairedOperator,
  persistDevices,
  recoveryFixture,
} from "./operator-run-recovery.test-support.js";
import { recordSessionOperatorSource } from "./session-operator-sources.js";
import { triggerSessionPatchHook } from "./session-patch-hooks.js";
import { prepareSessionPrincipalRunAuthority } from "./session-sharing-authorization-async.js";

const log = { warn: (message: string) => expect.fail(message) };

async function recordedFixture(stateDir: string, scopes: string[]) {
  setRuntimeConfigSnapshot({});
  const profile = ensureProfileForEmail("untiered-principal@example.test");
  const fixture = await recoveryFixture(stateDir, profile.id, {
    device: pairedOperator(),
    scopes,
  });
  const admit = () =>
    prepareSessionPrincipalRunAuthority({
      context: fixture.context,
      profileId: profile.id,
      ...fixture.target,
      sessionPrincipal: true,
    });
  const record = () =>
    recordSessionOperatorSource({ ...fixture.target, authority: fixture.sourceAuthority, log });
  return { profile, fixture, admit, record };
}

it("admits an untiered person's session work only through their recorded, current source", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const { admit, record } = await recordedFixture(stateDir, ["operator.write"]);
    await expect(admit()).rejects.toThrow("no current run authority");

    await record();
    const admitted = await admit();
    try {
      // The original connection's scopes, never an administrator substitute.
      expect(admitted.authority.scopes).toEqual(["operator.write"]);
      expect(admitted.authority.assertCurrent).not.toThrow();
    } finally {
      admitted.release();
    }

    persistDevices(stateDir, [], "both");
    await expect(admit()).rejects.toThrow();
  }));

it("keeps recorded sources across transcript rotation and defers to configured roles", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const { profile, fixture, record } = await recordedFixture(stateDir, ["operator.admin"]);
    await record();
    await patchSessionEntryCore(fixture.target, () => ({ sessionId: "compacted-session" }), {
      skipMaintenance: true,
    });
    const rotated = await readSessionEntryReadOnlyInWorker(fixture.target);
    expect(rotated?.sessionId).toBe("compacted-session");
    expect(rotated?.operatorSources?.[profile.id]?.scopes).toEqual(["operator.admin"]);

    const reader: OpenClawConfig = {
      gateway: {
        roles: {
          default: "reader",
          definitions: {
            reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "none" } },
          },
        },
      },
    };
    fixture.setConfig(reader);
    await expect(
      prepareSessionPrincipalRunAuthority({
        context: fixture.context,
        profileId: profile.id,
        ...fixture.target,
        sessionId: "compacted-session",
        sessionPrincipal: true,
      }),
    ).rejects.toThrow("no current run authority");
  }));

it("keeps an incognito session's recorded sources through reset but not into a new node", () => {
  const target = {
    database: { kind: "memory", handle: "incognito-sources", incarnation: "1" },
    sessionKey: "agent:main:incognito:sources",
  } as const;
  const sources = { person: { profileId: "person" } } as unknown as NonNullable<
    InternalSessionEntry["operatorSources"]
  >;
  const state = createSessionActorMemoryState(target);
  installSessionActorMemoryEntry(state, { sessionId: "first", updatedAt: 1 });
  installSessionActorMemoryEntry(state, {
    sessionId: "first",
    updatedAt: 2,
    operatorSources: sources,
  });
  const reset = installSessionActorMemoryEntry(state, { sessionId: "after-reset", updatedAt: 2 });
  expect(reset.operatorSources).toEqual(sources);

  const copied = installSessionActorMemoryEntry(
    createSessionActorMemoryState({ ...target, sessionKey: "agent:main:incognito:fork" }),
    { sessionId: "fork", updatedAt: 3, operatorSources: sources },
  );
  expect(copied.operatorSources).toBeUndefined();
});

it("keeps recorded sources out of reset and patch hook payloads", async () => {
  const sources = { person: { profileId: "person" } } as unknown as NonNullable<
    InternalSessionEntry["operatorSources"]
  >;
  const entry: InternalSessionEntry = {
    sessionId: "hooked",
    updatedAt: 1,
    operatorSources: sources,
  };
  const seen: unknown[] = [];
  const handler = (event: { context: Record<string, unknown> }) => {
    seen.push(event.context.sessionEntry, event.context.previousSessionEntry);
  };
  registerInternalHook("command:reset", handler);
  registerInternalHook("session:patch", handler);
  try {
    await emitResetCommandHooks({
      action: "reset",
      ctx: {} as Parameters<typeof emitResetCommandHooks>[0]["ctx"],
      cfg: {},
      command: { surface: "webchat", senderId: "person", channel: "webchat" },
      sessionKey: "agent:main:hooked",
      sessionEntry: entry,
      previousSessionEntry: entry,
      workspaceDir: "/tmp",
    });
    triggerSessionPatchHook({
      sessionKey: "agent:main:hooked",
      sessionEntry: entry,
      patch: { key: "agent:main:hooked" },
      cfg: {},
    });
    await vi.waitFor(() => expect(seen).toHaveLength(4));
  } finally {
    unregisterInternalHook("command:reset", handler);
    unregisterInternalHook("session:patch", handler);
  }
  expect(seen.slice(0, 3)).toEqual([
    expect.objectContaining({ sessionId: "hooked" }),
    expect.objectContaining({ sessionId: "hooked" }),
    expect.objectContaining({ sessionId: "hooked" }),
  ]);
  expect(JSON.stringify(seen)).not.toContain("operatorSources");
  expect(entry.operatorSources).toBe(sources);
});
