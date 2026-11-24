import { expect, it, vi } from "vitest";
import { UI_RAIL_SHORTCUTS_PREFERENCE_KEY as PREF } from "../../../packages/gateway-protocol/src/schema/ui-navigation-preferences.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as preferences from "../../state/user-preferences.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import * as lifecycle from "./sessions-lifecycle-drain.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
} from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

const own = "agent:main:own";
const invited = "agent:main:invited";
const unseen = "agent:main:unseen";
const scope = (sessionKey: string) => ({ agentId: "main", sessionKey });

async function fixture() {
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} } },
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: {
            agents: "*",
            scopes: ["operator.read", "operator.write"],
            sessions: { others: "invited" },
          },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(cfg);
  const viewer = ensureProfileForEmail("viewer@pin-admission.test").id;
  const other = ensureProfileForEmail("owner@pin-admission.test").id;
  const client = identifiedClient(viewer);
  client.connect.caps = ["personal-session-pins"];
  for (const key of [own, invited, unseen]) {
    await upsertSessionEntryCore(scope(key), {
      sessionId: key,
      updatedAt: 1,
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: key === own ? viewer : other },
    });
  }
  const invite = (key: string) =>
    addSessionMember(scope(key), { identityId: viewer, addedBy: other });
  await invite(invited);
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  await initializeSessionReadContext(context);
  expect(
    (await preferences.setCanonicalUserPreferences(viewer, { [PREF]: ["route:usage"] }))?.ok,
  ).toBe(true);
  return {
    client,
    viewer,
    invite,
    switchViewer: () => {
      client.authenticatedUserProfile = identifiedClient(other).authenticatedUserProfile;
    },
    revoke: () => removeSessionMember(scope(invited), viewer),
    layout: async () =>
      (await preferences.getCanonicalUserPreferences(viewer, [PREF]))?.entries[PREF],
    pins: async () =>
      (
        await listSessions({ client, context, request: { agentId: "main", pinned: true } })
      ).sessions.map((row) => row.key),
    async patch(
      method: "sessions.patchMany" | "sessions.patch",
      params: Record<string, unknown>,
      direct = false,
      signal?: AbortSignal,
    ) {
      const respond = vi.fn<RespondFn>();
      const options = {
        req: { type: "req" as const, id: "admission", method, params },
        params,
        client,
        context,
        respond,
        signal,
        isWebchatConnect: () => false,
      };
      if (direct) {
        await sessionMutationHandlers[method]!(options);
      } else {
        await handleGatewayRequest(options);
      }
      expect(respond).toHaveBeenCalledTimes(1);
      const [ok, result, error] = respond.mock.calls[0]!;
      if (!ok) {
        throw new Error(error?.message ?? "RPC failed");
      }
      return result;
    },
  };
}

it.each(["routed", "direct"] as const)(
  "%s personal pin batch keeps the admitted invitations, not later membership changes",
  (route) =>
    withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const f = await fixture();
      const direct = route === "direct";
      const read = preferences.getCanonicalUserPreferences;
      using intercept = vi
        .spyOn(preferences, "getCanonicalUserPreferences")
        .mockImplementationOnce(async (...args) => {
          const prefs = await read(...args);
          await f.revoke();
          await f.invite(unseen);
          return prefs;
        });
      // Router admission rejects an initially unauthorized batch before handler dispatch.
      // Direct handlers have no router witness and must qualify each supplied target themselves.
      const keys = direct ? [invited, unseen, own] : [invited, own];
      await expect(
        f.patch(
          "sessions.patchMany",
          { targets: keys.map((key) => ({ key })), patch: { pinned: true } },
          direct,
        ),
      ).resolves.toEqual({
        outcomes: [
          { key: invited, ok: true },
          ...(direct
            ? [
                {
                  key: unseen,
                  ok: false,
                  error: { code: "INVALID_REQUEST", message: "Session not found or not visible." },
                },
              ]
            : []),
          { key: own, ok: true },
        ],
      });
      expect(intercept).toHaveBeenCalledOnce();
      expect(await f.layout()).toEqual(["route:usage", `session:${invited}`, `session:${own}`]);
      expect(await f.pins()).toEqual([own]);
      await expect(f.patch("sessions.patch", { key: invited, pinned: false })).rejects.toThrow(
        /not found/i,
      );
      await expect(f.patch("sessions.patch", { key: unseen, pinned: true })).resolves.toMatchObject(
        { entry: { pinned: true } },
      );
      expect(await f.pins()).toEqual([own, unseen]);
    }),
);

it.each(["Stop", "requester change", "snooze", "replacement"] as const)(
  "%s before preference write still prevents an admitted pin",
  (change) =>
    withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const f = await fixture();
      const stop = new AbortController();
      const write = preferences.setCanonicalUserPreferences;
      using intercept = vi
        .spyOn(preferences, "setCanonicalUserPreferences")
        .mockImplementationOnce(async (...args) => {
          if (change === "Stop") {
            stop.abort(new Error("pin request stopped"));
          } else if (change === "requester change") {
            f.switchViewer();
          } else {
            await upsertSessionEntryCore(
              scope(own),
              change === "snooze"
                ? { snoozedUntil: Date.now() + 86_400_000 }
                : { sessionId: "replacement" },
            );
          }
          return write(...args);
        });
      await expect(
        f.patch(
          "sessions.patch",
          { key: own, expectedSessionId: own, pinned: true },
          false,
          stop.signal,
        ),
      ).rejects.toThrow(change === "Stop" ? /stopped/i : /changed/i);
      expect(intercept).toHaveBeenCalledOnce();
      expect(await f.layout()).toEqual(["route:usage"]);
    }),
);

const archive = { key: own, expectedSessionId: own, archived: true, retirePersonalPin: true };
const pin = `session:${own}`;
const tail = [{ future: true }, `session-rail:${own}`];

it("undoes only a retired personal pin, in its original slot, without rebasing a newer layout", () =>
  withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const f = await fixture();
    f.client.connect.client = { ...f.client.connect.client, id: "openclaw-macos", mode: "ui" };
    f.client.connId = "mac";
    for (const changed of [false, true]) {
      expect(
        (await preferences.setCanonicalUserPreferences(f.viewer, { [PREF]: [pin, ...tail] }))?.ok,
      ).toBe(true);
      const receipt = await f.patch("sessions.patch", archive);
      expect(receipt).toMatchObject({
        archivePin: "removed",
        archivePinUndo: expect.any(String),
        archivedAt: expect.any(Number),
      });
      const { archivePinUndo, archivedAt } = receipt as {
        archivePinUndo: string;
        archivedAt: number;
      };
      expect(await f.layout()).toEqual(tail);
      if (changed) {
        expect(
          (await preferences.setCanonicalUserPreferences(f.viewer, { [PREF]: tail.toReversed() }))
            ?.ok,
        ).toBe(true);
      }
      await f.patch("sessions.patch", {
        key: own,
        expectedSessionId: own,
        archived: false,
        expectedArchived: true,
        expectedArchivedAt: archivedAt,
      });
      expect(await f.pins()).not.toContain(own);
      const undo = f.patch("sessions.patch", {
        key: own,
        expectedSessionId: own,
        expectedArchived: false,
        pinned: true,
        archivePinUndo,
      });
      if (changed) {
        await expect(undo).rejects.toThrow();
        expect(await f.layout()).toEqual(tail.toReversed());
      } else {
        await expect(undo).resolves.toMatchObject({ entry: { sessionId: own, pinned: true } });
        expect(await f.layout()).toEqual([pin, ...tail]);
      }
    }
  }));

it("reports an archive that committed before its pin cleanup conflicted or lost acknowledgement", () =>
  withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const f = await fixture();
    f.client.connect.client = { ...f.client.connect.client, id: "openclaw-android", mode: "ui" };
    f.client.connId = "tablet";
    const write = preferences.setCanonicalUserPreferences;
    const start = lifecycle.prepareSessionLifecycleDrain;
    for (const result of ["conflict", "unknown"]) {
      expect((await write(f.viewer, { [PREF]: [pin, ...tail] }))?.ok).toBe(true);
      using drain = vi.spyOn(lifecycle, "prepareSessionLifecycleDrain");
      using cleanup = vi.spyOn(preferences, "setCanonicalUserPreferences");
      if (result === "conflict") {
        drain.mockImplementationOnce(async (params) => {
          // A newer edit lands after admission and before this archive can commit.
          expect((await write(f.viewer, { [PREF]: [...tail, pin] }))?.ok).toBe(true);
          return start(params);
        });
      } else {
        cleanup.mockImplementationOnce(async (...args) => {
          // Both SQLite commits succeeded, but the preference owner's ACK was lost.
          expect((await write(...args))?.ok).toBe(true);
          throw new Error("acknowledgement unavailable");
        });
      }
      const receipt = await f.patch("sessions.patch", archive);
      const persisted = loadSessionEntry(scope(own));
      expect(persisted).toMatchObject({ sessionId: own, archivedAt: expect.any(Number) });
      expect(receipt).toMatchObject({ archivePin: result, archivedAt: persisted?.archivedAt });
      expect(receipt).not.toHaveProperty("archivePinUndo");
      expect(cleanup).toHaveBeenCalledOnce();
      expect(await f.layout()).toEqual(result === "conflict" ? [...tail, pin] : tail);
      await f.patch("sessions.patch", { key: own, expectedSessionId: own, archived: false });
    }
  }));
