import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { extractDeliveryInfo, extractDeliveryInfoBatch } from "./delivery-info.js";
import { replaceSessionEntry } from "./session-accessor.js";

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
