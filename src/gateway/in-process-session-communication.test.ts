import { expect, it, vi } from "vitest";

it("source-loaded tools and separately loaded host runtime redeem the same exact one-input binding", async () => {
  const source = await import("./in-process-session-communication.js");
  const input = {
    agentId: "main",
    sessionKey: "agent:main:target",
    message: "approved",
    inputProvenance: { sourceSessionKey: "agent:main:source" },
  };
  const owned = { assertCurrent: vi.fn(), release: vi.fn() };
  const retain = vi.fn(() => owned);
  source.bindSessionCommunicationInput(input, { retain });
  // This leaf's deliberate duplicate load models source tools versus the host's bundled copy.
  vi.resetModules();
  const host = await import("./in-process-session-communication.js");
  expect(host.claimSessionCommunicationInput({ ...input })).toBeUndefined();
  expect(host.claimSessionCommunicationInput(input)).toBe(owned);
  expect(source.claimSessionCommunicationInput(input)).toBeUndefined();
  expect(retain).toHaveBeenCalledOnce();

  const mutated = { ...input, inputProvenance: { sourceSessionKey: "agent:main:source" } };
  source.bindSessionCommunicationInput(mutated, { retain });
  mutated.inputProvenance.sourceSessionKey = "agent:other:source";
  expect(() => host.claimSessionCommunicationInput(mutated)).toThrow("input changed");
  expect(retain).toHaveBeenCalledOnce();
});
