// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { resolveChatThinkingSelectState } from "../chat/thinking.ts";
import { reconcileSessionHistory } from "./reconcile.ts";

const identity = {
  modelProvider: "catalog-fixture",
  model: "reasoner",
  agentRuntime: { id: "openclaw", source: "model" as const },
};
const row: GatewaySessionRow = {
  ...identity,
  key: "agent:main:main",
  kind: "direct",
  sessionId: "s1",
  updatedAt: 1,
};
function currentResult(
  metadata: Pick<GatewaySessionRow, "thinkingLevels" | "thinkingOptions" | "thinkingDefault">,
): SessionsListResult {
  return {
    ts: 1,
    path: "store",
    count: 1,
    defaults: { ...identity, ...metadata, contextTokens: null },
    sessions: [{ ...row, ...metadata }],
  };
}

describe("reconcileSessionHistory thinking profiles", () => {
  it("replaces longer old choices with an explicit empty profile", () => {
    const current = currentResult({
      thinkingLevels: [
        { id: "off", label: "Off" },
        { id: "high", label: "Deep effort" },
      ],
      thinkingOptions: ["Off", "Deep effort"],
      thinkingDefault: "high",
    });
    const empty = { thinkingLevels: [], thinkingOptions: [] };

    const next = reconcileSessionHistory(
      current,
      { ...row, ...empty, updatedAt: 2 },
      { ...identity, ...empty, contextTokens: null },
    );

    expect(next?.sessions[0]?.thinkingLevels).toEqual([]);
    expect(next?.sessions[0]?.thinkingOptions).toEqual([]);
    expect(next?.sessions[0]?.thinkingDefault).toBeUndefined();
    expect(next?.defaults.thinkingLevels).toEqual([]);
    expect(next?.defaults.thinkingOptions).toEqual([]);
    expect(next?.defaults.thinkingDefault).toBeUndefined();
    expect(
      resolveChatThinkingSelectState({ catalog: [], sessionKey: row.key, sessionsResult: next })
        .options,
    ).toEqual([]);
  });

  it("accepts a narrower published profile with its own labels and default", () => {
    const current = currentResult({
      thinkingLevels: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
      thinkingOptions: ["Low", "High"],
      thinkingDefault: "high",
    });
    const incoming = {
      thinkingLevels: [{ id: "low", label: "Careful" }],
      thinkingOptions: ["Careful"],
      thinkingDefault: "low",
    };

    const next = reconcileSessionHistory(current, { ...row, ...incoming, updatedAt: 2 }, undefined);

    expect(next?.sessions[0]).toMatchObject(incoming);
  });

  it("preserves a known empty profile when history omits capability metadata", () => {
    const current = currentResult({ thinkingLevels: [], thinkingOptions: [] });

    const next = reconcileSessionHistory(
      current,
      { ...row, updatedAt: 2 },
      { ...identity, contextTokens: null },
    );

    expect(next?.sessions[0]?.thinkingLevels).toEqual([]);
    expect(next?.sessions[0]?.thinkingOptions).toEqual([]);
    expect(next?.defaults.thinkingLevels).toEqual([]);
    expect(next?.defaults.thinkingDefault).toBeUndefined();
  });

  it("keeps supported metadata when history has no published profile", () => {
    const metadata = {
      thinkingLevels: [{ id: "low", label: "Careful" }],
      thinkingOptions: ["Careful"],
      thinkingDefault: "low",
    };
    const current = currentResult(metadata);

    const next = reconcileSessionHistory(
      current,
      { ...row, updatedAt: 2 },
      { ...identity, contextTokens: null },
    );

    expect(next?.sessions[0]).toMatchObject(metadata);
    expect(next?.defaults).toMatchObject(metadata);
  });

  it("does not inherit the previous model's profile", () => {
    const current = currentResult({
      thinkingLevels: [{ id: "high", label: "Deep effort" }],
      thinkingOptions: ["Deep effort"],
      thinkingDefault: "high",
    });

    const next = reconcileSessionHistory(
      current,
      { ...row, model: "replacement", updatedAt: 2 },
      undefined,
    );

    expect(next?.sessions[0]?.thinkingLevels).toBeUndefined();
    expect(next?.sessions[0]?.thinkingDefault).toBeUndefined();
  });
});
