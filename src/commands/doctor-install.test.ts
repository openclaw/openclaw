import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { noteSourceInstallIssues } from "./doctor-install.js";
import { MACOS_APP_INSTALL_OWNER_MARKER } from "./test-runtime-config-helpers.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: vi.fn(),
}));

async function writeFile(root: string, relativePath: string, content = "") {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

function withCheckout(workspace: string, run: (root: string) => Promise<void>) {
  return withTestDir({ prefix: "openclaw-doctor-install-" }, async (root) => {
    await writeSourceCheckout(root, workspace);
    await run(root);
  });
}
const writeManifest = (root: string, manifest: unknown) =>
  writeFile(root, "package.json", JSON.stringify(manifest));
function capturedWarning() {
  expect(note).toHaveBeenCalledOnce();
  return String(vi.mocked(note).mock.calls[0]?.[0]);
}

beforeEach(() => {
  vi.mocked(note).mockReset();
});

it("reports the host owner instead of source package repair advice", async () => {
  await withCheckout("overrides: {openclaw: 'link:.'}\n", async (root) => {
    await writeFile(root, "openclaw-install-owner.json", MACOS_APP_INSTALL_OWNER_MARKER);

    await noteSourceInstallIssues(root);

    expect(note).toHaveBeenCalledExactlyOnceWith(
      "Managed by OpenClaw.app. Update OpenClaw.app to update this Gateway.",
      "Install",
    );
  });
});

it("warns source checkouts when node_modules was not installed by pnpm", async () => {
  await withTestDir({ prefix: "openclaw-doctor-install-" }, async (root) => {
    await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
    await writeFile(root, "pnpm-workspace.yaml", "packages:\n  - .\n");
    await writeFile(root, "src/entry.ts", "export {};\n");

    await noteSourceInstallIssues(root);

    expect(note).toHaveBeenCalledWith(
      [
        "- node_modules was not installed by pnpm (missing node_modules/.pnpm). Run: pnpm install so bundled plugins can load package-local dependencies.",
        "- tsx binary is missing for source runs. Run: pnpm install.",
      ].join("\n"),
      "Install",
    );
  });
});

async function writeSourceCheckout(root: string, workspace: string) {
  await writeFile(root, "src/entry.ts", "export {};\n");
  await writeFile(root, "node_modules/.bin/tsx");
  await fs.mkdir(path.join(root, "node_modules/.pnpm"), { recursive: true });
  await writeManifest(root, { name: "openclaw" });
  await writeFile(root, "pnpm-workspace.yaml", workspace);
}

it.each([
  ...(
    [
      ["block map", "overrides:\n  openclaw: 'link:'\n"],
      ["scalar alias", "self: &self 'link:.'\noverrides: {openclaw: *self}\n"],
      ["map alias", "pins: &pins {openclaw: 'link:.'}\noverrides: *pins\n"],
      ["flow map", "overrides: { openclaw: 'link:.' }\n"],
      ["quoted keys", '"overrides":\n  "openclaw": "link:."\n'],
      ["commented header", "overrides: # pinned packages\n  openclaw: 'link:.'\n"],
      ["blank line", "overrides:\n  example: 1.0.0\n\n  openclaw: 'link:.'\n"],
      ["CRLF", "overrides:\r\n  openclaw: 'link:.'\r\n"],
    ] as const
  ).map(([name, workspace]) => ({ name, workspace, selfLink: true })),
  ...(
    [
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
    ] as const
  ).map(([name, workspace]) => ({ name, workspace, selfLink: false })),
])("checks workspace self-links in $name", async ({ workspace, selfLink }) => {
  await withCheckout(workspace, async (root) => {
    await expect(noteSourceInstallIssues(root)).resolves.toBeUndefined();
    if (selfLink) {
      expect(note).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("pnpm-workspace.yaml contains a self-referential"),
        "Install",
      );
    } else {
      expect(note).not.toHaveBeenCalled();
    }
  });
});

it.each(["dependencies", "devDependencies"])(
  "reports %s and selective three-file guidance",
  async (section) => {
    await withCheckout("packages: ['.']\n", async (root) => {
      await writeManifest(root, { [section]: { openclaw: "link:." } });
      await noteSourceInstallIssues(root);
      expect(note).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("package.json has a self-referential"),
        "Install",
      );
      const message = capturedWarning();
      for (const text of [
        "git diff -- package.json pnpm-workspace.yaml pnpm-lock.yaml",
        "missing override pins",
        "preserving unrelated edits in all three files",
        "pnpm install --frozen-lockfile",
      ]) {
        expect(message).toContain(text);
      }
    });
  },
);

it.each([
  { failure: "unreadable workspace", warning: "package-lock.json present" },
  { failure: "malformed manifest", warning: "pnpm-workspace.yaml contains" },
])("continues other install checks after $failure", async ({ failure, warning }) => {
  await withCheckout("overrides: {openclaw: 'link:.'}\n", async (root) => {
    if (failure === "unreadable workspace") {
      await fs.rm(path.join(root, "pnpm-workspace.yaml"));
      await fs.mkdir(path.join(root, "pnpm-workspace.yaml"));
      await writeFile(root, "package-lock.json", "{}");
    } else {
      await writeFile(root, "package.json", "{");
    }
    await expect(noteSourceInstallIssues(root)).resolves.toBeUndefined();
    expect(note).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(warning), "Install");
  });
});

it("ignores healthy manifest values, absent roots, and packaged self-link lookalikes", async () => {
  await noteSourceInstallIssues(null);
  await withCheckout("packages: ['.']\n", async (root) => {
    await writeManifest(root, {
      dependencies: { openclaw: "^2026.9.4" },
      devDependencies: { openclaw: null },
    });
    await noteSourceInstallIssues(root);
    await fs.rm(path.join(root, "src/entry.ts"));
    await writeFile(root, "pnpm-workspace.yaml", "overrides: {openclaw: 'link:.'}\n");
    await writeManifest(root, { dependencies: { openclaw: "link:." } });
    await noteSourceInstallIssues(root);
    expect(note).not.toHaveBeenCalled();
  });
});

it.each(["link:../openclaw-fork", "link:packages/openclaw"])(
  "preserves legitimate local target %s in both dependency maps and overrides",
  async (link) => {
    await withCheckout(`overrides: {openclaw: '${link}'}\n`, async (root) => {
      await writeManifest(root, {
        dependencies: { openclaw: link },
        devDependencies: { openclaw: link },
      });
      await noteSourceInstallIssues(root);
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
      await writeManifest(root, { dependencies: { openclaw: link } });
      await noteSourceInstallIssues(root);
      const message = capturedWarning();
      for (const text of [
        "package.json has a self-referential",
        "pnpm-workspace.yaml contains a self-referential",
        "can break frozen pnpm installs",
        "If the link is unintended",
      ]) {
        expect(message).toContain(text);
      }
      expect(message).not.toContain("ERR_PNPM_LOCKFILE_CONFIG_MISMATCH");
    });
  },
);
