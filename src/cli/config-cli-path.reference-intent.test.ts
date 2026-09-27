import { describe, expect, it, vi } from "vitest";

// Parsing and CLI hint rendering are outside this merge-intent contract.
vi.mock("../config/value-tree.js", () => ({
  rejectConfigNonFiniteNumbers: () => {
    throw new Error("Unexpected parser call");
  },
}));
vi.mock("./command-format.js", () => ({
  formatCliCommand: () => {
    throw new Error("Unexpected CLI hint call");
  },
}));
import { getAtPath, mergeAtPath } from "./config-cli-path.js";

describe("config merge supplied value intent", () => {
  it("marks only supplied leaves, including an equal-valued reference, not untouched escapes", () => {
    const root = {
      browser: {
        enabled: true,
        executablePath: "${BROWSER_A}",
        nested: {
          same: "${TOKEN}",
          literal: "$${TOKEN}",
        },
      },
    };
    const supplied = mergeAtPath(root, ["browser"], {
      enabled: false,
      nested: { same: "${TOKEN}" },
    });
    expect(root.browser).toEqual({
      enabled: false,
      executablePath: "${BROWSER_A}",
      nested: { same: "${TOKEN}", literal: "$${TOKEN}" },
    });
    expect(supplied).toEqual([
      ["browser", "enabled"],
      ["browser", "nested", "same"],
    ]);
  });

  it.each([false, true])(
    "maps model IDs to destination indices under parent merge: %s",
    (parent) => {
      const first = { id: "first", name: "$${FIRST}", input: ["text"] };
      const second = { id: "second", name: "$${SECOND}", contextWindow: 1000 };
      const root = { models: { providers: { custom: { models: [first, second] } } } };
      const update = [
        { id: "second", contextWindow: 2000 },
        { id: "third", name: "${THIRD}" },
      ];
      const supplied = parent
        ? mergeAtPath(root, ["models"], { providers: { custom: { models: update } } })
        : mergeAtPath(root, ["models", "providers", "custom", "models"], update);
      expect(root.models.providers.custom.models).toEqual([
        first,
        { ...second, contextWindow: 2000 },
        update[1],
      ]);
      const prefix = ["models", "providers", "custom", "models"];
      expect(supplied).toEqual([
        [...prefix, "1", "id"],
        [...prefix, "1", "contextWindow"],
        [...prefix, "2"],
      ]);
      expect(first).toEqual({ id: "first", name: "$${FIRST}", input: ["text"] });
      expect(second.contextWindow).toBe(1000);
    },
  );

  it("retains numeric object-key identity and does not mark an empty descendant merge explicit", () => {
    const root = {
      plugins: {
        entries: {
          "123": {
            config: {
              token: "$${TOKEN}",
              enabled: true,
            },
          },
        },
      },
    };
    const path = ["plugins", "entries", "123", "config"];
    expect(mergeAtPath(root, path, {})).toEqual([]);
    expect(mergeAtPath(root, path, { enabled: false })).toEqual([[...path, "enabled"]]);
    expect(getAtPath(root, [...path, "token"]).value).toBe("$${TOKEN}");
  });

  it("marks a newly supplied subtree and a replaced ordinary array without claiming siblings", () => {
    const root: Record<string, unknown> = {
      browser: { args: ["$${OLD}"], executablePath: "$${BIN}" },
    };
    expect(
      mergeAtPath(root, ["browser"], { args: ["${NEW}"], extra: { token: "${EXTRA}" } }),
    ).toEqual([
      ["browser", "args"],
      ["browser", "extra"],
    ]);
    expect(mergeAtPath(root, ["new"], { child: "${NEW}" })).toEqual([["new"]]);
    expect(getAtPath(root, ["browser", "executablePath"]).value).toBe("$${BIN}");
  });
});
