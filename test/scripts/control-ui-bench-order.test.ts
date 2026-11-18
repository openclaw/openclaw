import { expect, it } from "vitest";
import { controlUiBenchOrder } from "../../scripts/lib/control-ui-bench-order.ts";

it("crosses every build with every position and direction in six triplets", () => {
  const builds = ["base", "head", "control"];
  const orders = Array.from({ length: 6 }, (_, pair) => controlUiBenchOrder(builds, pair));
  expect(new Set(orders.map((order) => order.join(","))).size).toBe(6);
  for (const build of builds) {
    for (let position = 0; position < builds.length; position++) {
      expect(orders.filter((order) => order[position] === build)).toHaveLength(2);
    }
  }
  expect(builds).toEqual(["base", "head", "control"]);
});
