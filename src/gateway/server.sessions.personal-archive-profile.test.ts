import { expect, test, vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../state/user-preferences.js";
import * as profileWrites from "../state/user-profile-writes.js";
import * as lifecycle from "./server-methods/sessions-lifecycle-drain.js";
import {
  connectReq,
  installGatewayTestHooks,
  openWs,
  rpcReq,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

test("a signed native owner can still archive without claiming a personal pin outcome when its profile is unavailable", async () => {
  await withGatewayServer(async ({ port }) => {
    const key = "agent:main:archive-profile-outage";
    const target = { agentId: "main", sessionKey: key };
    const sessionId = "native-archive-profile-outage";
    const layout = ["route:usage", `session:${key}`];
    const pref = "ui.railShortcuts";
    // Outage is limited to identifying this connection, not the existing layout or session store.
    await profileWrites.ensureCanonicalGatewayOwnerProfile("Test owner");
    expect(
      (await setCanonicalUserPreferences(GATEWAY_OWNER_PROFILE_ID, { [pref]: layout }))?.ok,
    ).toBe(true);
    await upsertSessionEntryCore(target, { sessionId, updatedAt: 1, visibility: "shared" });
    const socket = await openWs(port);
    using outage = vi
      .spyOn(profileWrites, "ensureCanonicalGatewayOwnerProfile")
      .mockRejectedValueOnce(new Error("profile storage unavailable"));
    const hello = await connectReq(socket, {
      client: { id: "openclaw-macos", version: "test", platform: "macos", mode: "ui" },
      caps: ["personal-session-pins"],
      prePairDevice: true,
    });
    expect(hello.ok, hello.error?.message).toBe(true);
    expect(outage).toHaveBeenCalledOnce();
    expect((hello.payload as HelloOk).features.capabilities).toContain("personal-archive-pins");
    const stale = await rpcReq(socket, "sessions.patch", {
      key,
      expectedSessionId: "previous-incarnation",
      archived: true,
      retirePersonalPin: true,
    });
    expect(stale.ok).toBe(false);
    expect(loadSessionEntry(target)?.archivedAt).toBeUndefined();
    const archive = await rpcReq(socket, "sessions.patch", {
      key,
      expectedSessionId: sessionId,
      archived: true,
      retirePersonalPin: true,
    });
    expect(archive.ok, archive.error?.message).toBe(true);
    const stored = loadSessionEntry(target);
    expect(stored).toMatchObject({ sessionId, archivedAt: expect.any(Number) });
    expect(archive.payload).toMatchObject({
      archivePin: "unknown",
      archivedAt: stored?.archivedAt,
    });
    expect(archive.payload).not.toHaveProperty("archivePinUndo");
    expect(
      (await getCanonicalUserPreferences(GATEWAY_OWNER_PROFILE_ID, [pref]))?.entries[pref],
    ).toEqual(layout);
  });
});

test("archive confirms even absent pin slots against another connection’s latest layout", async () => {
  await withGatewayServer(async ({ port }) => {
    const native = await openWs(port);
    const editor = await openWs(port);
    for (const [socket, id] of [
      [native, "openclaw-macos"],
      [editor, "openclaw-android"],
    ] as const) {
      const hello = await connectReq(socket, {
        client: { id, mode: "ui", platform: "test", version: "test" },
        caps: ["personal-session-pins"],
        prePairDevice: true,
      });
      expect(hello.ok, hello.error?.message).toBe(true);
    }
    const pref = "ui.railShortcuts";
    const save = async (layout: unknown[] | null) => {
      const response = await rpcReq(editor, "users.prefs.set", { entries: { [pref]: layout } });
      expect(response.payload).toMatchObject({ status: "ok" });
    };
    const drain = lifecycle.prepareSessionLifecycleDrain;
    for (const scenario of ["absent", "new pin", "mixed batch"] as const) {
      const keys = (scenario === "mixed batch" ? ["alpha", "beta"] : ["alpha"]).map(
        (k) => `agent:main:${scenario.replaceAll(" ", "-")}-${k}`,
      );
      const targets = keys.map((key) => ({ key, expectedSessionId: key }));
      for (const key of keys) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: key },
          { sessionId: key, updatedAt: 1, visibility: "shared" },
        );
      }
      const base = keys.length === 2 ? [`session:${keys[1]}`, "route:usage"] : null;
      const newer = [...(base ?? []), `session:${keys[0]}`];
      await save(base);
      using interleave = vi.spyOn(lifecycle, "prepareSessionLifecycleDrain");
      if (scenario !== "absent") {
        interleave.mockImplementationOnce(async (args) => {
          await save(newer);
          return drain(args);
        });
      }
      const response = await rpcReq(native, "sessions.patchMany", {
        targets,
        patch: { archived: true, retirePersonalPin: true },
      });
      expect(response.ok, response.error?.message).toBe(true);
      const archivePin = scenario === "absent" ? "unchanged" : "conflict";
      expect(response.payload).toMatchObject({
        outcomes: keys.map((key) => ({
          key,
          ok: true,
          archivePin,
          archivedAt: expect.any(Number),
        })),
      });
      expect(response.payload).not.toHaveProperty("archivePinUndo");
      for (const key of keys) {
        expect(loadSessionEntry({ agentId: "main", sessionKey: key })?.archivedAt).toEqual(
          expect.any(Number),
        );
      }
      expect(
        (await getCanonicalUserPreferences(GATEWAY_OWNER_PROFILE_ID, [pref]))?.entries[pref],
      ).toEqual(scenario === "absent" ? undefined : newer);
    }
  });
});
