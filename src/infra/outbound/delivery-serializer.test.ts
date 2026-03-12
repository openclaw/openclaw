import { describe, expect, it } from "vitest";
import { DeliverySerializer } from "./delivery-serializer.js";

describe("DeliverySerializer", () => {
  it("serializes two sends to the same target in order", async () => {
    const serializer = new DeliverySerializer();
    const order: number[] = [];

    const p1 = serializer.serialize("key", async () => {
      await delay(50);
      order.push(1);
      return "a";
    });
    const p2 = serializer.serialize("key", async () => {
      order.push(2);
      return "b";
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
    expect(r1).toBe("a");
    expect(r2).toBe("b");
  });

  it("allows different targets to run concurrently", async () => {
    const serializer = new DeliverySerializer();
    const timeline: string[] = [];

    const p1 = serializer.serialize("a", async () => {
      timeline.push("a-start");
      await delay(50);
      timeline.push("a-end");
    });
    const p2 = serializer.serialize("b", async () => {
      timeline.push("b-start");
      await delay(50);
      timeline.push("b-end");
    });

    await Promise.all([p1, p2]);
    // Both should start before either ends (concurrent)
    expect(timeline.indexOf("a-start")).toBeLessThan(timeline.indexOf("a-end"));
    expect(timeline.indexOf("b-start")).toBeLessThan(timeline.indexOf("b-end"));
    expect(timeline.indexOf("b-start")).toBeLessThan(timeline.indexOf("a-end"));
  });

  it("runs second task even if first fails", async () => {
    const serializer = new DeliverySerializer();

    const p1 = serializer.serialize("key", async () => {
      throw new Error("boom");
    });
    const p2 = serializer.serialize("key", async () => "ok");

    await expect(p1).rejects.toThrow("boom");
    expect(await p2).toBe("ok");
  });

  it("cleans up keys when queue drains", async () => {
    const serializer = new DeliverySerializer();

    await serializer.serialize("key", async () => "done");
    expect(serializer.size).toBe(0);
  });

  it("serializes 10 concurrent sends in order", async () => {
    const serializer = new DeliverySerializer();
    const order: number[] = [];

    const promises = Array.from({ length: 10 }, (_, i) =>
      serializer.serialize("key", async () => {
        // Random tiny delay to stress ordering
        await delay(Math.random() * 10);
        order.push(i);
        return i;
      }),
    );

    const results = await Promise.all(promises);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(serializer.size).toBe(0);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
