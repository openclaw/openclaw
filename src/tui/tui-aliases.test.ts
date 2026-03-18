import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import {
  loadTuiAliases,
  normalizeTuiAliasName,
  parseTuiAliasArgs,
  resolveTuiAliasStorePath,
  saveTuiAliases,
} from "./tui-aliases.js";

describe("normalizeTuiAliasName", () => {
  it("normalizes valid alias names", () => {
    expect(normalizeTuiAliasName("  Review_PR  ")).toBe("review_pr");
  });

  it("rejects invalid alias names", () => {
    expect(normalizeTuiAliasName("")).toBeNull();
    expect(normalizeTuiAliasName("/review")).toBeNull();
    expect(normalizeTuiAliasName("review now")).toBeNull();
  });
});

describe("parseTuiAliasArgs", () => {
  it("supports quoted alias prompts", () => {
    expect(parseTuiAliasArgs(`review "check the PR and address comments"`)).toEqual([
      "review",
      "check the PR and address comments",
    ]);
  });

  it("keeps hash fragments in unquoted prompts", () => {
    expect(parseTuiAliasArgs("review check #49141")).toEqual(["review", "check", "#49141"]);
  });

  it("returns null for unterminated quotes", () => {
    expect(parseTuiAliasArgs(`review "oops`)).toBeNull();
  });
});

describe("tui alias store", () => {
  it("persists aliases under the OpenClaw state dir", async () => {
    await withTempHome(async () => {
      await saveTuiAliases({
        review: "check the PR",
        shipit: "merge it",
      });

      const filePath = resolveTuiAliasStorePath();
      await expect(fs.readFile(filePath, "utf8")).resolves.toContain('"review": "check the PR"');
      await expect(loadTuiAliases()).resolves.toEqual({
        review: "check the PR",
        shipit: "merge it",
      });
    });
  });

  it("returns an empty map when the alias file does not exist", async () => {
    await withTempHome(async () => {
      await expect(loadTuiAliases()).resolves.toEqual({});
    });
  });

  it("throws non-ENOENT read errors so callers can surface them", async () => {
    await withTempHome(async () => {
      const filePath = resolveTuiAliasStorePath();
      await fs.mkdir(filePath, { recursive: true });
      await expect(loadTuiAliases()).rejects.toThrow();
    });
  });
});
