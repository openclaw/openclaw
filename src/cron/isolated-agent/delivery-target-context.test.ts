import path from "node:path";
import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { readCronDeliveryTargetContexts } from "./delivery-target-context.js";

it("reads current delivery facts without decoding unrelated session payloads", async () => {
  await withOpenClawTestState({ layout: "home" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const cfg = { session: { store: storePath } };
    const sessionKey = "agent:main:source";
    const requests = [{ agentId: "main", sessionKey }, { agentId: "main" }];
    const save = (key: string, to: string) =>
      replaceSessionEntrySync(
        { agentId: "main", storePath, sessionKey: key },
        {
          sessionId: key === sessionKey ? "source" : "main",
          updatedAt: 1,
          lifecycleRevision: "unchanged-revision",
          label: "unrelated-session-payload".repeat(1500),
          delivery: normalizeSessionDeliveryState({
            context: {
              channel: "telegram",
              to,
              accountId: "work",
              threadId: 0,
            },
          }),
        },
      );
    save(sessionKey, "source-recipient");
    save("agent:main:main", "main-recipient");
    // Admission owns cold validation; measure the ordinary repeated read after it settles.
    readCronDeliveryTargetContexts(cfg, requests);
    const parse = vi.spyOn(JSON, "parse");
    try {
      const result = readCronDeliveryTargetContexts(cfg, requests);
      expect(result).toMatchObject([
        {
          ok: true,
          value: {
            usedSharedMainFallback: false,
            main: {
              delivery: {
                context: {
                  channel: "telegram",
                  to: "source-recipient",
                  accountId: "work",
                  threadId: 0,
                },
              },
            },
          },
        },
        {
          ok: true,
          value: {
            usedSharedMainFallback: true,
            main: {
              delivery: {
                context: {
                  channel: "telegram",
                  to: "main-recipient",
                  accountId: "work",
                  threadId: 0,
                },
              },
            },
          },
        },
      ]);
      expect(
        parse.mock.calls.filter(([json]) => json.includes("unrelated-session-payload")),
      ).toHaveLength(0);
    } finally {
      parse.mockRestore();
    }
    // A route can change without advancing either timestamp or lifecycle revision.
    save(sessionKey, "new-source-recipient");
    save("agent:main:main", "new-main-recipient");
    expect(readCronDeliveryTargetContexts(cfg, requests)).toMatchObject([
      { ok: true, value: { main: { delivery: { context: { to: "new-source-recipient" } } } } },
      { ok: true, value: { main: { delivery: { context: { to: "new-main-recipient" } } } } },
    ]);
  });
});
