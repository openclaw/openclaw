import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { noteSourceInstallIssues } from "./doctor-install.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
beforeEach(() => {
  root = tempDirs.make("openclaw-doctor-install-");
  vi.mocked(note).mockReset();
});

async function writeFile(relativePath: string, content = "") {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

it("reports the host owner instead of source package repair advice", async () => {
  await writeSourceCheckout("overrides: {openclaw: 'link:.'}\n");
  await writeFile(
    "openclaw-install-owner.json",
    JSON.stringify({
      schemaVersion: 1,
      owner: "macos-app",
      displayName: "OpenClaw.app",
      updateHint: "Update OpenClaw.app to update this Gateway.",
    }),
  );
  await noteSourceInstallIssues(root);
  expect(note).toHaveBeenCalledExactlyOnceWith(
    "Managed by OpenClaw.app. Update OpenClaw.app to update this Gateway.",
    "Install",
  );
});

it("warns source checkouts when node_modules was not installed by pnpm", async () => {
  await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
  await writeFile("pnpm-workspace.yaml", "packages:\n  - .\n");
  await writeFile("src/entry.ts", "export {};\n");
  await noteSourceInstallIssues(root);
  expect(note).toHaveBeenCalledWith(
    [
      "- node_modules was not installed by pnpm (missing node_modules/.pnpm). Run: pnpm install so bundled plugins can load package-local dependencies.",
      "- tsx binary is missing for source runs. Run: pnpm install.",
    ].join("\n"),
    "Install",
  );
});

async function writeSourceCheckout(
  workspace = "packages: ['.']\n",
  manifest: unknown = { name: "openclaw" },
) {
  await writeFile("src/entry.ts", "export {};\n");
  await writeFile("node_modules/.bin/tsx");
  await fs.mkdir(path.join(root, "node_modules/.pnpm"), { recursive: true });
  await writeFile("package.json", JSON.stringify(manifest));
  await writeFile("pnpm-workspace.yaml", workspace);
}

it.each([
  ["block map", "overrides:\n  openclaw: 'link:'\n", true],
  ["scalar alias", "self: &self 'link:.'\noverrides: {openclaw: *self}\n", true],
  ["map alias", "pins: &pins {openclaw: 'link:.'}\noverrides: *pins\n", true],
  ["flow map", "overrides: { openclaw: 'link:.' }\n", true],
  ["quoted keys", '"overrides":\n  "openclaw": "link:."\n', true],
  ["commented header", "overrides: # pinned packages\n  openclaw: 'link:.'\n", true],
  ["blank line", "overrides:\n  example: 1.0.0\n\n  openclaw: 'link:.'\n", true],
  ["CRLF", "overrides:\r\n  openclaw: 'link:.'\r\n", true],
  ["non-overrides map", "catalog:\n  openclaw: 'link:.'\n", false],
  ["nested overrides value", "overrides:\n  example:\n    openclaw: 'link:.'\n", false],
  ["comment", "# overrides: {openclaw: 'link:.'}\n", false],
  ["normal override", "overrides:\n  openclaw: 2026.9.4\n", false],
  ["non-string override", "overrides:\n  openclaw: [link]\n", false],
  ["unquoted trailing colon", "overrides:\n  openclaw: link:\n", false],
  ["duplicate key", "overrides:\n  openclaw: 'link:.'\n  openclaw: 2026.9.4\n", false],
  ["malformed YAML", "overrides: [\n", false],
  [
    "excessive alias expansion",
    "a: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\noverrides: {openclaw: 'link:.'}\n",
    false,
  ],
] as const)("checks workspace self-links in %s", async (_name, workspace, selfLink) => {
  await writeSourceCheckout(workspace);
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

it.each(["dependencies", "devDependencies"])(
  "reports %s and selective three-file guidance",
  async (section) => {
    await writeSourceCheckout(undefined, { [section]: { openclaw: "link:." } });
    await noteSourceInstallIssues(root);
    expect(note).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("package.json has a self-referential"),
      "Install",
    );
    const warning = String(vi.mocked(note).mock.calls[0]?.[0]);
    expect(warning).toContain("git diff -- package.json pnpm-workspace.yaml pnpm-lock.yaml");
    expect(warning).toContain("missing override pins");
    expect(warning).toContain("preserving unrelated edits in all three files");
    expect(warning).toContain("pnpm install --frozen-lockfile");
  },
);

it.each([
  { failure: "unreadable workspace", warning: "package-lock.json present" },
  { failure: "malformed manifest", warning: "pnpm-workspace.yaml contains" },
])("continues other install checks after $failure", async ({ failure, warning }) => {
  await writeSourceCheckout("overrides: {openclaw: 'link:.'}\n");
  if (failure === "unreadable workspace") {
    await fs.rm(path.join(root, "pnpm-workspace.yaml"));
    await fs.mkdir(path.join(root, "pnpm-workspace.yaml"));
    await writeFile("package-lock.json", "{}");
  } else {
    await writeFile("package.json", "{");
  }
  await expect(noteSourceInstallIssues(root)).resolves.toBeUndefined();
  expect(note).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(warning), "Install");
});

it("ignores healthy manifest values, absent roots, and packaged self-link lookalikes", async () => {
  await noteSourceInstallIssues(null);
  await writeSourceCheckout(undefined, {
    dependencies: { openclaw: "^2026.9.4" },
    devDependencies: { openclaw: null },
  });
  await noteSourceInstallIssues(root);
  await fs.rm(path.join(root, "src/entry.ts"));
  await writeFile("pnpm-workspace.yaml", "overrides: {openclaw: 'link:.'}\n");
  await writeFile("package.json", JSON.stringify({ dependencies: { openclaw: "link:." } }));
  await noteSourceInstallIssues(root);
  expect(note).not.toHaveBeenCalled();
});

it.each(["link:../openclaw-fork", "link:packages/openclaw"])(
  "preserves legitimate local target %s in both dependency maps and overrides",
  async (link) => {
    await writeSourceCheckout(`overrides: {openclaw: '${link}'}\n`, {
      dependencies: { openclaw: link },
      devDependencies: { openclaw: link },
    });
    await noteSourceInstallIssues(root);
    expect(note).not.toHaveBeenCalled();
  },
);

it.each(["empty", "dot", "absolute", "symlink"])(
  "detects a %s link resolving to this checkout without claiming a lockfile error",
  async (kind) => {
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
    await writeSourceCheckout(`overrides: {openclaw: '${link}'}\n`, {
      dependencies: { openclaw: link },
    });
    await noteSourceInstallIssues(root);
    expect(note).toHaveBeenCalledOnce();
    const warning = String(vi.mocked(note).mock.calls[0]?.[0]);
    expect(warning).toContain("package.json has a self-referential");
    expect(warning).toContain("pnpm-workspace.yaml contains a self-referential");
    expect(warning).not.toContain("ERR_PNPM_LOCKFILE_CONFIG_MISMATCH");
    expect(warning).toContain("can break frozen pnpm installs");
    expect(warning).toContain("If the link is unintended");
  },
);
