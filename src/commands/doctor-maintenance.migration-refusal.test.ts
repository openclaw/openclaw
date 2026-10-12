import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { DoctorStateMigrationRefusalError } from "../infra/state-migrations.messages.js";
import { begin, boundary, tempDirs } from "./doctor-maintenance.settlement.test-support.js";

it("leaves the running service untouched when retired state refuses admission", async () => {
  const stateDir = tempDirs.make("doctor-retired-admission-");
  fs.mkdirSync(path.join(stateDir, "acp"));
  fs.writeFileSync(path.join(stateDir, "acp", "event-ledger.json"), "{}");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  await expect(
    begin().then(async (maintenance) => {
      await maintenance?.release();
    }),
  ).rejects.toThrow("Upgrade through OpenClaw 2026.9.7");
  expect(boundary.stop).not.toHaveBeenCalled();
  expect(boundary.gatewayAcquire).not.toHaveBeenCalled();
});

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
