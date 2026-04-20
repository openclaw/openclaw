import { describe, expect, it } from "vitest";
import { appendUnreleasedChangelogEntry } from "./changelog-unreleased.js";

const baseChangelog = `# Changelog

## Unreleased

### Breaking

- Existing breaking entry.

### Changes

- Existing change.

### Fixes

- Existing fix.

## 2026.4.5
`;

describe("appendUnreleasedChangelogEntry", () => {
  it("falls back to appending when the new entry has no PR ref", () => {
    const next = appendUnreleasedChangelogEntry(baseChangelog, {
      section: "Fixes",
      entry: "New fix entry.",
    });

    expect(next).toContain(`### Fixes

- Existing fix.
- New fix entry.`);
    expect(next).toContain("## 2026.4.5");
  });

  it("inserts a PR-linked entry ordered by PR number in the middle", () => {
    const content = `# Changelog

## Unreleased

### Changes

- Earlier change (#100). Thanks @alice
- Later change (#300). Thanks @carol

## 2026.4.5
`;

    const next = appendUnreleasedChangelogEntry(content, {
      section: "Changes",
      entry: "Middle change (#200). Thanks @bob",
    });

    expect(next).toBe(`# Changelog

## Unreleased

### Changes

- Earlier change (#100). Thanks @alice
- Middle change (#200). Thanks @bob
- Later change (#300). Thanks @carol

## 2026.4.5
`);
  });

  it("inserts a PR-linked entry with the smallest number at the top of the section", () => {
    const content = `# Changelog

## Unreleased

### Changes

- Later change (#300). Thanks @carol

## 2026.4.5
`;

    const next = appendUnreleasedChangelogEntry(content, {
      section: "Changes",
      entry: "Earliest change (#50). Thanks @alice",
    });

    expect(next).toBe(`# Changelog

## Unreleased

### Changes

- Earliest change (#50). Thanks @alice
- Later change (#300). Thanks @carol

## 2026.4.5
`);
  });

  it("inserts a PR-linked entry with the largest number at the tail of the section", () => {
    const content = `# Changelog

## Unreleased

### Changes

- Earlier change (#100). Thanks @alice
- Later change (#200). Thanks @bob

## 2026.4.5
`;

    const next = appendUnreleasedChangelogEntry(content, {
      section: "Changes",
      entry: "Newest change (#500). Thanks @carol",
    });

    expect(next).toBe(`# Changelog

## Unreleased

### Changes

- Earlier change (#100). Thanks @alice
- Later change (#200). Thanks @bob
- Newest change (#500). Thanks @carol

## 2026.4.5
`);
  });

  it("inserts into an empty sub-section while preserving surrounding spacing", () => {
    const content = `# Changelog

## Unreleased

### Changes

### Fixes

- Existing fix.

## 2026.4.5
`;

    const next = appendUnreleasedChangelogEntry(content, {
      section: "Changes",
      entry: "First change (#42). Thanks @alice",
    });

    expect(next).toContain("- First change (#42). Thanks @alice");
    // 新条目落在空 Changes 里、位于 Fixes 之前
    const changesIdx = next.indexOf("### Changes");
    const firstIdx = next.indexOf("- First change");
    const fixesIdx = next.indexOf("### Fixes");
    expect(changesIdx).toBeLessThan(firstIdx);
    expect(firstIdx).toBeLessThan(fixesIdx);
    // Fixes 下原有条目未被打乱
    expect(next).toContain(`### Fixes

- Existing fix.`);
  });

  it("skips historical bullets without PR refs when deciding order", () => {
    const content = `# Changelog

## Unreleased

### Changes

- Legacy unlinked entry without a PR ref.
- Linked change (#300). Thanks @carol

## 2026.4.5
`;

    const next = appendUnreleasedChangelogEntry(content, {
      section: "Changes",
      entry: "Linked change (#150). Thanks @bob",
    });

    // 150 < 300，新条目应该插在 (#300) 前面；没有 PR 号的历史行不当排序锚
    expect(next).toBe(`# Changelog

## Unreleased

### Changes

- Legacy unlinked entry without a PR ref.
- Linked change (#150). Thanks @bob
- Linked change (#300). Thanks @carol

## 2026.4.5
`);
  });

  it("avoids duplicating an existing entry", () => {
    const next = appendUnreleasedChangelogEntry(baseChangelog, {
      section: "Changes",
      entry: "- Existing change.",
    });

    expect(next).toBe(baseChangelog);
  });

  it("avoids duplicating an equivalent entry with the same PR reference", () => {
    const content = `# Changelog

## Unreleased

### Fixes

- Fix onboarding timeout handling (#123). Thanks @alice

## 2026.4.5
`;

    const next = appendUnreleasedChangelogEntry(content, {
      section: "Fixes",
      entry: "Fix onboarding timeout handling openclaw#123. Thanks @alice",
    });

    expect(next).toBe(content);
  });

  it("blocks a merge-stage re-insert even when new text and section differ (PR #67679 regression)", () => {
    // prepare 阶段：详细条目已经在 ### Fixes 里
    const content = `# Changelog

## Unreleased

### Changes

- macOS/gateway: add screen.snapshot support. (#67954) Thanks @BunsDev.

### Fixes

- Config/redact: add \`browser.cdpUrl\` and \`browser.profiles.*.cdpUrl\` to sensitive URL config paths so embedded credentials are properly redacted. (#67679) Thanks @Ziy1-Tan.

## 2026.4.15
`;

    // merge 阶段又走一次 ensure，默认 section=Changes，PR title 作为短版本
    const next = appendUnreleasedChangelogEntry(content, {
      section: "Changes",
      entry: "fix: redact credentials in browser.cdpUrl config paths (#67679). Thanks @Ziy1-Tan",
    });

    // 同一 PR 号在 Unreleased 任意 subsection 已存在 → 不再插入
    expect(next).toBe(content);
  });

  it("still inserts a new Unreleased entry when the same PR number exists only in a released block", () => {
    // 老版本块里碰巧有同号，不应阻止 Unreleased 插入新条目
    const content = `# Changelog

## Unreleased

### Changes

### Fixes

## 2026.4.15

### Fixes

- old released fix (#500). Thanks @alice
`;

    const next = appendUnreleasedChangelogEntry(content, {
      section: "Changes",
      entry: "brand new change (#500). Thanks @alice",
    });

    expect(next).not.toBe(content);
    expect(next).toContain("- brand new change (#500). Thanks @alice");
    expect(next).toContain("- old released fix (#500). Thanks @alice");
  });

  it("does not treat #67 as a duplicate of #6767 (PR number prefix collision)", () => {
    const content = `# Changelog

## Unreleased

### Changes

- longer PR (#6767). Thanks @alice

## 2026.4.15
`;

    const next = appendUnreleasedChangelogEntry(content, {
      section: "Changes",
      entry: "shorter PR (#67). Thanks @bob",
    });

    expect(next).toContain("- longer PR (#6767)");
    expect(next).toContain("- shorter PR (#67)");
  });

  it("throws when the unreleased section is missing", () => {
    expect(() =>
      appendUnreleasedChangelogEntry("# Changelog\n", {
        section: "Fixes",
        entry: "New fix entry.",
      }),
    ).toThrow("## Unreleased");
  });
});
