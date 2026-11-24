import { expect, test, vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../state/user-preferences.js";
import * as profileWrites from "../state/user-profile-writes.js";
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
