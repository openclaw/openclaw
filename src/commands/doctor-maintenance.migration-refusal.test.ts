import { expect, it } from "vitest";
import { DoctorStateMigrationRefusalError } from "../infra/state-migrations.messages.js";
import { begin, boundary } from "./doctor-maintenance.settlement.test-support.js";

it.each(["migration", "admission"])("restores the Gateway after a %s refusal", async (phase) => {
  let stateHeld = true;
  boundary.config.mockImplementation(async () => {
    if (stateHeld) {
      throw new Error("OpenClaw state is undergoing offline maintenance; retry when it finishes.");
    }
    return { config: {} };
  });
  boundary.release.mockImplementation(async () => {
    stateHeld = false;
  });
  const failure = new DoctorStateMigrationRefusalError([]);
  if (phase === "admission") {
    boundary.lease.mockImplementation(() => {
      throw failure;
    });
    await expect(begin()).rejects.toThrow("Doctor could not enter maintenance");
    expect(boundary.restart).toHaveBeenCalledOnce();
    expect(boundary.health).toHaveBeenCalledOnce();
    return;
  }
  const maintenance = await begin();
  try {
    await maintenance!.finish(undefined, undefined, failure);
    expect(boundary.restart).toHaveBeenCalledOnce();
    expect(boundary.health).toHaveBeenCalledOnce();
    expect(boundary.close).toHaveBeenCalledOnce();
    expect(boundary.resume).toHaveBeenCalledOnce();
  } finally {
    await maintenance?.release();
  }
});

it("explains launcher overrides before refusing foreign-service maintenance", async () => {
  boundary.stop.mockResolvedValue({
    stopped: false,
    inspected: true,
    runtimeInspected: true,
    running: true,
    serviceUpdateVerdict: { kind: "foreign" },
  });
  const refusal = await begin().catch((error: unknown) => error);
  expect(String(refusal)).toContain("operator-owned launcher override");
  expect(String(refusal)).toContain("systemctl cat");
  expect(String(refusal)).not.toContain("then run openclaw doctor --fix from that installation");
  expect(boundary.repair).not.toHaveBeenCalled();
  expect(boundary.restart).not.toHaveBeenCalled();
});
