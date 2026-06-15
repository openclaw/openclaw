/**
 * Proof script: avatar storage per agent ID (issue #90890).
 *
 * Runs the REAL loadLocalAssistantIdentity / saveLocalAssistantIdentity
 * functions from ui/src/ui/storage.ts against an in-memory localStorage.
 * Uses vitest to properly mock globalThis.localStorage so the real code paths
 * are exercised exactly as they run in the browser.
 *
 * Usage: npx vitest run scripts/proof-avatar-per-agent.proof.test.ts --reporter verbose
 */
// @vitest-environment node
import { afterEach, beforeEach, describe, it, vi, expect } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadLocalAssistantIdentity, saveLocalAssistantIdentity } from "../storage.ts";

describe("avatar storage per agent ID — real code proof (#90890)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Test 1: per-agent scoping — main and worker have independent avatars", () => {
    saveLocalAssistantIdentity({ avatar: "data:image/png;base64,bWFpbg==" }, "main");
    saveLocalAssistantIdentity({ avatar: "data:image/png;base64,d29ya2Vy" }, "worker");

    // Each agent should have its own avatar stored in a separate scoped key.
    expect(loadLocalAssistantIdentity("main").avatar).toBe("data:image/png;base64,bWFpbg==");
    expect(loadLocalAssistantIdentity("worker").avatar).toBe("data:image/png;base64,d29ya2Vy");

    // Verify the localStorage keys are different.
    const mainRaw = localStorage.getItem("openclaw.control.assistant.v1:main");
    const workerRaw = localStorage.getItem("openclaw.control.assistant.v1:worker");
    expect(mainRaw).toBeTruthy();
    expect(workerRaw).toBeTruthy();
    expect(mainRaw).not.toBe(workerRaw);
  });

  it("Test 2: clear isolation — clearing main does not affect worker", () => {
    saveLocalAssistantIdentity({ avatar: "data:image/png;base64,bWFpbg==" }, "main");
    saveLocalAssistantIdentity({ avatar: "data:image/png;base64,d29ya2Vy" }, "worker");

    // Clear main's avatar.
    saveLocalAssistantIdentity({ avatar: null }, "main");

    // main's avatar should be null; worker should be unaffected.
    expect(loadLocalAssistantIdentity("main").avatar).toBeNull();
    expect(loadLocalAssistantIdentity("worker").avatar).toBe("data:image/png;base64,d29ya2Vy");
  });

  it("Test 3: global fallback — new agent without scoped key falls back to global", () => {
    // Set a global avatar (no agent ID).
    saveLocalAssistantIdentity({ avatar: "data:image/png;base64,Z2xvYmFs" });

    // A brand-new agent with no scoped key should fall back to the global key.
    expect(loadLocalAssistantIdentity("brand-new-agent").avatar).toBe(
      "data:image/png;base64,Z2xvYmFs",
    );
  });

  it("Test 4: scoped clear blocks legacy global fallback (upgrade scenario)", () => {
    // Simulate legacy state: a global avatar exists from before the scoping fix.
    saveLocalAssistantIdentity({ avatar: "data:image/png;base64,bGVnYWN5" });

    // Agent "main" should see the legacy global avatar initially.
    expect(loadLocalAssistantIdentity("main").avatar).toBe("data:image/png;base64,bGVnYWN5");

    // Set a scoped avatar for "main".
    saveLocalAssistantIdentity({ avatar: "data:image/png;base64,c2NvcGVk" }, "main");
    expect(loadLocalAssistantIdentity("main").avatar).toBe("data:image/png;base64,c2NvcGVk");

    // Clear the scoped avatar for "main".
    saveLocalAssistantIdentity({ avatar: null }, "main");

    // main should NOT fall back to global (explicit null blocks it).
    expect(loadLocalAssistantIdentity("main").avatar).toBeNull();

    // Other agents still see the global fallback.
    expect(loadLocalAssistantIdentity("other-agent").avatar).toBe("data:image/png;base64,bGVnYWN5");
  });

  it("Test 5: explicit null stored in scoped key to prevent fallback", () => {
    saveLocalAssistantIdentity({ avatar: "data:image/png;base64,bWFpbg==" }, "main");
    saveLocalAssistantIdentity({ avatar: null }, "main");

    // The scoped key should contain an explicit null, not be removed.
    const raw = localStorage.getItem("openclaw.control.assistant.v1:main");
    expect(raw).toBe('{"avatar":null}');
  });

  it("Test 6: localStorage key naming — scoped keys use colon separator", () => {
    saveLocalAssistantIdentity({ avatar: "data:image/png;base64,bWFpbg==" }, "main");
    saveLocalAssistantIdentity({ avatar: "data:image/png;base64,d29ya2Vy" }, "worker");
    saveLocalAssistantIdentity({ avatar: "data:image/png;base64,Z2xvYmFs" }); // global

    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("openclaw.control.assistant.v1")) keys.push(k);
    }
    keys.sort();

    // Global key + per-agent scoped keys
    expect(keys).toEqual([
      "openclaw.control.assistant.v1",
      "openclaw.control.assistant.v1:main",
      "openclaw.control.assistant.v1:worker",
    ]);
  });
});
