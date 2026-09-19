// Delivery-thread clearing for sessions.patch.
import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  deliveryContextFromSession,
  normalizeSessionDeliveryState,
  sessionDeliveryOrigin,
  sessionDeliveryRoute,
} from "../utils/delivery-context.shared.js";
import { projectSessionsPatchEntry } from "./sessions-patch.js";

const MAIN_SESSION_KEY = "agent:main:main";

async function projectMainPatch(params: {
  existing: SessionEntry;
  patch: { key: string; threadId?: null; label?: string };
}) {
  const result = await projectSessionsPatchEntry({
    cfg: {} as OpenClawConfig,
    storeKey: MAIN_SESSION_KEY,
    existingEntry: params.existing,
    isLabelInUse: () => false,
    patch: params.patch,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.entry;
}

function staleThreadEntry(sessionId: string): SessionEntry {
  return {
    sessionId,
    updatedAt: 1,
    delivery: normalizeSessionDeliveryState({
      context: {
        channel: "telegram",
        to: "dm:user",
        threadId: 12345,
      },
      origin: {
        provider: "telegram",
        to: "dm:user",
        threadId: 12345,
      },
    }),
  } as SessionEntry;
}

describe("gateway sessions patch delivery thread", () => {
  test("clears persisted delivery thread ids when threadId is null", async () => {
    const existing = staleThreadEntry("sess-stale-thread");
    expect(sessionDeliveryRoute(existing)?.thread?.id).toBe(12345);
    expect(deliveryContextFromSession(existing)?.threadId).toBe(12345);
    expect(sessionDeliveryOrigin(existing)?.threadId).toBe(12345);

    const entry = await projectMainPatch({
      existing,
      patch: { key: MAIN_SESSION_KEY, threadId: null },
    });

    expect(sessionDeliveryRoute(entry)?.thread).toBeUndefined();
    expect(deliveryContextFromSession(entry)?.threadId).toBeUndefined();
    expect(sessionDeliveryOrigin(entry)?.threadId).toBeUndefined();
    expect(deliveryContextFromSession(entry)?.channel).toBe("telegram");
    expect(deliveryContextFromSession(entry)?.to).toBe("dm:user");
  });

  test("leaves delivery thread ids unchanged when threadId is omitted", async () => {
    const existing = {
      sessionId: "sess-keep-thread",
      updatedAt: 1,
      delivery: normalizeSessionDeliveryState({
        context: {
          channel: "telegram",
          to: "dm:user",
          threadId: 12345,
        },
      }),
    } as SessionEntry;

    const entry = await projectMainPatch({
      existing,
      patch: { key: MAIN_SESSION_KEY, label: "Keep thread" },
    });

    expect(entry.label).toBe("Keep thread");
    expect(deliveryContextFromSession(entry)?.threadId).toBe(12345);
    expect(sessionDeliveryRoute(entry)?.thread?.id).toBe(12345);
  });
});
