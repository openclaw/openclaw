import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitSessionsSendWake } from "./sessions-send-wake-admission.js";

const paths: string[] = [];
async function databasePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wake-admission-"));
  paths.push(dir);
  return path.join(dir, "admission.sqlite");
}
afterEach(async () => {
  await Promise.all(paths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const enabled = { enabled: true };
const request = (id: string) => ({
  idempotencyKey: id,
  sourceSessionKey: "agent:sender:main",
  targetSessionKey: `agent:target:${id}`,
  targetAgentId: "target",
});

describe("sessions_send wake admission", () => {
  it("is disabled by default", async () => {
    expect(admitSessionsSendWake({ request: request("disabled") })).toEqual({
      allowed: true,
      replayed: false,
    });
  });

  it("admits exactly six concurrent recipient requests and records the rejected recipient", async () => {
    const db = await databasePath();
    const results = await Promise.all(
      Array.from({ length: 7 }, (_, index) =>
        Promise.resolve(
          admitSessionsSendWake({
            config: enabled,
            databasePath: db,
            nowMs: 1_000,
            request: request(`recipient-${index}`),
          }),
        ),
      ),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(6);
    expect(results.filter((result) => !result.allowed)).toEqual([
      { allowed: false, replayed: false, reason: "limit_exhausted" },
    ]);
  });

  it("does not spend a second permit for an idempotent retry across a restart", async () => {
    const db = await databasePath();
    expect(
      admitSessionsSendWake({
        config: enabled,
        databasePath: db,
        nowMs: 1_000,
        request: request("same"),
      }),
    ).toMatchObject({ allowed: true, replayed: false });
    expect(
      admitSessionsSendWake({
        config: enabled,
        databasePath: db,
        nowMs: 1_001,
        request: request("same"),
      }),
    ).toEqual({ allowed: true, replayed: true });
    for (let index = 0; index < 5; index += 1)
      expect(
        admitSessionsSendWake({
          config: enabled,
          databasePath: db,
          nowMs: 1_001,
          request: request(`other-${index}`),
        }).allowed,
      ).toBe(true);
    expect(
      admitSessionsSendWake({
        config: enabled,
        databasePath: db,
        nowMs: 1_001,
        request: request("seventh"),
      }),
    ).toMatchObject({ allowed: false, reason: "limit_exhausted" });
  });

  it("fails closed when the persisted state cannot be opened", () => {
    expect(
      admitSessionsSendWake({
        config: enabled,
        databasePath: "/dev/null/admission.sqlite",
        request: request("unavailable"),
      }),
    ).toEqual({ allowed: false, replayed: false, reason: "state_unavailable" });
  });
});
