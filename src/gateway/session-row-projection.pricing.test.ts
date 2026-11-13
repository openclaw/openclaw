import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { model } from "../agents/model-catalog-fixtures.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  seedProjectionRow,
  withSessionRowProjectionState,
} from "./session-row-projection.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";

it("prepares prices before row projection and refreshes them at config publication", () =>
  withSessionRowProjectionState(async (create) => {
    const config = (input: number): OpenClawConfig => ({
      agents: { entries: { main: {} }, defaults: { model: "fixture/priced" } },
      models: {
        providers: {
          fixture: {
            baseUrl: "https://fixture.invalid",
            models: [
              model("priced", "Priced", {
                cost: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
              }),
            ],
          },
        },
      },
    });
    let cfg = config(2);
    const { query } = seedProjectionRow("pricing", {
      modelProvider: "fixture",
      model: "priced",
      inputTokens: 1_000,
    });
    using stats = vi.spyOn(fs, "lstatSync");
    const projection = await create({ cfg, getConfig: () => cfg, modelCatalog: [] });
    await projection.ensureMaterialized();
    const cost = async () =>
      (await listProjectedSessions({ projection, opts: { limit: 1 } })).sessions[0]
        ?.estimatedCostUsd;
    expect(await cost(), "initial prepared wire cost").toBe(0.002);
    sessionChanges.emit({ all: true, scope: "catalog" });
    expect(await cost(), "immediate catalog publication wire cost").toBe(0.002);
    for (let index = 0; index < 3; index++) {
      sessionChanges.emit({
        sessionKey: query.key,
        agentId: query.agentId,
        factsInvalidated: true,
      });
      await projection.ensureMaterialized();
      expect(await cost()).toBe(0.002);
    }
    expect(stats.mock.calls.filter(([file]) => String(file).endsWith("models.json"))).toEqual([]);
    cfg = config(7);
    sessionChanges.emit({ all: true, scope: "config" });
    await projection.ensureMaterialized();
    expect(await cost()).toBe(0.007);
  }));
