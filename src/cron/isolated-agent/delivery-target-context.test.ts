import path from "node:path";
import { assert, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as sessionReads from "../../config/sessions/session-entry-read-runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { readCronDeliveryTargetContexts } from "./delivery-target-context.js";

const preview = (to: string, usedSharedMainFallback = true, rawSessionKey?: string) => ({
  ok: true,
  value: {
    usedSharedMainFallback,
    ...(rawSessionKey ? { rawSessionKey } : {}),
    main: { delivery: { context: { channel: "telegram", to, accountId: "work", threadId: 0 } } },
  },
});
function saveRoute(storePath: string, sessionKey: string, to: string) {
  replaceSessionEntrySync(
    { agentId: "main", storePath, sessionKey },
    {
      sessionId: sessionKey === "agent:main:source" ? "source" : "main",
      updatedAt: 1,
      lifecycleRevision: "unchanged-revision",
      label: "unrelated-session-payload".repeat(1500),
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to, accountId: "work", threadId: 0 },
      }),
    },
  );
}

it("reads 146 delivery previews without overflowing the session worker", async () => {
  await withOpenClawTestState({ layout: "home" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const cfg = { session: { store: storePath } };
    saveRoute(storePath, "agent:main:main", "main-recipient");
    const requests = Array.from({ length: 146 }, (_, index) => ({
      agentId: "main",
      sessionKey: `agent:main:preview-${index}`,
    }));
    await readCronDeliveryTargetContexts(cfg, requests.slice(0, 1));

    expect(await readCronDeliveryTargetContexts(cfg, requests)).toMatchObject(
      requests.map(({ sessionKey }) => preview("main-recipient", true, sessionKey)),
    );
  });
});

it("reads current delivery facts without decoding unrelated session payloads", async () => {
  await withOpenClawTestState({ layout: "home" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const cfg = { session: { store: storePath } };
    const sessionKey = "agent:main:source";
    const requests = [{ agentId: "main", sessionKey }, { agentId: "main" }, { agentId: "main" }];
    const save = (key: string, to: string) => saveRoute(storePath, key, to);
    save(sessionKey, "source-recipient");
    save("agent:main:main", "main-recipient");
    // Admission owns cold validation; measure the ordinary repeated read after it settles.
    await readCronDeliveryTargetContexts(cfg, requests);
    const parse = vi.spyOn(JSON, "parse");
    const reads = vi.spyOn(sessionReads, "readSessionEntriesFromStoreInWorker");
    try {
      const result = await readCronDeliveryTargetContexts(cfg, requests);
      expect(result).toMatchObject(
        ["source-recipient", "main-recipient", "main-recipient"].map((to, index) =>
          preview(to, index > 0),
        ),
      );
      expect(
        parse.mock.calls.filter(([json]) => json.includes("unrelated-session-payload")),
      ).toHaveLength(0);
      expect(
        reads.mock.calls.filter(([input]) => input.sessionKeys?.includes("agent:main:main")),
      ).toHaveLength(1);
      const first = result[1]!;
      const second = result[2]!;
      assert(first.ok && second.ok, "delivery previews failed");
      const firstDelivery = first.value.main?.delivery;
      const secondDelivery = second.value.main?.delivery;
      assert(firstDelivery?.kind === "external" && secondDelivery?.kind === "external");
      firstDelivery.context!.to = "caller-edit";
      expect(secondDelivery.context!.to).toBe("main-recipient");
    } finally {
      parse.mockRestore();
      reads.mockRestore();
    }
    // A route can change without advancing either timestamp or lifecycle revision.
    save(sessionKey, "new-source-recipient");
    save("agent:main:main", "new-main-recipient");
    expect(await readCronDeliveryTargetContexts(cfg, requests)).toMatchObject([
      preview("new-source-recipient", false),
      preview("new-main-recipient"),
      preview("new-main-recipient"),
    ]);
  });
});
