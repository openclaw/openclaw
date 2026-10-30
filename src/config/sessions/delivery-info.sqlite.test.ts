import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { extractDeliveryInfo, extractDeliveryInfoBatch } from "./delivery-info.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { markCanonicalSessionValidationPending } from "./session-canonical-key.js";

const sessionKey = "agent:main:delivery-fallback";
const deliveryContext = { channel: "telegram", to: "telegram:123456", accountId: "default" };
type Route = typeof deliveryContext;
const delivery = (context?: Route) => ({ deliveryContext: context, threadId: undefined });
const expected = delivery(deliveryContext);
const missing = delivery();
const requestsFor = (keys: string[], agentId?: string) =>
  keys.map((key) => ({ sessionKey: key, ...(agentId ? { agentId } : {}) }));
const seed = (key: string, context: Route, agentId = "main") =>
  replaceSessionEntry(
    { agentId, sessionKey: key },
    {
      sessionId: `${agentId}-route`,
      updatedAt: 1,
      delivery: normalizeSessionDeliveryState({ context }),
    },
  );

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
    expect(await extractDeliveryInfoBatch(requestsFor(keys), { cfg })).toEqual([missing, missing]);
  });
});

it("preserves ordered exact and folded routes across owner updates", async () => {
  await withOpenClawTestState({ label: "delivery-batch-routes" }, async () => {
    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    const key = "agent:main:signal:group:AbC";
    const context = { channel: "signal", to: "signal:group:AbC", accountId: "first" };
    await seed(key, context);
    await seed(sessionKey, deliveryContext);
    const requests = requestsFor([
      sessionKey,
      "agent:main:signal:group:abc",
      "agent:main:missing",
      "signal:group:abc",
      key,
      sessionKey,
      "agent:main:matrix:channel:!Missing:example.org",
    ]);
    const expectedRoutes = (route: Route) => [
      expected,
      delivery(route),
      missing,
      delivery(route),
      delivery(route),
      expected,
      missing,
    ];
    const first = await extractDeliveryInfoBatch(requests, { cfg });
    expect(first).toEqual(expectedRoutes(context));
    const changed = { ...context, accountId: "second" };
    await seed(key, changed);
    expect(await extractDeliveryInfoBatch(requests, { cfg })).toEqual(expectedRoutes(changed));
    expect(first).toEqual(expectedRoutes(context));
    expect(await extractDeliveryInfo(key, { cfg })).toEqual(delivery(changed));
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
    const selected = delivery(routes.ops);
    expect(await extractDeliveryInfo("global", { cfg })).toEqual(delivery(routes.main));
    expect(await extractDeliveryInfo("global", { cfg, agentId: "ops" })).toEqual(selected);
    expect(await extractDeliveryInfo("agent:ops:main", { cfg, agentId: "ops" })).toEqual(selected);
    expect(
      await extractDeliveryInfoBatch(
        requestsFor(["global", "agent:main:main", "agent::broken"], "ops"),
        { cfg },
      ),
    ).toEqual([selected, missing, missing]);
    const fixed = structuredClone(cfg);
    fixed.agents!.defaults!.sessionStore = { agentId: "main" };
    fixed.session!.store = state.statePath("agents", "main", "sessions", "sessions.json");
    expect(await extractDeliveryInfo("global", { cfg: fixed, agentId: "ops" })).toEqual(missing);
  });
});
