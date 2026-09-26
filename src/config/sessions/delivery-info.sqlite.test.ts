import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { extractDeliveryInfo, extractDeliveryInfoBatch } from "./delivery-info.js";
import {
  loadExactSessionEntryCandidatesReadOnlyBatch,
  replaceSessionEntry,
} from "./session-accessor.js";

const sessionKey = "agent:main:delivery-fallback";
const deliveryContext = { channel: "telegram", to: "telegram:123456", accountId: "default" };
const expected = { deliveryContext, threadId: undefined };

async function seedFallback(state: OpenClawTestState) {
  await replaceSessionEntry(
    { agentId: "main", env: state.env, sessionKey },
    {
      sessionId: "delivery-fallback",
      updatedAt: Date.now(),
      delivery: normalizeSessionDeliveryState({ context: deliveryContext }),
    },
  );
  expect(extractDeliveryInfo(sessionKey, { cfg: {} })).toEqual(expected);
  const primaryPath = state.statePath("custom", "sessions.sqlite");
  return {
    primaryPath,
    cfg: { session: { store: primaryPath } },
    readPrimary: () =>
      loadExactSessionEntryCandidatesReadOnlyBatch([
        { agentId: "main", env: state.env, storePath: primaryPath, sessionKeys: [sessionKey] },
      ]),
  };
}

it("recovers a same-agent route past an empty absent primary", async () => {
  await withOpenClawTestState({ label: "delivery-missing-primary" }, async (state) => {
    const { cfg, primaryPath, readPrimary } = await seedFallback(state);
    expect(readPrimary()).toMatchObject([{ ok: true, value: [] }]);

    const scalar = extractDeliveryInfo(sessionKey, { cfg });
    const batch = extractDeliveryInfoBatch([{ sessionKey }], { cfg });

    expect(fs.existsSync(primaryPath)).toBe(false);
    expect({ scalar, batch }).toEqual({ scalar: expected, batch: [expected] });
    expect(readPrimary()).toMatchObject([{ ok: true, value: [] }]);
  });
});

it.each(["uninitialized", "corrupt"] as const)(
  "does not recover another store's route past a present %s primary",
  async (kind) => {
    await withOpenClawTestState({ label: `delivery-${kind}-primary` }, async (state) => {
      const { cfg, primaryPath, readPrimary } = await seedFallback(state);
      fs.mkdirSync(state.statePath("custom"), { recursive: true });
      if (kind === "uninitialized") {
        new DatabaseSync(primaryPath).close();
      } else {
        fs.writeFileSync(primaryPath, "not a SQLite database");
      }
      const before = fs.readFileSync(primaryPath);
      expect(readPrimary()).toMatchObject([
        {
          ok: false,
          error:
            kind === "uninitialized"
              ? { name: "SessionMetadataUnavailableError", reason: "schema-missing" }
              : { code: "ERR_SQLITE_ERROR" },
        },
      ]);

      expect(extractDeliveryInfo(sessionKey, { cfg })).toEqual({
        deliveryContext: undefined,
        threadId: undefined,
      });
      expect(extractDeliveryInfoBatch([{ sessionKey }], { cfg })).toEqual([
        { deliveryContext: undefined, threadId: undefined },
      ]);
      expect(fs.readFileSync(primaryPath)).toEqual(before);
    });
  },
);

it("keeps explicit delivery ownership through alias lookup and rejects conflicting keys", async () => {
  await withOpenClawTestState({ label: "delivery-explicit-owner" }, async (state) => {
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, ops: {} },
      },
      session: { scope: "global" },
    } satisfies OpenClawConfig;
    const routes = {
      main: { channel: "telegram", to: "telegram:main", accountId: "main" },
      ops: { channel: "telegram", to: "telegram:ops", accountId: "ops" },
    };
    for (const [agentId, context] of Object.entries(routes)) {
      await replaceSessionEntry(
        { agentId, env: state.env, sessionKey: "global" },
        {
          sessionId: `${agentId}-global`,
          updatedAt: 1,
          delivery: normalizeSessionDeliveryState({ context }),
        },
      );
    }
    const missing = { deliveryContext: undefined, threadId: undefined };
    const selected = { deliveryContext: routes.ops, threadId: undefined };
    expect(extractDeliveryInfo("global", { cfg })).toEqual({
      deliveryContext: routes.main,
      threadId: undefined,
    });
    expect(extractDeliveryInfo("global", { cfg, agentId: "ops" })).toEqual(selected);
    expect(extractDeliveryInfo("agent:ops:main", { cfg, agentId: "ops" })).toEqual(selected);
    expect(
      extractDeliveryInfoBatch(
        ["global", "agent:main:main", "agent::broken"].map((key) => ({
          sessionKey: key,
          agentId: "ops",
        })),
        { cfg },
      ),
    ).toEqual([selected, missing, missing]);
    const fixedStoreConfig = {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: { ...cfg.agents.defaults, sessionStore: { agentId: "main" } },
      },
      session: {
        ...cfg.session,
        store: state.statePath("agents", "main", "sessions", "sessions.json"),
      },
    } satisfies OpenClawConfig;
    expect(extractDeliveryInfo("global", { cfg: fixedStoreConfig, agentId: "ops" })).toEqual(
      missing,
    );
  });
});
