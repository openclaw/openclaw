import { Socket } from "node:net";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { holdPipe, releasePipe } from "./pipe.js";

describe("spawn broker pipe release", () => {
  it.each([
    { held: "pause", after: "resume" },
    { held: "resume", after: "pause" },
  ] as const)(
    "honors a $after made after release over a $held made while held",
    async ({ held, after }) => {
      const socket = new Socket();
      const chunks: string[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(String(chunk)));
      holdPipe(socket);
      socket[held]();
      socket.push(Buffer.from("held"));
      releasePipe(socket);
      socket[after]();
      await yieldToEventLoop();
      expect(socket.isPaused()).toBe(after === "pause");
      expect(chunks).toEqual(after === "resume" ? ["held"] : []);
      socket.destroy();
    },
  );
});
