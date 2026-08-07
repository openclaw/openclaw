// Doctor install tests cover install checks, repair notes, and binary/package diagnostics.
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { noteSourceInstallIssues } from "./doctor-install.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: vi.fn(),
}));

async function writeFile(root: string, relativePath: string, content = "") {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

async function writeHealthySourceCheckout(root: string) {
  await fs.mkdir(path.join(root, "node_modules", ".pnpm"), { recursive: true });
  await writeFile(root, "node_modules/.bin/tsx", "#!/bin/sh\n");
  await writeFile(root, "pnpm-workspace.yaml", "packages:\n  - .\n");
  await writeFile(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  await writeFile(root, "src/entry.ts", "export {};\n");
  await writeFile(root, "package.json", JSON.stringify({ name: "openclaw" }));
}

function noteOutput(): string {
  return vi
    .mocked(note)
    .mock.calls.map(([message]) => String(message))
    .join("\n");
}

describe("noteSourceInstallIssues", () => {
  beforeEach(() => {
    vi.mocked(note).mockReset();
  });

  it("does not treat a packaged workspace config as a source checkout", async () => {
    await withTempDir({ prefix: "openclaw-doctor-install-" }, async (root) => {
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
      await writeFile(root, "pnpm-workspace.yaml", "packages:\n  - .\n");

      noteSourceInstallIssues(root);

      expect(note).not.toHaveBeenCalled();
    });
  });

  it("warns source checkouts when node_modules was not installed by pnpm", async () => {
    await withTempDir({ prefix: "openclaw-doctor-install-" }, async (root) => {
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

  it.each(["dependencies", "devDependencies", "optionalDependencies"] as const)(
    "warns when package.json %s contains a self-referential OpenClaw link",
    async (field) => {
      await withTempDir({ prefix: "openclaw-doctor-install-" }, async (root) => {
        await writeHealthySourceCheckout(root);
        await writeFile(
          root,
          "package.json",
          JSON.stringify({ name: "openclaw", [field]: { openclaw: "link:" } }),
        );

        noteSourceInstallIssues(root);

        expect(noteOutput()).toContain(`package.json ${field}`);
      });
    },
  );

  it.each(["'link:'", "link:."])(
    "warns when pnpm-workspace.yaml overrides.openclaw is %s",
    async (specifier) => {
      await withTempDir({ prefix: "openclaw-doctor-install-" }, async (root) => {
        await writeHealthySourceCheckout(root);
        await writeFile(
          root,
          "pnpm-workspace.yaml",
          `packages:\n  - .\noverrides:\n  openclaw: ${specifier}\n`,
        );

        noteSourceInstallIssues(root);

        expect(noteOutput()).toContain("pnpm-workspace.yaml overrides");
      });
    },
  );

  it("reports complete warn-only recovery for combined manifest damage", async () => {
    await withTempDir({ prefix: "openclaw-doctor-install-" }, async (root) => {
      await writeHealthySourceCheckout(root);
      await writeFile(
        root,
        "package.json",
        JSON.stringify({ name: "openclaw", dependencies: { openclaw: "link:" } }),
      );
      await writeFile(
        root,
        "pnpm-workspace.yaml",
        "packages:\n  - .\noverrides:\n  openclaw: 'link:'\n",
      );

      noteSourceInstallIssues(root);

      const output = noteOutput();
      expect(output).toContain("package.json dependencies");
      expect(output).toContain("pnpm-workspace.yaml overrides");
      expect(output).toContain("package.json, pnpm-workspace.yaml, and pnpm-lock.yaml");
      expect(output).toContain("restore all three from the current commit");
      expect(output).toContain(
        "git restore --source=HEAD -- package.json pnpm-workspace.yaml pnpm-lock.yaml",
      );
      expect(output).toContain("pnpm install --frozen-lockfile");
      expect(output).toContain("intentional dependency edits");
      expect(note).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ["catalog", "catalog:\n  openclaw: 'link:../openclaw'\n"],
    ["named catalog", "catalogs:\n  internal:\n    openclaw: 'link:../openclaw'\n"],
    ["custom key", "custom:\n  openclaw: 'link:../openclaw'\n"],
    ["nested override", "overrides:\n  other-package:\n    openclaw: 'link:../openclaw'\n"],
  ])("ignores an OpenClaw link in a workspace %s", async (_label, workspaceYaml) => {
    await withTempDir({ prefix: "openclaw-doctor-install-" }, async (root) => {
      await writeHealthySourceCheckout(root);
      await writeFile(root, "pnpm-workspace.yaml", `packages:\n  - .\n${workspaceYaml}`);

      noteSourceInstallIssues(root);

      expect(note).not.toHaveBeenCalled();
    });
  });

  it("does not throw on malformed package or workspace manifests", async () => {
    await withTempDir({ prefix: "openclaw-doctor-install-" }, async (root) => {
      await writeHealthySourceCheckout(root);
      await writeFile(root, "package.json", "{");
      await writeFile(root, "pnpm-workspace.yaml", "overrides:\n  openclaw: link:\n");

      expect(() => noteSourceInstallIssues(root)).not.toThrow();
      expect(note).not.toHaveBeenCalled();
    });
  });

  it("stays silent for a healthy source checkout without self-links", async () => {
    await withTempDir({ prefix: "openclaw-doctor-install-" }, async (root) => {
      await writeHealthySourceCheckout(root);
      await writeFile(
        root,
        "package.json",
        JSON.stringify({
          name: "openclaw",
          dependencies: { react: "^19.0.0" },
          peerDependencies: { openclaw: "link:../openclaw" },
        }),
      );

      noteSourceInstallIssues(root);

      expect(note).not.toHaveBeenCalled();
    });
  });
});
