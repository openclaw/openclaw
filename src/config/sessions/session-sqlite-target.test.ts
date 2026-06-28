import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

describe("resolveSqliteTargetFromSessionStorePath", () => {
  it("keeps custom store targets distinct when templates share a directory", () => {
    const dir = path.join("tmp", "stores");

    expect(resolveSqliteTargetFromSessionStorePath(path.join(dir, "main.json"))).toMatchObject({
      path: path.resolve(dir, "main.sqlite"),
    });
    expect(resolveSqliteTargetFromSessionStorePath(path.join(dir, "worker.json"))).toMatchObject({
      path: path.resolve(dir, "worker.sqlite"),
    });
  });
});
