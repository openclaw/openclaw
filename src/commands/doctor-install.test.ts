// Doctor install tests cover install checks, repair notes, and binary/package diagnostics.
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { noteSourceInstallIssues } from "./doctor-install.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: vi.fn(),
}));

async function writeFile(root: string, relativePath: string, content = "") {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

describe("noteSourceInstallIssues", () => {
  beforeEach(() => {
    vi.mocked(note).mockReset();
  });

  it("does not treat a packaged workspace config as a source checkout", async () => {
    await withTestDir({ prefix: "openclaw-doctor-install-" }, async (root) => {
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
      await writeFile(root, "pnpm-workspace.yaml", "packages:\n  - .\n");

      noteSourceInstallIssues(root);

      expect(note).not.toHaveBeenCalled();
    });
  });

  it("warns source checkouts when node_modules was not installed by pnpm", async () => {
    await withTestDir({ prefix: "openclaw-doctor-install-" }, async (root) => {
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
      await writeFile(root, "pnpm-workspace.yaml", "packages:\n  - .\n");
      await writeFile(root, "src/entry.ts", "export {};\n");

      noteSourceInstallIssues(root);

      expect(note).toHaveBeenCalledWith(
        [
          "- node_modules was not installed by pnpm (missing node_modules/.pnpm). Run: pnpm install so bundled plugins can load package-local dependencies.",
          "- tsx binary is missing for source runs. Run: pnpm install.",
        ].join("\n"),
        "Install",
      );
    });
  });
});

async function writeSourceCheckout(root: string, workspace: string) {
  await writeFile(root, "src/entry.ts", "export {};\n");
  await writeFile(root, "node_modules/.bin/tsx");
  await fs.mkdir(path.join(root, "node_modules/.pnpm"), { recursive: true });
  await writeFile(root, "package.json", JSON.stringify({ name: "openclaw" }));
  await writeFile(root, "pnpm-workspace.yaml", workspace);
}

describe("source self-link recovery", () => {
  beforeEach(() => vi.mocked(note).mockReset());

  it.each([
    ["block map", "overrides:\n  openclaw: 'link:'\n"],
    ["scalar alias", "self: &self 'link:.'\noverrides: {openclaw: *self}\n"],
    ["map alias", "pins: &pins {openclaw: 'link:.'}\noverrides: *pins\n"],
    ["flow map", "overrides: { openclaw: 'link:.' }\n"],
    ["quoted keys", '"overrides":\n  "openclaw": "link:."\n'],
    ["commented header", "overrides: # pinned packages\n  openclaw: 'link:.'\n"],
    ["blank line", "overrides:\n  example: 1.0.0\n\n  openclaw: 'link:.'\n"],
    ["CRLF", "overrides:\r\n  openclaw: 'link:.'\r\n"],
  ])("recognizes valid %s overrides", async (_name, workspace) => {
    await withTestDir({ prefix: "openclaw-doctor-self-link-" }, async (root) => {
      await writeSourceCheckout(root, workspace);
      noteSourceInstallIssues(root);
      expect(note).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("pnpm-workspace.yaml contains a self-referential"),
        "Install",
      );
    });
  });

  it.each([
    ["non-overrides map", "catalog:\n  openclaw: 'link:.'\n"],
    ["nested overrides value", "overrides:\n  example:\n    openclaw: 'link:.'\n"],
    ["comment", "# overrides: {openclaw: 'link:.'}\n"],
    ["normal override", "overrides:\n  openclaw: 2026.9.4\n"],
    ["non-string override", "overrides:\n  openclaw: [link]\n"],
    ["unquoted trailing colon", "overrides:\n  openclaw: link:\n"],
    ["duplicate key", "overrides:\n  openclaw: 'link:.'\n  openclaw: 2026.9.4\n"],
    ["malformed YAML", "overrides: [\n"],
    [
      "excessive alias expansion",
      "a: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\noverrides: {openclaw: 'link:.'}\n",
    ],
  ])("does not report a self-link for %s", async (_name, workspace) => {
    await withTestDir({ prefix: "openclaw-doctor-self-link-" }, async (root) => {
      await writeSourceCheckout(root, workspace);
      expect(() => noteSourceInstallIssues(root)).not.toThrow();
      expect(note).not.toHaveBeenCalled();
    });
  });

  it.each(["dependencies", "devDependencies"])(
    "reports %s and selective three-file guidance",
    async (section) => {
      await withTestDir({ prefix: "openclaw-doctor-self-link-" }, async (root) => {
        await writeSourceCheckout(root, "packages: ['.']\n");
        await writeFile(
          root,
          "package.json",
          JSON.stringify({ [section]: { openclaw: "link:." } }),
        );
        noteSourceInstallIssues(root);
        expect(note).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("package.json has a self-referential"),
          "Install",
        );
        const warning = String(vi.mocked(note).mock.calls[0]?.[0]);
        expect(warning).toContain("git diff -- package.json pnpm-workspace.yaml pnpm-lock.yaml");
        expect(warning).toContain("missing override pins");
        expect(warning).toContain("preserving unrelated edits in all three files");
        expect(warning).toContain("pnpm install --frozen-lockfile");
      });
    },
  );

  it("continues other checks when the workspace cannot be read", async () => {
    await withTestDir({ prefix: "openclaw-doctor-self-link-" }, async (root) => {
      await writeSourceCheckout(root, "");
      await fs.rm(path.join(root, "pnpm-workspace.yaml"));
      await fs.mkdir(path.join(root, "pnpm-workspace.yaml"));
      await writeFile(root, "package-lock.json", "{}");
      expect(() => noteSourceInstallIssues(root)).not.toThrow();
      expect(note).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("package-lock.json present"),
        "Install",
      );
    });
  });

  it("continues workspace checks when package.json is malformed", async () => {
    await withTestDir({ prefix: "openclaw-doctor-self-link-" }, async (root) => {
      await writeSourceCheckout(root, "overrides: {openclaw: 'link:.'}\n");
      await writeFile(root, "package.json", "{");
      expect(() => noteSourceInstallIssues(root)).not.toThrow();
      expect(note).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("pnpm-workspace.yaml contains"),
        "Install",
      );
    });
  });

  it("ignores healthy manifest values, absent roots, and packaged self-link lookalikes", async () => {
    noteSourceInstallIssues(null);
    await withTestDir({ prefix: "openclaw-doctor-self-link-" }, async (root) => {
      await writeSourceCheckout(root, "packages: ['.']\n");
      await writeFile(
        root,
        "package.json",
        JSON.stringify({
          dependencies: { openclaw: "^2026.9.4" },
          devDependencies: { openclaw: null },
        }),
      );
      noteSourceInstallIssues(root);
      await fs.rm(path.join(root, "src/entry.ts"));
      await writeFile(root, "pnpm-workspace.yaml", "overrides: {openclaw: 'link:.'}\n");
      await writeFile(
        root,
        "package.json",
        JSON.stringify({ dependencies: { openclaw: "link:." } }),
      );
      noteSourceInstallIssues(root);
      expect(note).not.toHaveBeenCalled();
    });
  });
});

describe("self-link target and diagnostic accuracy", () => {
  beforeEach(() => vi.mocked(note).mockReset());

  it.each(["link:../openclaw-fork", "link:packages/openclaw"])(
    "preserves legitimate local target %s in both dependency maps and overrides",
    async (link) => {
      await withTestDir({ prefix: "openclaw-doctor-self-link-" }, async (root) => {
        await writeSourceCheckout(root, `overrides: {openclaw: '${link}'}\n`);
        await writeFile(
          root,
          "package.json",
          JSON.stringify({ dependencies: { openclaw: link }, devDependencies: { openclaw: link } }),
        );
        noteSourceInstallIssues(root);
        expect(note).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["empty", "dot", "absolute", "symlink"])(
    "detects a %s link resolving to this checkout without claiming a lockfile error",
    async (kind) => {
      await withTestDir({ prefix: "openclaw-doctor-self-link-" }, async (root) => {
        if (kind === "symlink") {
          await fs.symlink(
            root,
            path.join(root, "self"),
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        const target =
          kind === "empty" ? "" : kind === "dot" ? "." : kind === "absolute" ? root : "self";
        const link = `link:${target}`;
        await writeSourceCheckout(root, `overrides: {openclaw: '${link}'}\n`);
        await writeFile(root, "package.json", JSON.stringify({ dependencies: { openclaw: link } }));
        noteSourceInstallIssues(root);
        expect(note).toHaveBeenCalledOnce();
        const warning = String(vi.mocked(note).mock.calls[0]?.[0]);
        expect(warning).toContain("package.json has a self-referential");
        expect(warning).toContain("pnpm-workspace.yaml contains a self-referential");
        expect(warning).not.toContain("ERR_PNPM_LOCKFILE_CONFIG_MISMATCH");
        expect(warning).toContain("can break frozen pnpm installs");
        expect(warning).toContain("If the link is unintended");
      });
    },
  );
});
