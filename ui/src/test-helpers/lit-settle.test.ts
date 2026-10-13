/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { settleLitElement } from "./lit-settle.ts";

describe("settleLitElement", () => {
  it("keeps draining while updates schedule further updates", async () => {
    let cycles = 0;
    const element = {
      get updateComplete() {
        return Promise.resolve(++cycles > 7);
      },
    };

    await settleLitElement(element);

    // A fixed five-cycle pump would have returned before cycle 7 with work outstanding.
    expect(cycles).toBeGreaterThan(7);
  });

  it("throws instead of hanging when an element never settles", async () => {
    const element = { updateComplete: Promise.resolve(false) };

    await expect(settleLitElement(element)).rejects.toThrow("render loop");
  });

  it("drains a deep promise chain that only schedules a render at its end", async () => {
    // An initially settled element can still have a route loader that schedules a render.
    let pendingRender = false;
    let rendered = false;
    const element = {
      get updateComplete(): Promise<boolean> {
        if (pendingRender) {
          pendingRender = false;
          rendered = true;
          return Promise.resolve(false);
        }
        return Promise.resolve(true);
      },
    };
    let chain = Promise.resolve();
    for (let turn = 0; turn < 4; turn += 1) {
      chain = chain.then(() => undefined);
    }
    void chain.then(() => {
      pendingRender = true;
    });

    await settleLitElement(element);

    expect(rendered).toBe(true);
  });
});
