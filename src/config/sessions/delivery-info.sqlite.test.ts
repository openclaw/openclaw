import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { extractDeliveryInfo, extractDeliveryInfoBatch } from "./delivery-info.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { markCanonicalSessionValidationPending } from "./session-canonical-key.js";
import { historyLane, projectionLane } from "./session-transcript-worker-resources.js";

const sessionKey = "agent:main:delivery-fallback";
const deliveryContext = { channel: "telegram", to: "telegram:123456", accountId: "default" };
const expected = { deliveryContext, threadId: undefined };
const missing = { deliveryContext: undefined, threadId: undefined };
type Route = typeof deliveryContext;
const seed = (key: string, context: Route, agentId = "main") =>
  replaceSessionEntry(
    { agentId, sessionKey: key },
    {
      sessionId: `${agentId}-route`,
      updatedAt: 1,
      delivery: normalizeSessionDeliveryState({ context }),
    },
  );

it("reads distinct delivery targets once per batch and observes owner route writes", async () => {
  await withOpenClawTestState({ label: "delivery-batch-owner" }, async () => {
    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    const routes = Array.from({ length: 20 }, (_, index) => ({
      sessionKey: `agent:main:delivery-${index}`,
      context: { ...deliveryContext, to: `telegram:route-${index}` },
    }));
    for (const route of routes) {
      await seed(route.sessionKey, route.context);
    }
    const ordered = [routes[19]!, ...routes.slice(0, 19), routes[19]!];
    const requests = [
      ...ordered.map((route) => ({ sessionKey: route.sessionKey })),
      { sessionKey: "agent:main:missing" },
      { sessionKey: "agent:main:matrix:channel:!Missing:example.org" },
    ];
    const expectedRoutes = [
      ...ordered.map(({ context }) => ({ deliveryContext: context, threadId: undefined })),
      missing,
      missing,
    ];
    const selected: Array<readonly string[] | undefined> = [];
    let inventories = 0;
    const run = projectionLane.pool.run.bind(projectionLane.pool);
    using _ = vi.spyOn(projectionLane.pool, "run").mockImplementation((input, options) =>
      run(async () => {
        const request = typeof input === "function" ? await input() : input;
        if (request.kind === "session-exact-entries" && request.projection === "list") {
          selected.push(request.sessionKeys);
        }
        return request;
      }, options),
    );
    const historyRun = historyLane.pool.run.bind(historyLane.pool);
    using inventoryObserver = vi.spyOn(historyLane.pool, "run");
    inventoryObserver.mockImplementation((input, options) =>
      historyRun(async () => {
        const request = typeof input === "function" ? await input() : input;
        if (request.kind === "session-entry-list") {
          inventories++;
        }
        return request;
      }, options),
    );
    const first = await extractDeliveryInfoBatch(requests, { cfg });
    expect(first).toEqual(expectedRoutes);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveLength(23);

    const changed = { ...deliveryContext, to: "telegram:updated-route" };
    await seed(routes[0]!.sessionKey, changed);
    const second = await extractDeliveryInfoBatch(requests, { cfg });
    expect(second).toEqual(
      expectedRoutes.map((route, index) =>
        index === 1 ? { ...route, deliveryContext: changed } : route,
      ),
    );
    expect(first).toEqual(expectedRoutes);
    expect(selected).toHaveLength(2);

    expect(await extractDeliveryInfo(routes[0]!.sessionKey, { cfg })).toEqual({
      deliveryContext: changed,
      threadId: undefined,
    });
    expect(selected).toHaveLength(3);
    expect(selected[2]).toHaveLength(1);
    expect(inventories).toBe(0);
  });
});

it("preserves pending sibling validation when a combined delivery read fails", async () => {
  await withOpenClawTestState({ label: "delivery-batch-sibling" }, async ({ env }) => {
    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    const keys = [sessionKey, "agent:main:delivery-other"];
    const sibling = "agent:main:matrix:channel:!mixed:example.org";
    for (const key of [...keys, sibling]) {
      await seed(key, deliveryContext);
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    markCanonicalSessionValidationPending(database, [sibling]);
    database.db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
      JSON.stringify({
        sessionId: "invalid-sibling",
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "matrix", to: "!Mixed:example.org" },
        }),
      }),
      sibling,
    );
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(sibling);
    expect(
      await extractDeliveryInfoBatch(
        keys.map((key) => ({ sessionKey: key })),
        { cfg },
      ),
    ).toEqual([missing, missing]);
  });
});

it("recovers folded Signal groups from canonical rows and observes route updates", async () => {
  await withOpenClawTestState({ label: "delivery-signal-alias" }, async () => {
    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    const key = "agent:main:signal:group:AbC";
    const context = { channel: "signal", to: "signal:group:AbC", accountId: "first" };
    await seed(key, context);
    const requests = ["agent:main:signal:group:abc", "signal:group:abc", key].map((lookupKey) => ({
      sessionKey: lookupKey,
    }));
    expect(await extractDeliveryInfoBatch(requests, { cfg })).toEqual(
      requests.map(() => ({ deliveryContext: context, threadId: undefined })),
    );
    const changed = { ...context, accountId: "second" };
    await seed(key, changed);
    expect(await extractDeliveryInfoBatch(requests, { cfg })).toEqual(
      requests.map(() => ({ deliveryContext: changed, threadId: undefined })),
    );
  });
});

it.each(["absent", "uninitialized", "corrupt"] as const)(
  "recovers delivery only when the primary is absent (%s)",
  async (kind) => {
    await withOpenClawTestState({ label: `delivery-${kind}-primary` }, async (state) => {
      setRuntimeConfigSnapshot({});
      await seed(sessionKey, deliveryContext);
      const primaryPath = state.statePath("custom", "sessions.sqlite");
      const cfg = { session: { store: primaryPath } };
      if (kind !== "absent") {
        fs.mkdirSync(state.statePath("custom"), { recursive: true });
        if (kind === "uninitialized") {
          new DatabaseSync(primaryPath).close();
        } else {
          fs.writeFileSync(primaryPath, "not a SQLite database");
        }
      }
      const before = kind === "absent" ? undefined : fs.readFileSync(primaryPath);
      const result = kind === "absent" ? expected : missing;
      expect(await extractDeliveryInfoBatch([{ sessionKey }], { cfg })).toEqual([result]);
      if (before) {
        expect(fs.readFileSync(primaryPath)).toEqual(before);
      } else {
        expect(fs.existsSync(primaryPath)).toBe(false);
      }
    });
  },
);

it("keeps explicit delivery ownership through alias lookup and rejects conflicting keys", async () => {
  await withOpenClawTestState({ label: "delivery-explicit-owner" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, ops: {} },
      },
      session: { scope: "global" },
    };
    setRuntimeConfigSnapshot(cfg);
    const routes = {
      main: { channel: "telegram", to: "telegram:main", accountId: "main" },
      ops: { channel: "telegram", to: "telegram:ops", accountId: "ops" },
    };
    for (const [agentId, context] of Object.entries(routes)) {
      await seed("global", context, agentId);
    }
    const selected = { deliveryContext: routes.ops, threadId: undefined };
    expect(await extractDeliveryInfo("global", { cfg })).toEqual({
      deliveryContext: routes.main,
      threadId: undefined,
    });
    expect(await extractDeliveryInfo("global", { cfg, agentId: "ops" })).toEqual(selected);
    expect(await extractDeliveryInfo("agent:ops:main", { cfg, agentId: "ops" })).toEqual(selected);
    expect(
      await extractDeliveryInfoBatch(
        ["global", "agent:main:main", "agent::broken"].map((key) => ({
          sessionKey: key,
          agentId: "ops",
        })),
        { cfg },
      ),
    ).toEqual([selected, missing, missing]);
    const fixed = structuredClone(cfg);
    fixed.agents!.defaults!.sessionStore = { agentId: "main" };
    fixed.session!.store = state.statePath("agents", "main", "sessions", "sessions.json");
    expect(await extractDeliveryInfo("global", { cfg: fixed, agentId: "ops" })).toEqual(missing);
  });
});
