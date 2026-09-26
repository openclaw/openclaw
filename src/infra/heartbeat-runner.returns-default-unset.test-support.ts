// Shared WhatsApp heartbeat fixtures for the returns-default-unset suite.
//
// This module exists to keep `heartbeat-runner.returns-default-unset.test.ts`
// under the line-cap ratchet: that file is already on the max-lines allowlist,
// and `scripts/check-line-cap-ratchet.mts` rejects any further growth. The
// expectation and seeding helpers here are the coherent sibling to extract,
// because they carry no suite lifecycle state — `fixtureRoot` and its
// beforeAll/afterAll owners stay with the suite that mutates them.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { seedSessionStore } from "./heartbeat-runner.test-utils.js";

export const requireRecord = createRequireRecord("record", "expected-label-record");

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

export function expectWhatsAppSendCall(
  sendWhatsApp: ReturnType<typeof vi.fn>,
  index: number,
  fields: { to: string; text: string },
) {
  const call = sendWhatsApp.mock.calls[index];
  if (!call) {
    throw new Error(`expected WhatsApp send call ${index}`);
  }
  expect(call[0]).toBe(fields.to);
  expect(call[1]).toBe(fields.text);
  requireRecord(call[2], `WhatsApp send call ${index} options`);
}

export function expectReplyCall(
  replySpy: ReturnType<typeof vi.fn>,
  index: number,
  bodyFields: Record<string, unknown>,
  optionsFields?: Record<string, unknown>,
  cfg?: OpenClawConfig,
) {
  const call = replySpy.mock.calls[index];
  if (!call) {
    throw new Error(`expected reply call ${index}`);
  }
  const body = requireRecord(call[0], `reply call ${index} body`);
  for (const [key, value] of Object.entries(bodyFields)) {
    if (value instanceof RegExp) {
      expect(String(body[key])).toMatch(value);
    } else {
      expect(body[key]).toEqual(value);
    }
  }
  if (optionsFields) {
    expectRecordFields(requireRecord(call[1], `reply call ${index} options`), optionsFields);
  }
  if (cfg) {
    expect(call[2]).toBe(cfg);
  }
}

export function replyBody(
  replySpy: ReturnType<typeof vi.fn>,
  index = 0,
): Pick<MsgContext, "Body" | "InternalTurnSource"> {
  const call = replySpy.mock.calls[index];
  return requireRecord(call?.[0], `reply call ${index} body`) as Pick<
    MsgContext,
    "Body" | "InternalTurnSource"
  >;
}

type HeartbeatSeedOverride = Partial<Parameters<typeof seedSessionStore>[2]>;

export async function seedWhatsAppSession(
  storePath: string,
  sessionKey: string,
  entry: HeartbeatSeedOverride = {},
): Promise<void> {
  await seedSessionStore(storePath, sessionKey, {
    sessionId: "sid",
    updatedAt: Date.now(),
    lastChannel: "whatsapp",
    lastProvider: "whatsapp",
    lastTo: "120363401234567890@g.us",
    ...entry,
  });
}
