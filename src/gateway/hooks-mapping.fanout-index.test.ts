import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { applyHookMappings, resolveHookMappings } from "./hooks-mapping.js";

let configDir: string;

beforeAll(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fanout-index-"));
  await fs.mkdir(path.join(configDir, "hooks", "transforms"), { recursive: true });
  await fs.writeFile(
    path.join(configDir, "hooks", "transforms", "drop-b.mjs"),
    'export default ({ payload }) => (payload.messages[0].id === "b" ? null : {});\n',
    "utf-8",
  );
});

afterAll(async () => {
  await fs.rm(configDir, { recursive: true, force: true });
});

describe("fan-out item positions", () => {
  test("actions keep their original item index when a transform drops earlier items", async () => {
    const mappings = resolveHookMappings(
      {
        mappings: [
          {
            match: { path: "batch" },
            action: "wake",
            forEach: "messages",
            textTemplate: "{{messages[0].id}}",
            transform: { module: "drop-b.mjs" },
          },
        ],
      },
      { configDir },
    );
    const result = await applyHookMappings(mappings, {
      payload: { messages: [{ id: "a" }, { id: "b" }, { id: "c" }] },
      headers: {},
      url: new URL("http://localhost/hooks/batch"),
      path: "batch",
    });
    expect(result?.ok).toBe(true);
    if (!result?.ok) {
      return;
    }
    expect(
      result.actions.map((action) => [action.itemIndex, action.kind === "wake" ? action.text : ""]),
    ).toEqual([
      [0, "a"],
      [2, "c"],
    ]);
  });
});
