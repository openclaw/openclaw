import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileBrowserSelectList, type FileBrowserTheme } from "./file-browser-select-list.js";

// Identity theme so renders are plain text (no ANSI)
const mockTheme: FileBrowserTheme = {
  selectedPrefix: (t) => t,
  selectedText: (t) => t,
  description: (t) => t,
  scrollInfo: (t) => t,
  noMatch: (t) => t,
  searchPrompt: (t) => t,
  searchInput: (t) => t,
  checked: (t) => t,
  unchecked: (t) => t,
  dirIcon: (t) => t,
  fileIcon: (t) => t,
  breadcrumb: (t) => t,
};

// Key constants
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const BACKSPACE = "\x7f";
const ESCAPE = "\x1b";
const LEFT = "\x1b[D";
const SPACE = " ";

describe("FileBrowserSelectList", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fb-test-"));
    // Create a test directory structure:
    //   alpha.txt
    //   beta.ts
    //   .hidden
    //   subdir/
    //     nested.txt
    writeFileSync(join(tmpDir, "alpha.txt"), "hello");
    writeFileSync(join(tmpDir, "beta.ts"), "world");
    writeFileSync(join(tmpDir, ".hidden"), "secret");
    mkdirSync(join(tmpDir, "subdir"));
    writeFileSync(join(tmpDir, "subdir", "nested.txt"), "nested content");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders directory contents with breadcrumb", () => {
    const fb = new FileBrowserSelectList(tmpDir, 10, mockTheme);
    const output = fb.render(80);
    const text = output.join("\n");

    // Breadcrumb should show the current directory
    expect(text).toContain(tmpDir);
    // Should show files and directory
    expect(text).toContain("subdir/");
    expect(text).toContain("alpha.txt");
    expect(text).toContain("beta.ts");
  });

  it("excludes hidden files (dotfiles)", () => {
    const fb = new FileBrowserSelectList(tmpDir, 10, mockTheme);
    const text = fb.render(80).join("\n");

    expect(text).not.toContain(".hidden");
  });

  it("lists directories before files, both sorted alphabetically", () => {
    // Add another directory to confirm ordering
    mkdirSync(join(tmpDir, "aaa-dir"));
    const fb = new FileBrowserSelectList(tmpDir, 10, mockTheme);
    const text = fb.render(80).join("\n");

    const aaaIdx = text.indexOf("aaa-dir/");
    const subdirIdx = text.indexOf("subdir/");
    const alphaIdx = text.indexOf("alpha.txt");
    const betaIdx = text.indexOf("beta.ts");

    // Directories come first, alphabetically
    expect(aaaIdx).toBeLessThan(subdirIdx);
    // Files come after directories, alphabetically
    expect(subdirIdx).toBeLessThan(alphaIdx);
    expect(alphaIdx).toBeLessThan(betaIdx);
  });

  it("navigates down and up with arrow keys", () => {
    const fb = new FileBrowserSelectList(tmpDir, 10, mockTheme);

    // Initial selection is the first entry (subdir, since dirs first)
    let output = fb.render(80).join("\n");
    // The cursor marker is on subdir
    expect(output).toContain("→");

    // Move down
    fb.handleInput(DOWN);
    output = fb.render(80).join("\n");
    // Both entries should be visible; just verify no crash and selection moved

    // Move back up
    fb.handleInput(UP);
    // Should be back at first entry without error
    fb.render(80);
  });

  it("selects and deselects a file with Space", () => {
    const fb = new FileBrowserSelectList(tmpDir, 10, mockTheme);

    // Move to first file (skip the directory). Entries: subdir, alpha.txt, beta.ts
    fb.handleInput(DOWN); // now on alpha.txt

    // Select
    fb.handleInput(SPACE);
    expect(fb.getSelectedPaths()).toEqual([join(tmpDir, "alpha.txt")]);

    // Rendered output should show "1 file selected"
    let text = fb.render(80).join("\n");
    expect(text).toContain("1 file selected");

    // Deselect
    fb.handleInput(SPACE);
    expect(fb.getSelectedPaths()).toEqual([]);
    text = fb.render(80).join("\n");
    expect(text).toContain("No files selected");
  });

  it("can multi-select files", () => {
    const fb = new FileBrowserSelectList(tmpDir, 10, mockTheme);

    // Select alpha.txt (index 1) and beta.ts (index 2)
    fb.handleInput(DOWN); // alpha.txt
    fb.handleInput(SPACE);
    fb.handleInput(DOWN); // beta.ts
    fb.handleInput(SPACE);

    const selected = fb.getSelectedPaths();
    expect(selected).toHaveLength(2);
    expect(selected).toContain(join(tmpDir, "alpha.txt"));
    expect(selected).toContain(join(tmpDir, "beta.ts"));

    const text = fb.render(80).join("\n");
    expect(text).toContain("2 files selected");
  });

  it("enters a directory with Enter", () => {
    const fb = new FileBrowserSelectList(tmpDir, 10, mockTheme);

    // First entry is subdir (dirs come first)
    fb.handleInput(ENTER);

    const text = fb.render(80).join("\n");
    // Breadcrumb should now show the subdir path
    expect(text).toContain(join(tmpDir, "subdir"));
    // Should show the nested file
    expect(text).toContain("nested.txt");
    // Should not show parent-level files
    expect(text).not.toContain("alpha.txt");
  });

  it("Space on a directory navigates into it", () => {
    const fb = new FileBrowserSelectList(tmpDir, 10, mockTheme);

    // First entry is subdir
    fb.handleInput(SPACE);

    const text = fb.render(80).join("\n");
    expect(text).toContain(join(tmpDir, "subdir"));
    expect(text).toContain("nested.txt");
  });

  it("goes to parent directory with Backspace when filter is empty", () => {
    const fb = new FileBrowserSelectList(tmpDir, 10, mockTheme);

    // Navigate into subdir
    fb.handleInput(ENTER);
    let text = fb.render(80).join("\n");
    expect(text).toContain("nested.txt");

    // Go back with Backspace
    fb.handleInput(BACKSPACE);
    text = fb.render(80).join("\n");
    expect(text).toContain("alpha.txt");
    expect(text).toContain("subdir/");
  });

  it("goes to parent directory with Left arrow", () => {
    const fb = new FileBrowserSelectList(tmpDir, 10, mockTheme);

    // Navigate into subdir
    fb.handleInput(ENTER);

    // Go back with Left arrow
    fb.handleInput(LEFT);
    const text = fb.render(80).join("\n");
    expect(text).toContain("alpha.txt");
  });

  it("filters entries by typing", () => {
    const fb = new FileBrowserSelectList(tmpDir, 10, mockTheme);

    // Type "alpha" to filter
    for (const ch of "alpha") {
      fb.handleInput(ch);
    }

    const text = fb.render(80).join("\n");
    expect(text).toContain("alpha.txt");
    expect(text).not.toContain("beta.ts");
    expect(text).not.toContain("subdir/");
  });

  it("shows no files found when filter matches nothing", () => {
    const fb = new FileBrowserSelectList(tmpDir, 10, mockTheme);

    for (const ch of "zzzzz") {
      fb.handleInput(ch);
    }

    const text = fb.render(80).join("\n");
    expect(text).toContain("No files found");
  });

  it("confirms with Enter and returns selected paths via onConfirm", () => {
    const fb = new FileBrowserSelectList(tmpDir, 10, mockTheme);
    let confirmed: string[] | undefined;
    fb.onConfirm = (paths) => {
      confirmed = paths;
    };

    // Select alpha.txt then confirm
    fb.handleInput(DOWN); // alpha.txt
    fb.handleInput(SPACE);
    fb.handleInput(ENTER);

    expect(confirmed).toEqual([join(tmpDir, "alpha.txt")]);
  });

  it("confirms with single file under cursor when nothing is checked", () => {
    const fb = new FileBrowserSelectList(tmpDir, 10, mockTheme);
    let confirmed: string[] | undefined;
    fb.onConfirm = (paths) => {
      confirmed = paths;
    };

    // Move to alpha.txt (no Space, so nothing checked) then Enter
    fb.handleInput(DOWN); // alpha.txt
    fb.handleInput(ENTER);

    expect(confirmed).toEqual([join(tmpDir, "alpha.txt")]);
  });

  it("does not confirm when cursor is on a directory and nothing checked", () => {
    const fb = new FileBrowserSelectList(tmpDir, 10, mockTheme);
    let confirmed: string[] | undefined;
    fb.onConfirm = (paths) => {
      confirmed = paths;
    };

    // Cursor is on subdir (first entry), Enter should navigate, not confirm
    fb.handleInput(ENTER);

    // Should have navigated into subdir, not confirmed
    expect(confirmed).toBeUndefined();
    const text = fb.render(80).join("\n");
    expect(text).toContain("nested.txt");
  });

  it("calls onCancel when Escape is pressed", () => {
    const fb = new FileBrowserSelectList(tmpDir, 10, mockTheme);
    let cancelled = false;
    fb.onCancel = () => {
      cancelled = true;
    };

    fb.handleInput(ESCAPE);

    expect(cancelled).toBe(true);
  });

  it("preserves checked paths across directory navigation", () => {
    const fb = new FileBrowserSelectList(tmpDir, 10, mockTheme);

    // Check alpha.txt
    fb.handleInput(DOWN); // alpha.txt
    fb.handleInput(SPACE);
    expect(fb.getSelectedPaths()).toHaveLength(1);

    // Navigate into subdir and back
    fb.handleInput(UP); // back to subdir
    fb.handleInput(ENTER); // enter subdir
    fb.handleInput(BACKSPACE); // back to parent

    // alpha.txt should still be checked
    expect(fb.getSelectedPaths()).toEqual([join(tmpDir, "alpha.txt")]);
  });

  it("resets search input and selected index when navigating into a directory", () => {
    const fb = new FileBrowserSelectList(tmpDir, 10, mockTheme);

    // Type a filter first
    fb.handleInput("s");
    let text = fb.render(80).join("\n");
    expect(text).toContain("subdir/");

    // Enter subdir
    fb.handleInput(ENTER);
    text = fb.render(80).join("\n");
    // Filter should be cleared in the new directory
    expect(text).toContain("nested.txt");
  });

  it("handles empty directory gracefully", () => {
    const emptyDir = join(tmpDir, "empty");
    mkdirSync(emptyDir);

    const fb = new FileBrowserSelectList(emptyDir, 10, mockTheme);
    const text = fb.render(80).join("\n");

    expect(text).toContain("No files found");
  });

  it("shows scroll info when entries exceed maxVisible", () => {
    // Create many files
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(tmpDir, `file${String(i).padStart(2, "0")}.txt`), "data");
    }

    const fb = new FileBrowserSelectList(tmpDir, 5, mockTheme);
    const text = fb.render(80).join("\n");

    // Should show scroll position info (e.g., "1/23")
    expect(text).toMatch(/\d+\/\d+/);
  });
});
