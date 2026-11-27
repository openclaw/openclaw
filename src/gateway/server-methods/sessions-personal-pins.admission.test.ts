import { expect, it, vi } from "vitest";
import { UI_RAIL_SHORTCUTS_PREFERENCE_KEY as PREF } from "../../../packages/gateway-protocol/src/schema/ui-navigation-preferences.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
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
      const targets = keys.map((key) => ({ key }));
      const patch = { pinned: true };
      const error = { code: "INVALID_REQUEST", message: "Session not found or not visible." };
      await expect(f.patch("sessions.patchMany", { targets, patch }, direct)).resolves.toEqual({
        outcomes: [
          { key: invited, ok: true },
          ...(direct ? [{ key: unseen, ok: false, error }] : []),
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

it.each(["read", "write"] as const)(
  "a target archived during preference %s does not block its sibling",
  (stage) =>
    withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const f = await fixture();
      const archive = () => upsertSessionEntryCore(scope(invited), { archivedAt: Date.now() });
      const read = preferences.getCanonicalUserPreferences;
      const write = preferences.setCanonicalUserPreferences;
      using intercept =
        stage === "read"
          ? vi
              .spyOn(preferences, "getCanonicalUserPreferences")
              .mockImplementationOnce(async (...args) => {
                const result = await read(...args);
                await archive();
                return result;
              })
          : vi
              .spyOn(preferences, "setCanonicalUserPreferences")
              .mockImplementationOnce(async (...args) => {
                await archive();
                return write(...args);
              });
      const result = await f.patch("sessions.patchMany", {
        targets: [{ key: invited }, { key: own }],
        patch: { pinned: true },
      });
      expect(intercept).toHaveBeenCalled();
      expect(result).toMatchObject({
        outcomes: [
          { key: invited, ok: false, error: { code: "INVALID_REQUEST" } },
          { key: own, ok: true },
        ],
      });
      expect(await f.layout()).toEqual(["route:usage", `session:${own}`]);
    }),
);

it.each(["Stop", "snooze", "replacement"] as const)(
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

it("an admitted pin commits for its original requester after the connection switches profile", () =>
  withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const f = await fixture();
    const write = preferences.setCanonicalUserPreferences;
    using intercept = vi
      .spyOn(preferences, "setCanonicalUserPreferences")
      .mockImplementationOnce(async (...args) => {
        f.switchViewer();
        return write(...args);
      });
    await expect(
      f.patch("sessions.patchMany", {
        targets: [{ key: own, expectedSessionId: own }],
        patch: { pinned: true },
      }),
    ).resolves.toEqual({ outcomes: [{ key: own, ok: true }] });
    expect(intercept).toHaveBeenCalledOnce();
    expect(intercept.mock.calls[0]?.[0]).toBe(f.viewer);
    expect(await f.layout()).toEqual(["route:usage", `session:${own}`]);
  }));
