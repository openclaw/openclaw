import { expect, it, vi } from "vitest";
import * as historyReaders from "../config/sessions/session-transcript-worker-readers.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { createGatewayCloseRace } from "./server-close.race.test-support.js";

it("joins an accepted Board read across the close prelude before closing its worker", async ({
  signal,
}) => {
  const race = await createGatewayCloseRace("gateway-board-read-close", signal);
  try {
    const sessionKey = "agent:main:dashboard:accepted-board-close";
    await race.dispatch("sessions.create", { key: sessionKey });
    await race.dispatch("board.widget.put", {
      sessionKey,
      name: "status",
      content: { kind: "html", html: "accepted" },
    });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: race.fixture.state.env }).db;
    const create = historyReaders.createSessionHistoryWorkerReaders;
    let readSettled = false;
    const interception = vi
      .spyOn(historyReaders, "createSessionHistoryWorkerReaders")
      .mockImplementation((run) => {
        const readers = create(run);
        return {
          ...readers,
          async readBoardSnapshot(input) {
            await race.block();
            const value = await readers.readBoardSnapshot(input);
            readSettled = true;
            return value;
          },
        };
      });
    race.onCleanup(() => interception.mockRestore());
    const reading = race.dispatch("board.get", { sessionKey });
    await race.waitForEntry(reading, "Board read bypassed its worker");
    await race.close();
    await expect(race.dispatch("board.get", { sessionKey })).rejects.toThrow(
      "Gateway request entry is closed",
    );
    expect(race.closed).toBe(false);
    expect(readSettled).toBe(false);
    expect(database.isOpen).toBe(true);
    expect(await race.finish(reading)).toMatchObject({
      sessionKey,
      revision: 1,
      widgets: [{ name: "status", contentKind: "html", revision: 1 }],
    });
    expect(readSettled).toBe(true);
    expect(database.isOpen).toBe(false);
  } finally {
    await race.dispose();
  }
});
