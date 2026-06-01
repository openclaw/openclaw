import { describe, expect, it } from "vitest";
import { upsertSection, WRITABLE_SECTIONS } from "./save-user-section.ts";

describe("upsertSection", () => {
  it("appends a new marker block to empty content", () => {
    const out = upsertSection("", "User_D_Prompt", "one\ntwo");
    expect(out).toBe(
      "<!-- app:User_D_Prompt:start -->\none\ntwo\n<!-- app:User_D_Prompt:end -->\n",
    );
  });

  it("appends after existing unrelated content with a blank-line separator", () => {
    const out = upsertSection("# notes\nhello", "app_note", "welcome");
    expect(out).toBe(
      "# notes\nhello\n\n<!-- app:app_note:start -->\nwelcome\n<!-- app:app_note:end -->\n",
    );
  });

  it("replaces an existing section in place, leaving surrounding content intact", () => {
    const file = [
      "intro",
      "<!-- app:User_D_Prompt:start -->",
      "old",
      "<!-- app:User_D_Prompt:end -->",
      "outro",
    ].join("\n");
    const out = upsertSection(file, "User_D_Prompt", "new value");
    expect(out).toBe(
      "intro\n<!-- app:User_D_Prompt:start -->\nnew value\n<!-- app:User_D_Prompt:end -->\noutro",
    );
  });

  it("does not touch a different section when replacing one", () => {
    const file = [
      "<!-- app:User_D_Prompt:start -->",
      "p",
      "<!-- app:User_D_Prompt:end -->",
      "",
      "<!-- app:app_note:start -->",
      "n",
      "<!-- app:app_note:end -->",
    ].join("\n");
    const out = upsertSection(file, "app_note", "n2");
    expect(out).toContain("<!-- app:User_D_Prompt:start -->\np\n<!-- app:User_D_Prompt:end -->");
    expect(out).toContain("<!-- app:app_note:start -->\nn2\n<!-- app:app_note:end -->");
  });

  it("trims the provided content", () => {
    const out = upsertSection("", "app_note", "  spaced  \n");
    expect(out).toBe("<!-- app:app_note:start -->\nspaced\n<!-- app:app_note:end -->\n");
  });

  it("throws on duplicate markers (refuses to guess)", () => {
    const dup = [
      "<!-- app:app_note:start -->a<!-- app:app_note:end -->",
      "<!-- app:app_note:start -->b<!-- app:app_note:end -->",
    ].join("\n");
    expect(() => upsertSection(dup, "app_note", "x")).toThrow(/duplicate markers/);
  });

  it("throws on a start marker with no end", () => {
    expect(() => upsertSection("<!-- app:app_note:start -->oops", "app_note", "x")).toThrow(
      /start without end/,
    );
  });

  it("round-trips: a written section is replaceable", () => {
    const first = upsertSection("", "User_D_Prompt", "v1");
    const second = upsertSection(first, "User_D_Prompt", "v2");
    expect(second).toBe("<!-- app:User_D_Prompt:start -->\nv2\n<!-- app:User_D_Prompt:end -->\n");
  });
});

describe("WRITABLE_SECTIONS", () => {
  it("matches the reader allowlist (User_D_Prompt, app_note)", () => {
    expect([...WRITABLE_SECTIONS].toSorted()).toEqual(["User_D_Prompt", "app_note"].toSorted());
  });
});
