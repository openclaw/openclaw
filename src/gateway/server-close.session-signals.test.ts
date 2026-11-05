import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { createGatewayCloseRace } from "./server-close.race.test-support.js";

it("joins an accepted creation signal across the close prelude before closing its worker", async ({
  signal,
}) => {
  const race = await createGatewayCloseRace("gateway-session-signal-close", signal);
  try {
    const env = race.fixture.state.env;
    const shared = openOpenClawStateDatabase({ env }).db;
    const recording = probe.command(stateWorker, async (command, options, scope) => {
      if (command.type === "sessionState.record") {
        await race.block();
      }
      return scope.execute(command, options);
    });
    race.onCleanup(() => recording.mockRestore());
    const sessionKey = "agent:main:dashboard:accepted-close-signal";
    const creating = race.dispatch("sessions.create", { key: sessionKey });
    await race.waitForEntry(creating, "Session creation settled before recording its signal");
    await race.close();
    await expect(
      race.dispatch("sessions.create", { key: "agent:main:dashboard:refused-close-signal" }),
    ).rejects.toThrow("Gateway request entry is closed");
    expect(race.closed).toBe(false);
    expect(shared.isOpen).toBe(true);
    await race.finish(creating);
    expect(shared.isOpen).toBe(false);
    const database = new DatabaseSync(resolveOpenClawStateSqlitePath(env), { readOnly: true });
    try {
      expect(
        database
          .prepare("SELECT session_key, kind FROM session_state_events WHERE kind = 'created'")
          .all(),
      ).toEqual([{ session_key: sessionKey, kind: "created" }]);
    } finally {
      database.close();
    }
  } finally {
    await race.dispose();
  }
});
