import { expect, test } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import {
  agentDiscoveryMock,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

type SpeedFields = { fastMode?: boolean | string; effectiveFastMode?: boolean | string };

test("session wire speed negotiation preserves canonical ultrafast across legacy and current clients", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentConfig = { fastModeDefault: "ultrafast", model: "openai/gpt-test-a" };
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [{ id: "gpt-test-a", name: "Speed fixture", provider: "openai" }];
  await writeSessionStore({
    entries: { main: sessionStoreEntry("speed-session", { fastMode: "ultrafast" }) },
  });
  const legacy = await openClient({ caps: [] });
  const current = await openClient({ caps: ["ultrafast"] });
  const key = "agent:main:main";
  try {
    for (const [ws, expected] of [
      [legacy.ws, true],
      [current.ws, "ultrafast"],
    ] as const) {
      const list = await rpcReq<{ sessions: Array<SpeedFields & { key: string }> }>(
        ws,
        "sessions.list",
        {},
      );
      expect(list.ok).toBe(true);
      expect(list.payload?.sessions.find((row) => row.key === key)).toMatchObject({
        fastMode: expected,
        effectiveFastMode: expected,
      });
      const described = await rpcReq<{ session: SpeedFields }>(ws, "sessions.describe", { key });
      expect(described.ok).toBe(true);
      expect(described.payload?.session).toMatchObject({
        fastMode: expected,
        effectiveFastMode: expected,
      });
      for (const method of ["models.list", "chat.metadata"] as const) {
        const catalog = await rpcReq<{ models: SpeedFields[] }>(
          ws,
          method,
          method === "models.list" ? { preparedOnly: true } : { sessionKey: key },
        );
        expect(catalog.ok, JSON.stringify(catalog.error)).toBe(true);
        expect(catalog.payload?.models.length).toBeGreaterThan(0);
        expect(catalog.payload?.models.every((model) => model.effectiveFastMode === expected)).toBe(
          true,
        );
      }
      for (const method of ["chat.history", "chat.startup"] as const) {
        const history = await rpcReq<
          SpeedFields & { sessionInfo: SpeedFields; metadata?: { models?: SpeedFields[] } }
        >(ws, method, {
          sessionKey: key,
        });
        expect(history.ok, JSON.stringify(history.error)).toBe(true);
        expect(history.payload?.fastMode).toBe(expected);
        expect(history.payload?.sessionInfo).toMatchObject({
          fastMode: expected,
          effectiveFastMode: expected,
        });
      }
      const unsaved = await rpcReq<{ sessionInfo: SpeedFields }>(ws, "chat.history", {
        sessionKey: "agent:main:unsaved-speed",
      });
      expect(unsaved.ok, JSON.stringify(unsaved.error)).toBe(true);
      expect(unsaved.payload?.sessionInfo.effectiveFastMode).toBe(expected);
      const patch = await rpcReq<{ entry: SpeedFields }>(ws, "sessions.patch", {
        key,
        label: "Speed compatibility",
      });
      expect(patch.ok, JSON.stringify(patch.error)).toBe(true);
      expect(patch.payload?.entry.fastMode).toBe(expected);
      expect((await rpcReq(ws, "sessions.subscribe", {})).ok).toBe(true);
    }
    const changed = [legacy.ws, current.ws].map((ws) =>
      onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "sessions.changed" &&
          message.payload?.reason === "patch",
      ),
    );
    expect(
      (await rpcReq(current.ws, "sessions.patch", { key, label: "Renamed speed session" })).ok,
    ).toBe(true);
    for (const [index, message] of (await Promise.all(changed)).entries()) {
      const expected = index === 0 ? true : "ultrafast";
      expect(message.payload).toMatchObject({
        fastMode: expected,
        effectiveFastMode: expected,
        session: { fastMode: expected, effectiveFastMode: expected },
      });
    }
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.fastMode).toBe(
      "ultrafast",
    );
    const createdKey = "agent:main:dashboard:speed-created";
    for (const [ws, expected] of [
      [current.ws, "ultrafast"],
      [legacy.ws, true],
      [current.ws, "ultrafast"],
    ] as const) {
      const created = await rpcReq<{ entry: SpeedFields }>(ws, "sessions.create", {
        agentId: "main",
        key: createdKey,
        fastMode: "ultrafast",
        idempotencyKey: "speed-create-once",
      });
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(created.payload?.entry.fastMode).toBe(expected);
    }
    expect(loadSessionEntry({ agentId: "main", sessionKey: createdKey, storePath })?.fastMode).toBe(
      "ultrafast",
    );
    const reset = await rpcReq<{ entry: SpeedFields }>(legacy.ws, "sessions.reset", { key });
    expect(reset.ok, JSON.stringify(reset.error)).toBe(true);
    expect(reset.payload?.entry.fastMode).toBe(true);
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.fastMode).toBe(
      "ultrafast",
    );
  } finally {
    legacy.ws.close();
    current.ws.close();
  }
});
