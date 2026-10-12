import "./doctor-maintenance.settlement.test-support.js";
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
