import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { UsersPersonalFileGetResult } from "../../packages/gateway-protocol/src/index.js";
import { waitForGatewayStartup } from "../../test/helpers/gateway-startup.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as gateway from "./server.auth.test-helpers.js";

gateway.installGatewayTestHooks({ scope: "suite" });
const temps = useAutoCleanupTempDirTracker(afterEach);

test("session-only members edit their own instructions without shared file access", async () => {
  const workspace = await fs.realpath(temps.make("personal-instructions-scopes-"));
  await fs.writeFile(path.join(workspace, "USER.md"), "Shared defaults");
  gateway.testState.agentConfig = { workspace };
  const alice = "alice@example.test";
  const bob = "bob@example.test";
  await gateway.configureBrowserAuth(
    gateway.browserProxyAuth({
      identityScopes: {
        [alice]: ["operator.sessions.read"],
        [bob]: ["operator.sessions.write"],
      },
    }),
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
  });
});
