import { describe, expect, it } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { QuestionManager } from "./question-manager.js";

const request = { id: "shared", questions: [], timeoutMs: 1000 };

describe("question registration namespace", () => {
  it("rejects existing IDs across agent and transient custody before registration", async () => {
    const manager = new QuestionManager(createTestGatewayScheduler());
    manager.request({ ...request, agentId: "first" });
    expect(() => manager.reserveRegistration("shared")).toThrow("already exists");
    expect(() => manager.request({ ...request, agentId: "second" })).toThrow("already exists");
    manager.close();
    await manager.drain();
  });

  it("holds the global ID through async registration and only its owner may install", async () => {
    const manager = new QuestionManager(createTestGatewayScheduler());
    const claim = manager.reserveRegistration("shared");
    await Promise.resolve();
    expect(() => manager.reserveRegistration("shared")).toThrow("already exists");
    expect(() => manager.request(request)).toThrow("already exists");
    const record = manager.request({ ...request, registrationReservation: claim });
    expect(record.id).toBe("shared");
    claim.release();
    expect(() => manager.reserveRegistration("shared")).toThrow("already exists");
    manager.close();
    await manager.drain();
  });

  it("releases failed registration and invalidates old tokens on reset without releasing successors", async () => {
    const manager = new QuestionManager(createTestGatewayScheduler());
    const failed = manager.reserveRegistration("shared");
    failed.release();
    const stale = manager.reserveRegistration("shared");
    manager.reset();
    const successor = manager.reserveRegistration("shared");
    stale.release();
    expect(() => stale.assertCurrent()).toThrow("retired");
    expect(() => manager.request({ ...request, registrationReservation: stale })).toThrow(
      "retired",
    );
    expect(() => manager.request(request)).toThrow("already exists");
    successor.release();
    manager.close();
    await manager.drain();
  });
});
