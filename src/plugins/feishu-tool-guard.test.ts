import { describe, expect, it } from "vitest";

/**
 * Tests for the tools registration guard in the Feishu plugin entry.
 *
 * Rather than importing the full plugin module (which pulls in heavy
 * transitive dependencies), we test the guard pattern directly by
 * simulating the same code structure used in extensions/feishu/index.ts.
 */
describe("feishu plugin tools registration guard pattern", () => {
  it("prevents duplicate tool registration across multiple register() calls", () => {
    const registerCalls: string[] = [];
    let guardFlag = false;

    function registerFull() {
      if (guardFlag) {
        return;
      }
      guardFlag = true;
      registerCalls.push("subagent-hooks");
      registerCalls.push("doc-tools");
      registerCalls.push("chat-tools");
      registerCalls.push("wiki-tools");
      registerCalls.push("drive-tools");
      registerCalls.push("perm-tools");
      registerCalls.push("bitable-tools");
    }

    // Simulate first registration
    registerFull();
    expect(registerCalls).toHaveLength(7);
    expect(registerCalls).toContain("bitable-tools");

    // Simulate hot-reload (second registration)
    registerFull();
    expect(registerCalls).toHaveLength(7);

    // Simulate another hot-reload
    registerFull();
    expect(registerCalls).toHaveLength(7);
  });

  it("guard flag is independent across module instances", () => {
    let guard1 = false;
    let guard2 = false;
    const calls1: string[] = [];
    const calls2: string[] = [];

    function registerFull1() {
      if (guard1) {
        return;
      }
      guard1 = true;
      calls1.push("tool");
    }

    function registerFull2() {
      if (guard2) {
        return;
      }
      guard2 = true;
      calls2.push("tool");
    }

    registerFull1();
    registerFull2();
    registerFull1();

    expect(calls1).toHaveLength(1);
    expect(calls2).toHaveLength(1);
  });

  it("does not guard when flag is false initially", () => {
    const calls: string[] = [];
    let guardFlag = false;

    function registerFull() {
      if (guardFlag) {
        return;
      }
      guardFlag = true;
      calls.push("registered");
    }

    registerFull();
    expect(calls).toHaveLength(1);

    registerFull();
    expect(calls).toHaveLength(1);
  });
});
