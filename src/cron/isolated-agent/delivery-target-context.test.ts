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
it("batches fallback delivery reads without hiding individual target results", () =>
  withOpenClawTestState({ layout: "home" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const cfg = { session: { store: storePath } };
    const save = (sessionKey: string, to: string) =>
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
    save("agent:main:main", "main-recipient");
    save("agent:main:source", "source-recipient");
    const requests = Array.from({ length: 146 }, (_, index) => ({
      agentId: "main",
      sessionKey: index === 0 ? "agent:main:source" : `agent:main:preview-${index}`,
    }));
    requests[145] = requests[2]!;
    replaceSessionEntrySync(
      { agentId: "main", storePath, sessionKey: requests[1]!.sessionKey },
      { sessionId: "route-less", updatedAt: 1 },
    );
    const routeLess = {
      ok: true,
      value: {
        usedSharedMainFallback: false,
        main: { sessionId: "route-less", updatedAt: 1, delivery: { kind: "none" } },
      },
    };
    await readCronDeliveryTargetContexts(cfg, requests.slice(0, 3));
    const readEntries = sessionReads.readSessionEntriesFromStoreInWorker;
    using reads = vi.spyOn(sessionReads, "readSessionEntriesFromStoreInWorker");
    using parse = vi.spyOn(JSON, "parse");
    const result = await readCronDeliveryTargetContexts(cfg, requests);
    expect(result).toMatchObject(
      requests.map(({ sessionKey }, index) =>
        index === 1
          ? routeLess
          : preview(index === 0 ? "source-recipient" : "main-recipient", index !== 0, sessionKey),
      ),
    );
    expect(
      reads.mock.calls.filter(([input]) => input.sessionKeys?.includes("agent:main:main")),
    ).toHaveLength(1);
    expect(
      parse.mock.calls.filter(([json]) => json.includes("unrelated-session-payload")),
    ).toHaveLength(0);
    const [first, second] = [result[2]!, result[145]!];
    assert(first.ok && second.ok, "delivery previews failed");
    const firstDelivery = first.value.main?.delivery;
    const secondDelivery = second.value.main?.delivery;
    assert(firstDelivery?.kind === "external" && secondDelivery?.kind === "external");
    firstDelivery.context!.to = "caller-edit";
    expect(secondDelivery.context!.to).toBe("main-recipient");
    // A route can change without advancing either timestamp or lifecycle revision.
    save("agent:main:source", "new-source-recipient");
    save("agent:main:main", "new-main-recipient");
    expect(await readCronDeliveryTargetContexts(cfg, requests.slice(0, 3))).toMatchObject([
      preview("new-source-recipient", false),
      routeLess,
      preview("new-main-recipient"),
    ]);
    const unreadable = new Error("Synthetic unreadable delivery target");
    reads.mockImplementation((input, prepareSource) =>
      input.sessionKeys?.includes(requests[2]!.sessionKey)
        ? Promise.reject(unreadable)
        : readEntries(input, prepareSource),
    );
    expect(await readCronDeliveryTargetContexts(cfg, requests.slice(1, 4))).toMatchObject([
      routeLess,
      { ok: false, error: unreadable },
      preview("new-main-recipient", true, requests[3]!.sessionKey),
    ]);
  }));
