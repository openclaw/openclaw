import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { UsersPersonalFileGetResult } from "../../packages/gateway-protocol/src/index.js";
import { waitForGatewayStartup } from "../../test/helpers/gateway-startup.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as safeFs from "../infra/fs-safe.js";
import { createDeferredCore } from "../shared/deferred.js";
import { hasMultipleResidentSessionSharingIdentities } from "../state/user-profile-list.js";
import {
  mergeCanonicalUserProfiles,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import * as gateway from "./server.auth.test-helpers.js";

gateway.installGatewayTestHooks({ scope: "suite" });
const temps = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

test("session-only members edit their own instructions without shared file access", async () => {
  const workspace = await fs.realpath(temps.make("personal-instructions-scopes-"));
  await fs.writeFile(path.join(workspace, "USER.md"), "Shared defaults");
  gateway.testState.agentConfig = { workspace };
  const alice = "alice@example.test";
  const bob = "bob@example.test";
  const charlie = "charlie@example.test";
  await gateway.configureBrowserAuth(
    gateway.browserProxyAuth({
      identityScopes: {
        [alice]: ["operator.sessions.read"],
        [bob]: ["operator.sessions.write"],
        [charlie]: ["operator.sessions.read"],
      },
    }),
    {
      roles: {
        default: "member",
        definitions: {
          member: {
            scopes: ["operator.sessions.write"],
            agents: ["main"],
            sessions: { others: "none" },
          },
          revoked: { scopes: [], agents: [], sessions: { others: "none" } },
        },
      },
    },
  );
  await gateway.withGatewayServer(async ({ port }) => {
    await waitForGatewayStartup(port);
    async function connect(email: string, scope: string) {
      const ws = await gateway.openWs(port, {
        ...gateway.TRUSTED_BROWSER_HEADERS,
        "x-forwarded-user": email,
      });
      try {
        const connected = await gateway.connectReq(ws, {
          prePairDevice: true,
          client: gateway.CONTROL_UI_CLIENT,
          browserOrigin: gateway.BROWSER_ORIGIN,
          skipDefaultAuth: true,
          scopes: [scope],
          deviceIdentityPath: path.join(
            temps.make("personal-member-"),
            "client",
            "credentials.sqlite",
          ),
        });
        expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
        return { ws, [Symbol.dispose]: () => ws.close() };
      } catch (error) {
        ws.close();
        throw error;
      }
    }
    using reader = await connect(alice, "operator.sessions.read");
    using writer = await connect(bob, "operator.sessions.write");
    // Keep multi-user eligibility after merging the original requester into Bob.
    using peer = await connect(charlie, "operator.sessions.read");
    const profiles: string[] = [];
    for (const [connection, content] of [
      [reader, "Prefer concise answers."],
      [writer, "Prefer worked examples."],
    ] as const) {
      const initial = await gateway.rpcReq<UsersPersonalFileGetResult>(
        connection.ws,
        "users.personalFile.get",
        { agentId: "main" },
      );
      expect(initial.ok, JSON.stringify(initial.error)).toBe(true);
      expect(initial.payload).toMatchObject({ missing: true, hash: null, content: "" });
      const profileId = initial.payload!.profileId;
      profiles.push(profileId);
      const saved = await gateway.rpcReq(connection.ws, "users.personalFile.set", {
        agentId: "main",
        content,
        expectedHash: null,
      });
      expect(saved.ok, JSON.stringify(saved.error)).toBe(true);
      expect(await fs.readFile(path.join(workspace, "users", profileId, "USER.md"), "utf8")).toBe(
        content,
      );
      const reloaded = await gateway.rpcReq(connection.ws, "users.personalFile.get", {
        agentId: "main",
      });
      expect(reloaded.payload).toMatchObject({ profileId, content, missing: false });
      const shared = await gateway.rpcReq(connection.ws, "agents.files.set", {
        agentId: "main",
        name: "USER.md",
        content: "Unauthorized shared instructions",
      });
      expect(shared).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    }
    expect(new Set(profiles).size).toBe(2);
    const otherProfile = await gateway.rpcReq(reader.ws, "users.personalFile.set", {
      agentId: "main",
      profileId: profiles[1],
      content: "Unauthorized personal instructions",
      expectedHash: null,
    });
    expect(otherProfile.ok).toBe(false);
    expect(await fs.readFile(path.join(workspace, "users", profiles[1]!, "USER.md"), "utf8")).toBe(
      "Prefer worked examples.",
    );
    expect(await fs.readFile(path.join(workspace, "USER.md"), "utf8")).toBe("Shared defaults");

    for (const change of ["role revocation", "profile merge"] as const) {
      const current = await gateway.rpcReq<UsersPersonalFileGetResult>(
        reader.ws,
        "users.personalFile.get",
        { agentId: "main" },
      );
      expect(current.ok, JSON.stringify(current.error)).toBe(true);
      const prepared = createDeferredCore();
      const resume = createDeferredCore();
      const openRoot = safeFs.root;
      using observation = vi.spyOn(safeFs, "root");
      observation.mockImplementation(async (...args) => {
        const handle = await openRoot(...args);
        if (args[0] === workspace) {
          const write = handle.write.bind(handle);
          // Pause only I/O after the handler's preparation and hash check. Keep the real
          // profile catalog, committed writer, filesystem and final authority callback.
          vi.spyOn(handle, "write").mockImplementation(async (...writeArgs) => {
            prepared.resolve();
            await resume.promise;
            return write(...writeArgs);
          });
        }
        return handle;
      });
      const pending = gateway.rpcReq(reader.ws, "users.personalFile.set", {
        agentId: "main",
        content: "Must not reach either personal file",
        expectedHash: current.payload!.hash,
      });
      try {
        await awaitGateBeforeSettlement(prepared.promise, pending, "Save was not prepared");
        if (change === "role revocation") {
          await setCanonicalUserProfileRole(profiles[0]!, "revoked");
        } else {
          const merged = await mergeCanonicalUserProfiles(profiles[0]!, profiles[1]!);
          expect(merged.profile.id).toBe(profiles[1]);
        }
        expect(hasMultipleResidentSessionSharingIdentities()).toBe(true);
        expect((await gateway.rpcReq(peer.ws, "users.self", {})).ok).toBe(true);
      } finally {
        resume.resolve();
      }
      expect(await pending).toMatchObject({
        ok: false,
        error: { code: expect.stringMatching(/^(FORBIDDEN|UNAVAILABLE)$/) },
      });
      for (const [profileId, content] of [
        [profiles[0]!, "Prefer concise answers."],
        [profiles[1]!, "Prefer worked examples."],
      ]) {
        expect(
          await fs.readFile(path.join(workspace, "users", profileId!, "USER.md"), "utf8"),
        ).toBe(content);
      }
      expect(await fs.readFile(path.join(workspace, "USER.md"), "utf8")).toBe("Shared defaults");
      if (change === "role revocation") {
        await setCanonicalUserProfileRole(profiles[0]!, null);
      }
      console.info(
        `[personal-instructions] committed ${change}: prepared save rejected; all files unchanged`,
      );
    }
  });
});
