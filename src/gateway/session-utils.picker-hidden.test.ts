import { afterAll, beforeEach, describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { listAgentsForGateway } from "./session-utils-store.js";
import { closeSessionSqliteDatabasesForTest } from "./session-utils.test-support.js";

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
});

afterAll(closeSessionSqliteDatabasesForTest);

describe("listAgentsForGateway picker visibility", () => {
  test("projects picker.hidden for hidden agents and omits it for visible agents", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: {}, worker: { picker: { hidden: true } } },
      },
    };
    const { agents } = await listAgentsForGateway(cfg);

    expect(agents.find((row) => row.id === "worker")?.hidden).toBe(true);
    expect(agents.find((row) => row.id === "main")?.hidden).toBeUndefined();
  });
});

describe("legacy roster compatibility", () => {
  test("configs without picker still project visible agents", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: {}, worker: {} },
      },
    };
    const { agents } = await listAgentsForGateway(cfg);

    expect(agents.map((row) => row.id)).toContain("worker");
    expect(agents.every((row) => row.hidden === undefined)).toBe(true);
  });

  test("legacy system-roster configs still project", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: {} },
      },
    };
    const { agents } = await listAgentsForGateway(cfg);

    expect(agents.length).toBeGreaterThan(0);
    expect(agents.every((row) => row.hidden === undefined)).toBe(true);
  });
});
