import { beforeEach, describe, expect, it } from "vitest";
import {
  applyConfigOverrides,
  getConfigOverrides,
  resetConfigOverrides,
  setConfigOverride,
  unsetConfigOverride,
} from "./runtime-overrides.js";
import type { OpenClawConfig } from "./types.js";

describe("runtime overrides", () => {
  beforeEach(() => {
    resetConfigOverrides();
  });

  it("sets and applies nested overrides", () => {
    const cfg = {
      messages: { responsePrefix: "[openclaw]" },
    } as OpenClawConfig;
    setConfigOverride("messages.responsePrefix", "[debug]");
    const next = applyConfigOverrides(cfg);
    expect(next.messages?.responsePrefix).toBe("[debug]");
  });

  it("merges object overrides without clobbering siblings", () => {
    const cfg = {
      channels: { whatsapp: { dmPolicy: "pairing", allowFrom: ["+1"] } },
    } as OpenClawConfig;
    setConfigOverride("channels.whatsapp.dmPolicy", "open");
    const next = applyConfigOverrides(cfg);
    expect(next.channels?.whatsapp?.dmPolicy).toBe("open");
    expect(next.channels?.whatsapp?.allowFrom).toEqual(["+1"]);
  });

  it("merges indexed array overrides without clobbering other array items", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "main",
            runtime: { type: "subagent" },
          },
          {
            id: "helper",
          },
        ],
      },
    } as OpenClawConfig;

    setConfigOverride("agents.list[0].id", "patched-main");

    const next = applyConfigOverrides(cfg);
    expect(Array.isArray(next.agents?.list)).toBe(true);
    expect(next.agents?.list?.[0]).toMatchObject({
      id: "patched-main",
      runtime: { type: "subagent" },
    });
    expect(next.agents?.list?.[1]).toMatchObject({ id: "helper" });
  });

  it("treats numeric-key object overrides as array patches", () => {
    const cfg = {
      agents: {
        list: [{ id: "main", runtime: { type: "subagent" } }, { id: "helper" }],
      },
    } as OpenClawConfig;

    setConfigOverride("agents.list", {
      0: { id: "patched-main" },
    });

    const next = applyConfigOverrides(cfg);
    expect(next.agents?.list?.[0]).toMatchObject({
      id: "patched-main",
      runtime: { type: "subagent" },
    });
    expect(next.agents?.list?.[1]).toMatchObject({ id: "helper" });
  });

  it("merges numeric object keys into array indexes", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "main",
            runtime: { type: "subagent" },
          },
          {
            id: "helper",
          },
        ],
      },
    } as OpenClawConfig;

    setConfigOverride("agents.list.0.id", "patched-main");

    const next = applyConfigOverrides(cfg);
    expect(Array.isArray(next.agents?.list)).toBe(true);
    expect(next.agents?.list?.[0]).toMatchObject({
      id: "patched-main",
      runtime: { type: "subagent" },
    });
    expect(next.agents?.list?.[1]).toMatchObject({ id: "helper" });
  });

  it("unsets overrides and prunes empty branches", () => {
    setConfigOverride("channels.whatsapp.dmPolicy", "open");
    const removed = unsetConfigOverride("channels.whatsapp.dmPolicy");
    expect(removed.ok).toBe(true);
    expect(removed.removed).toBe(true);
    expect(Object.keys(getConfigOverrides()).length).toBe(0);
  });

  it("does not retarget later array overrides when unsetting an earlier index", () => {
    const cfg = {
      agents: {
        list: [
          { id: "main", name: "Main" },
          { id: "helper", name: "Helper" },
        ],
      },
    } as OpenClawConfig;

    setConfigOverride("agents.list[0].id", "patched-main");
    setConfigOverride("agents.list[1].id", "patched-helper");

    const removed = unsetConfigOverride("agents.list[0].id");
    expect(removed.ok).toBe(true);
    expect(removed.removed).toBe(true);

    const next = applyConfigOverrides(cfg);
    expect(next.agents?.list).toEqual([
      { id: "main", name: "Main" },
      { id: "patched-helper", name: "Helper" },
    ]);
  });

  it("rejects prototype pollution paths", () => {
    const attempts = ["__proto__.polluted", "constructor.polluted", "prototype.polluted"];
    for (const path of attempts) {
      const result = setConfigOverride(path, true);
      expect(result.ok).toBe(false);
      expect(Object.keys(getConfigOverrides()).length).toBe(0);
    }
  });

  it("blocks __proto__ keys inside override object values", () => {
    const cfg = { commands: {} } as OpenClawConfig;
    setConfigOverride("commands", JSON.parse('{"__proto__":{"bash":true}}'));

    const next = applyConfigOverrides(cfg);
    expect(next.commands?.bash).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(next.commands ?? {}, "bash")).toBe(false);
  });

  it("blocks constructor/prototype keys inside override object values", () => {
    const cfg = { commands: {} } as OpenClawConfig;
    setConfigOverride("commands", JSON.parse('{"constructor":{"prototype":{"bash":true}}}'));

    const next = applyConfigOverrides(cfg);
    expect(next.commands?.bash).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(next.commands ?? {}, "bash")).toBe(false);
  });

  it("sanitizes blocked object keys when writing overrides", () => {
    setConfigOverride("commands", JSON.parse('{"__proto__":{"bash":true},"debug":true}'));

    expect(getConfigOverrides()).toEqual({
      commands: {
        debug: true,
      },
    });
  });
});
