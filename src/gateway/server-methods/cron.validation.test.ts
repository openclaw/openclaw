import { describe, expect, it, vi } from "vitest";
import { cronHandlers } from "./cron.js";

function createCronContext() {
  return {
    cron: {
      add: vi.fn(async () => ({ id: "cron-1" })),
      update: vi.fn(async () => ({ id: "cron-1" })),
    },
    logGateway: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
}

describe("cron high-frequency warnings", () => {
  it("warns when cron.add configures a high-frequency every schedule", async () => {
    const context = createCronContext();
    const respond = vi.fn();

    await cronHandlers["cron.add"]({
      req: {} as never,
      params: {
        name: "Frequent add",
        enabled: true,
        schedule: { kind: "every", everyMs: 900_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
      } as never,
      respond: respond as never,
      context: context as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(context.logGateway.warn).toHaveBeenCalledWith(
      expect.stringContaining("high-frequency cron schedules (<30m)"),
      expect.objectContaining({
        rpcMethod: "cron.add",
        schedule: { kind: "every", everyMs: 900_000 },
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, { id: "cron-1" }, undefined);
  });

  it("warns when cron.update patches a high-frequency every schedule", async () => {
    const context = createCronContext();
    const respond = vi.fn();

    await cronHandlers["cron.update"]({
      req: {} as never,
      params: {
        id: "cron-1",
        patch: {
          schedule: { kind: "every", everyMs: 900_000 },
        },
      } as never,
      respond: respond as never,
      context: context as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(context.logGateway.warn).toHaveBeenCalledWith(
      expect.stringContaining("high-frequency cron schedules (<30m)"),
      expect.objectContaining({
        jobId: "cron-1",
        rpcMethod: "cron.update",
        schedule: { kind: "every", everyMs: 900_000 },
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, { id: "cron-1" }, undefined);
  });
});
